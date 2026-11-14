/* Lynch Digitance — Auto Refresh: schedule engine
 *
 * Shared by the service worker (importScripts) and the popup (<script>), so
 * "is it active right now?" can never be answered two different ways.
 *
 * Every calculation happens in the schedule's own time zone, not the
 * computer's. A window of 3:00–5:00 in US Eastern means 3:00–5:00 Eastern
 * whatever clock the machine is set to.
 *
 * Schedule shape:
 *   { enabled, tz: 'America/New_York', days: [0..6],   // 0 = Sunday, [] = every day
 *     windows: [{ from: 180, to: 300 }, ...] }         // minutes after midnight
 *
 * A window runs [from, to). If to <= from it crosses midnight, and the part
 * after midnight belongs to the day it started on — so "Fri 22:00–02:00"
 * still runs at 01:00 on Saturday.
 */
(function (root) {
  'use strict';

  const MAX_WINDOWS = 7;
  const DEFAULT_TZ = 'America/New_York';

  const US_ZONES = [
    { id: 'America/New_York',    label: 'Eastern (New York)' },
    { id: 'America/Chicago',     label: 'Central (Chicago)' },
    { id: 'America/Denver',      label: 'Mountain (Denver)' },
    { id: 'America/Phoenix',     label: 'Arizona (no DST)' },
    { id: 'America/Los_Angeles', label: 'Pacific (Los Angeles)' },
    { id: 'America/Anchorage',   label: 'Alaska (Anchorage)' },
    { id: 'Pacific/Honolulu',    label: 'Hawaii (Honolulu)' }
  ];

  const WEEKDAY = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const fmtCache = {};

  function formatter(tz) {
    if (!fmtCache[tz]) {
      fmtCache[tz] = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit',
        second: '2-digit', hourCycle: 'h23'
      });
    }
    return fmtCache[tz];
  }

  // Must be an explicit zone name: Intl treats a missing zone as "use the
  // computer's clock", which is exactly what the schedule must never do.
  function validTz(tz) {
    if (typeof tz !== 'string' || !tz) return false;
    try { formatter(tz); return true; } catch (e) { return false; }
  }

  /* Wall-clock day and time in the given zone. */
  function zoneNow(tz, date) {
    const parts = {};
    for (const p of formatter(validTz(tz) ? tz : DEFAULT_TZ).formatToParts(date || new Date())) {
      parts[p.type] = p.value;
    }
    const h = Number(parts.hour) % 24;
    const m = Number(parts.minute);
    const s = Number(parts.second);
    return { day: WEEKDAY[parts.weekday], min: h * 60 + m, sec: s };
  }

  /* Accepts old single-window schedules (fromMin/toMin) and cleans input. */
  function normalize(s) {
    const out = { enabled: false, tz: DEFAULT_TZ, days: [], windows: [] };
    if (!s) return out;
    out.enabled = !!s.enabled;
    out.tz = validTz(s.tz) ? s.tz : DEFAULT_TZ;
    out.days = Array.isArray(s.days)
      ? [...new Set(s.days.map(Number).filter((d) => d >= 0 && d <= 6))]
      : [];
    let wins = Array.isArray(s.windows) ? s.windows : null;
    if (!wins && typeof s.fromMin === 'number' && typeof s.toMin === 'number') {
      wins = [{ from: s.fromMin, to: s.toMin }];   // pre-2.2 schedule
    }
    out.windows = (wins || [])
      .map((w) => ({ from: clampMin(w && w.from), to: clampMin(w && w.to) }))
      .slice(0, MAX_WINDOWS);
    return out;
  }

  function clampMin(v) {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? ((n % 1440) + 1440) % 1440 : 0;
  }

  /* A window whose start equals its end is ambiguous, so it never runs. */
  function usable(windows) {
    return windows.filter((w) => w.from !== w.to);
  }

  function dayOn(days, d) {
    return !days.length || days.includes(((d % 7) + 7) % 7);
  }

  /* The window covering this moment, or null. */
  function activeWindow(schedule, date) {
    const s = normalize(schedule);
    const now = zoneNow(s.tz, date);
    const wins = usable(s.windows);

    // No windows at all means "all day" on the chosen days.
    if (!wins.length) return dayOn(s.days, now.day) ? { from: 0, to: 0, allDay: true } : null;

    for (const w of wins) {
      if (w.from < w.to) {
        if (dayOn(s.days, now.day) && now.min >= w.from && now.min < w.to) return w;
      } else {
        // crosses midnight: evening part today, morning part owned by yesterday
        if (dayOn(s.days, now.day) && now.min >= w.from) return w;
        if (dayOn(s.days, now.day - 1) && now.min < w.to) return w;
      }
    }
    return null;
  }

  function isActive(schedule, date) {
    const s = normalize(schedule);
    if (!s.enabled) return true;
    return !!activeWindow(s, date);
  }

  /* Milliseconds until the next window opens (null if none can ever open). */
  function msUntilNextStart(schedule, date) {
    const s = normalize(schedule);
    const at = date || new Date();
    const now = zoneNow(s.tz, at);
    const nowExact = now.min + now.sec / 60;
    const wins = usable(s.windows);
    const starts = wins.length ? wins.map((w) => w.from) : [0];

    let best = null;
    for (let d = 0; d <= 8; d++) {
      if (!dayOn(s.days, now.day + d)) continue;
      for (const from of starts) {
        const delta = d * 1440 + from - nowExact;
        if (delta > 0 && (best === null || delta < best.delta)) best = { delta, from };
      }
    }
    if (!best) return null;

    // Wall-clock maths drifts by an hour across a DST change. Check where the
    // estimate actually lands in the zone and nudge it onto the real start.
    let ms = Math.round(best.delta * 60000);
    for (let i = 0; i < 2; i++) {
      const land = zoneNow(s.tz, new Date(at.getTime() + ms));
      let diff = best.from - land.min;
      if (diff > 720) diff -= 1440;
      if (diff < -720) diff += 1440;
      if (!diff) break;
      ms += diff * 60000;
    }
    // land on the minute boundary rather than a few seconds past it
    ms -= zoneNow(s.tz, new Date(at.getTime() + ms)).sec * 1000;
    return Math.max(1000, ms);
  }

  function fmtMin(min) {
    const v = clampMin(min);
    const h = Math.floor(v / 60);
    const m = v % 60;
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return h12 + ':' + String(m).padStart(2, '0') + ' ' + (h < 12 ? 'AM' : 'PM');
  }

  function zoneAbbr(tz, date) {
    try {
      const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' })
        .formatToParts(date || new Date())
        .find((x) => x.type === 'timeZoneName');
      return p ? p.value : '';
    } catch (e) {
      return '';
    }
  }

  const api = {
    MAX_WINDOWS, DEFAULT_TZ, US_ZONES,
    zoneNow, normalize, activeWindow, isActive, msUntilNextStart, fmtMin, zoneAbbr
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.LynchSchedule = api;
})(typeof self !== 'undefined' ? self : this);
