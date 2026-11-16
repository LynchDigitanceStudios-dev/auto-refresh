/* Lynch Digitance — Auto Refresh popup */
(function () {
  'use strict';

  const S = window.LynchSchedule;
  const $ = (id) => document.getElementById(id);
  const CIRC = 2 * Math.PI * 26;
  // the same page is the small popup and, opened with ?view=advanced, the Advanced dashboard (see mode.js)
  const ADV = document.documentElement.classList.contains('adv');
  const DEFAULT_WINDOWS = [{ from: 9 * 60, to: 17 * 60 }];

  let tab = null;
  let job = null;
  let ticker = null;
  let intervalMs = 30000;
  let windows = DEFAULT_WINDOWS.map((w) => ({ ...w }));

  const els = {
    presets: $('presets'), customVal: $('customVal'), customUnit: $('customUnit'),
    hard: $('hardRefresh'), notify: $('notifyOnChange'), sound: $('sound'),
    jitter: $('jitter'), pageTimer: $('pageTimer'),
    schedOn: $('schedOn'), sched: $('sched'), days: $('days'),
    tz: $('tz'), clock: $('clock'), wins: $('wins'), addWin: $('addWin'),
    winCount: $('winCount'), schedStatus: $('schedStatus'),
    live: $('live'), liveLabel: $('liveLabel'), pulse: $('pulse'), ring: $('ringProgress'),
    countdown: $('countdown'), count: $('count'), elapsed: $('elapsed'),
    cycleMeta: $('cycleMeta'),
    primary: $('primary'), pause: $('pause'), save: $('save'), savedMsg: $('savedMsg'),
    title: $('tabTitle'), url: $('tabUrl'),
    rangeOn: $('rangeOn'), range: $('range'), rangeMin: $('rangeMin'),
    rangeMax: $('rangeMax'), rangeHint: $('rangeHint'),
    verNum: $('verNum'), checkUpdate: $('checkUpdate'), verMsg: $('verMsg'),
    viewMain: $('viewMain'), viewAi: $('viewAi'), viewReviews: $('viewReviews'),
    rangeNote: $('rangeNote'), nameCard: $('nameCard'), sumRows: $('sumRows'), openAdvanced: $('openAdvanced'),
    advSaved: $('advSaved'), applyBar: $('applyBar'), applyText: $('applyText'), applyBtn: $('applyBtn'),
    aiLog: $('aiLog'), aiForm: $('aiForm'), aiInput: $('aiInput'),
    aiSend: $('aiSend'), aiClear: $('aiClear'),
    viewAccount: $('viewAccount'), acctForm: $('acctForm'), acctOut: $('acctOut'), acctIn: $('acctIn'),
    modeLogin: $('modeLogin'), modeSignup: $('modeSignup'), acctEmail: $('acctEmail'), acctPass: $('acctPass'),
    acctSubmit: $('acctSubmit'), acctMsg: $('acctMsg'), acctWho: $('acctWho'), acctSync: $('acctSync'),
    acctSyncNow: $('acctSyncNow'), acctLogout: $('acctLogout'), acctDelToggle: $('acctDelToggle'),
    acctDel: $('acctDel'), acctDelPass: $('acctDelPass'), acctDelGo: $('acctDelGo'),
    label: $('label'), human: $('human'), humanBlock: $('humanBlock'), humanWords: $('humanWords'), pauseOnHuman: $('pauseOnHuman'),
    humanize: $('humanize'), humanClicks: $('humanClicks'), humanActs: $('humanActs'), humanHint: $('humanHint'), updateAlerts: $('updateAlerts'), usagePing: $('usagePing'),
    tgStatus: $('tgStatus'), tgSetup: $('tgSetup'), tgDone: $('tgDone'), tgToken: $('tgToken'), tgChat: $('tgChat'),
    tgDetect: $('tgDetect'), tgSave: $('tgSave'), tgTest: $('tgTest'), tgOff: $('tgOff'), tgMsg: $('tgMsg')
  };

  els.ring.style.strokeDasharray = CIRC.toFixed(2);

  /* ---------- views ---------- */

  document.querySelectorAll('.tabs__b').forEach((b) => {
    b.addEventListener('click', () => showView(b.dataset.view));
  });

  function showView(v) {
    els.viewMain.hidden = v !== 'main';
    els.viewAi.hidden = v !== 'ai';
    els.viewAccount.hidden = v !== 'account';
    els.viewReviews.hidden = v !== 'reviews';
    if (v === 'account') accountOpened();
    if (v === 'reviews') window.LynchReviewsUI.opened();
    document.querySelectorAll('.tabs__b').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
    if (v === 'ai') {
      els.aiLog.scrollTop = els.aiLog.scrollHeight;
      els.aiInput.focus();
    }
  }

  /* ---------- interval selection ---------- */

  els.presets.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    intervalMs = Number(b.dataset.ms);
    els.customVal.value = '';
    [...els.presets.children].forEach((x) => x.classList.toggle('on', x === b));
  });

  els.customVal.addEventListener('input', readCustom);
  els.customUnit.addEventListener('change', readCustom);

  function readCustom() {
    const v = parseFloat(els.customVal.value);
    if (!v || v <= 0) return;
    intervalMs = Math.max(1000, Math.round(v * Number(els.customUnit.value)));
    [...els.presets.children].forEach((x) => x.classList.remove('on'));
  }

  /* ---------- random range ---------- */

  function syncRangeUI() {
    els.range.hidden = !els.rangeOn.checked;
    const lo = Math.max(1, parseInt(els.rangeMin.value, 10) || 0);
    const hi = Math.max(1, parseInt(els.rangeMax.value, 10) || 0);
    els.rangeHint.textContent = hi < lo
      ? 'Each refresh waits a random ' + hi + '–' + lo + 's (values swapped).'
      : 'Each refresh waits a random ' + lo + '–' + hi + 's.';
    // The fixed interval is ignored while a range is on — grey it out so that
    // is obvious rather than surprising.
    els.presets.style.opacity = els.rangeOn.checked ? '.4' : '';
    els.customVal.disabled = els.customUnit.disabled = els.rangeOn.checked;
    // the popup has no range controls any more: say plainly that a range replaces the interval
    els.rangeNote.hidden = !els.rangeOn.checked;
    els.rangeNote.textContent = 'A random range of ' + Math.min(lo, hi) + '–' + Math.max(lo, hi) + ' seconds is on, so the interval above is not used. Change it in Advanced settings.';
  }

  els.rangeOn.addEventListener('change', syncRangeUI);
  els.rangeMin.addEventListener('input', syncRangeUI);
  els.rangeMax.addEventListener('input', syncRangeUI);

  function collectRange() {
    const lo = Math.max(1, parseInt(els.rangeMin.value, 10) || 250);
    const hi = Math.max(1, parseInt(els.rangeMax.value, 10) || 300);
    return {
      enabled: els.rangeOn.checked,
      minMs: Math.min(lo, hi) * 1000,
      maxMs: Math.max(lo, hi) * 1000
    };
  }

  /* ---------- schedule: time zone + clock ---------- */

  for (const z of S.US_ZONES) {
    const o = document.createElement('option');
    o.value = z.id;
    o.textContent = z.label;
    els.tz.appendChild(o);
  }
  els.tz.value = S.DEFAULT_TZ;

  function pad(n) { return String(n).padStart(2, '0'); }

  function fmtClock(tz, date) {
    const z = S.zoneNow(tz, date);
    const h = Math.floor(z.min / 60);
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return h12 + ':' + pad(z.min % 60) + ':' + pad(z.sec) + ' ' + (h < 12 ? 'AM' : 'PM') +
      ' ' + S.zoneAbbr(tz, date);
  }

  function fmtSpan(ms) {
    const mins = Math.max(1, Math.round(ms / 60000));
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    if (h >= 24) return Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
    return h ? h + 'h ' + m + 'm' : m + 'm';
  }

  /* Wall-clock time in the zone, `ms` from now — used for "opens at 7:00 AM". */
  function zoneTimeIn(tz, ms) {
    return S.fmtMin(S.zoneNow(tz, new Date(Date.now() + ms)).min);
  }

  /* ---------- schedule: windows ---------- */

  function toMin(v) {
    const [h, m] = (v || '0:00').split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  }

  function toTimeStr(min) {
    const v = ((min % 1440) + 1440) % 1440;
    return pad(Math.floor(v / 60)) + ':' + pad(v % 60);
  }

  function renderWins() {
    els.wins.textContent = '';
    windows.forEach((w, i) => {
      const row = document.createElement('div');
      row.className = 'win' + (w.from === w.to ? ' win--bad' : '');
      if (w.from === w.to) row.title = 'Start and end are the same, so this window is ignored.';

      const num = document.createElement('span');
      num.className = 'win__n';
      num.textContent = i + 1;

      const from = document.createElement('input');
      from.type = 'time';
      from.value = toTimeStr(w.from);
      from.setAttribute('aria-label', 'Window ' + (i + 1) + ' start');

      const sep = document.createElement('span');
      sep.className = 'win__to';
      sep.textContent = 'to';

      const to = document.createElement('input');
      to.type = 'time';
      to.value = toTimeStr(w.to);
      to.setAttribute('aria-label', 'Window ' + (i + 1) + ' end');

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'win__del';
      del.textContent = '×';
      del.title = 'Remove this window';

      const onChange = () => {
        windows[i] = { from: toMin(from.value), to: toMin(to.value) };
        row.classList.toggle('win--bad', windows[i].from === windows[i].to);
        paintSchedule();
        saveDraft();
      };
      from.addEventListener('change', onChange);
      to.addEventListener('change', onChange);
      del.addEventListener('click', () => {
        windows.splice(i, 1);
        renderWins();
        paintSchedule();
        saveDraft();
      });

      row.append(num, from, sep, to, del);
      els.wins.appendChild(row);
    });

    els.winCount.textContent = windows.length + ' of ' + S.MAX_WINDOWS;
    els.addWin.disabled = windows.length >= S.MAX_WINDOWS;
  }

  els.addWin.addEventListener('click', () => {
    if (windows.length >= S.MAX_WINDOWS) return;
    // Start the new window where the last one ends, one hour long.
    const last = windows[windows.length - 1];
    const from = last ? last.to : 9 * 60;
    windows.push({ from, to: (from + 60) % 1440 });
    renderWins();
    paintSchedule();
    saveDraft();
  });

  els.schedOn.addEventListener('change', () => {
    els.sched.hidden = !els.schedOn.checked;
    paintSchedule();
  });
  els.days.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    b.classList.toggle('on');
    paintSchedule();
  });
  els.tz.addEventListener('change', paintSchedule);

  function collectSchedule() {
    return {
      enabled: els.schedOn.checked,
      tz: els.tz.value,
      days: [...els.days.querySelectorAll('button.on')].map((b) => Number(b.dataset.d)),
      windows: windows.map((w) => ({ from: w.from, to: w.to }))
    };
  }

  /* Live clock + "active now / opens at" line, repainted every second. */
  function paintSchedule() {
    const tz = els.tz.value;
    els.clock.textContent = fmtClock(tz, new Date());
    if (!els.schedOn.checked) return;

    const sch = collectSchedule();
    const active = S.activeWindow(sch, new Date());
    const st = els.schedStatus;
    if (active) {
      st.className = 'schedStatus schedStatus--on';
      st.textContent = active.allDay
        ? 'Active now · all day'
        : 'Active now · until ' + S.fmtMin(active.to);
    } else {
      const ms = S.msUntilNextStart(sch, new Date());
      st.className = 'schedStatus schedStatus--off';
      st.textContent = ms === null
        ? 'No window can open. Check the times.'
        : 'Paused · next window ' + zoneTimeIn(tz, ms) + ' (in ' + fmtSpan(ms) + ')';
    }
    if (windows.some((w) => w.from === w.to)) {
      st.textContent += ' · a window with the same start and end is ignored';
    }
  }

  /* ---------- collect / apply ---------- */

  function collect() {
    return {
      intervalMs,
      hardRefresh: els.hard.checked,
      notifyOnChange: els.notify.checked,
      sound: els.sound.checked,
      jitter: els.jitter.checked,
      pageTimer: els.pageTimer.checked,
      label: els.label.value.trim().slice(0, 40),
      humanBlock: els.humanBlock.checked,
      humanWords: parseWords(els.humanWords.value),
      pauseOnHuman: els.pauseOnHuman.checked,
      humanize: els.humanize.checked,
      humanClicks: els.humanClicks.checked,
      range: collectRange(),
      // Always carry the schedule so windows survive toggling it off;
      // background.js only enforces it when enabled is true.
      schedule: collectSchedule()
    };
  }

  function applyDefaults(d) {
    if (!d) { renderWins(); return; }
    if (d.intervalMs) {
      intervalMs = d.intervalMs;
      const match = [...els.presets.children].find((b) => Number(b.dataset.ms) === d.intervalMs);
      [...els.presets.children].forEach((b) => b.classList.toggle('on', b === match));
      if (!match) {
        els.customVal.value = Math.round(d.intervalMs / 1000);
        els.customUnit.value = '1000';
      }
    }
    els.hard.checked = !!d.hardRefresh;
    els.notify.checked = !!d.notifyOnChange;
    els.sound.checked = !!d.sound;
    els.jitter.checked = !!d.jitter;
    els.pageTimer.checked = !!d.pageTimer;
    // the account name is per computer and never synced, so only overwrite it when the settings carry one
    if (typeof d.label === 'string') els.label.value = d.label;
    els.humanBlock.checked = d.humanBlock !== false;
    els.humanWords.value = Array.isArray(d.humanWords) ? d.humanWords.join(', ') : '';
    els.pauseOnHuman.checked = d.pauseOnHuman !== false;
    els.humanize.checked = !!d.humanize;
    els.humanClicks.checked = d.humanClicks !== false;
    syncHumanUI();
    if (d.range) {
      els.rangeOn.checked = !!d.range.enabled;
      if (d.range.minMs) els.rangeMin.value = Math.round(d.range.minMs / 1000);
      if (d.range.maxMs) els.rangeMax.value = Math.round(d.range.maxMs / 1000);
    }
    syncRangeUI();
    if (d.schedule) {
      // normalize() also upgrades a pre-2.2 single from/to schedule.
      const s = S.normalize(d.schedule);
      els.schedOn.checked = s.enabled;
      els.sched.hidden = !s.enabled;
      els.tz.value = s.tz;
      els.days.querySelectorAll('button').forEach((b) => {
        b.classList.toggle('on', s.days.includes(Number(b.dataset.d)));
      });
      windows = s.windows;
    }
    renderWins();
    paintSchedule();
    renderSummary();
  }

  /* Persist on every change, so settings survive closing the popup even if
     auto refresh was never started. */
  let saveTimer = null;
  function saveDraft() {
    clearTimeout(saveTimer);
    renderSummary();
    saveTimer = setTimeout(() => {
      chrome.storage.local.set({ defaults: collect() }).then(() => { notifyEdited(); flashSaved(); refreshApplyBar(); });
    }, 150);
  }

  // The Telegram token/chat fields live inside this view but are not settings: typing
  // in them must not save or sync anything.
  const editedSettings = (e) => { if (!e.target.closest('#tg, #privacyCard')) saveDraft(); };
  els.viewMain.addEventListener('change', editedSettings);
  els.viewMain.addEventListener('input', editedSettings);

  // The account name reaches a tab that is already refreshing as soon as it is typed:
  // alerts must never go out under a stale name just because Save settings was not pressed.
  let labelTimer = null;
  els.label.addEventListener('input', () => {
    clearTimeout(labelTimer);
    labelTimer = setTimeout(() => {
      if (job && tab) chrome.runtime.sendMessage({ type: 'label', tabId: tab.id, label: els.label.value.trim().slice(0, 40) });
    }, 300);
  });
  els.presets.addEventListener('click', saveDraft);
  els.days.addEventListener('click', saveDraft);

  /* ---------- rendering ---------- */

  function fmtElapsed(ms) {
    const m = Math.floor(ms / 60000);
    return m >= 60 ? Math.floor(m / 60) + 'h ' + (m % 60) + 'm' : m + 'm';
  }

  /* While a tab waits for a human the background may resume it by itself, and a paused popup
     has no ticker, so look every few seconds and show it carrying on. */
  let pausedPoll = null;
  function syncPausedPoll() {
    const need = !!(job && job.paused && job.humanReason);
    if (need && !pausedPoll) {
      pausedPoll = setInterval(async () => {
        const res = await chrome.runtime.sendMessage({ type: 'status', tabId: tab.id });
        job = res && res.job ? res.job : null;
        render();
      }, 3000);
    } else if (!need && pausedPoll) {
      clearInterval(pausedPoll);
      pausedPoll = null;
    }
  }

  function render() {
    syncPausedPoll();
    const running = !!job;
    els.live.hidden = !running;
    els.pause.hidden = !running;
    els.primary.textContent = running ? 'Stop auto refresh' : 'Start auto refresh';
    els.primary.className = running ? 'btn btn--ghost' : 'btn btn--gold';

    if (!running) { stopTicker(); return; }

    els.pause.textContent = job.paused ? 'Resume' : 'Pause';
    paintLive();
    tick();
    job.paused ? stopTicker() : startTicker();
  }

  function paintLive() {
    if (!job) return;
    const sleeping = !!job.sleeping && !job.paused;
    els.liveLabel.textContent = job.paused
      ? (job.humanReason ? 'Needs you: ' + job.humanReason : 'Paused')
      : sleeping ? 'Waiting for the next window' : 'Refreshing this tab';
    els.pulse.classList.toggle('pulse--sleep', sleeping || !!job.paused);
    els.humanHint.hidden = !(job.paused && job.humanReason);
    els.count.textContent = job.count || 0;
    els.elapsed.textContent = fmtElapsed(Date.now() - (job.startedAt || Date.now()));

    // One extra line: when the next window opens, or the length of this wait.
    const meta = els.cycleMeta;
    if (sleeping && job.wakeAt) {
      const tz = (job.schedule && job.schedule.tz) || els.tz.value;
      meta.hidden = false;
      meta.textContent = 'opens at ' + zoneTimeIn(tz, job.wakeAt - Date.now()) + ' ' +
        S.zoneAbbr(tz, new Date(job.wakeAt));
    } else if (job.range && job.range.enabled && job.cycleMs) {
      meta.hidden = false;
      meta.textContent = 'this wait: ' + Math.round(job.cycleMs / 1000) + 's of ' +
        Math.round(job.range.minMs / 1000) + '–' + Math.round(job.range.maxMs / 1000) + 's';
    } else {
      meta.hidden = true;
    }
  }

  function tick() {
    if (!job) return;
    // Measure against whatever was actually armed: a rolled random wait, or
    // the sleep until the next window opens.
    const total = job.armedMs || job.cycleMs || job.intervalMs;
    const left = job.paused
      ? (job.remainingMs || 0)
      : Math.max(0, (job.nextAt || Date.now()) - Date.now());
    // Always count in whole seconds, however long the wait is.
    els.countdown.textContent = Math.ceil(left / 1000);
    els.ring.style.strokeDashoffset = (CIRC * (1 - Math.min(1, left / total))).toFixed(2);
  }

  function startTicker() { if (!ticker) ticker = setInterval(refreshStatus, 500); }
  function stopTicker() { if (ticker) { clearInterval(ticker); ticker = null; } }

  async function refreshStatus() {
    const res = await chrome.runtime.sendMessage({ type: 'status', tabId: tab.id });
    const wasRunning = !!job;
    job = res && res.job ? res.job : null;
    if (!job && wasRunning) return render();
    if (job) {
      paintLive();
      tick();
    }
  }

  /* ---------- actions ---------- */

  els.primary.addEventListener('click', async () => {
    if (job) {
      await chrome.runtime.sendMessage({ type: 'stop', tabId: tab.id });
      job = null;
    } else {
      job = await chrome.runtime.sendMessage({ type: 'start', tabId: tab.id, opts: collect() });
    }
    render();
  });

  els.save.addEventListener('click', async () => {
    clearTimeout(saveTimer);
    const opts = collect();
    await chrome.storage.local.set({ defaults: opts });
    notifyEdited();

    // If a job is already running, apply the new settings to it right away
    // instead of making the user stop and start again.
    if (job) job = await chrome.runtime.sendMessage({ type: 'start', tabId: tab.id, opts });

    els.savedMsg.textContent = job ? 'Settings saved & applied' : 'Settings saved';
    els.savedMsg.hidden = false;
    clearTimeout(els.save._t);
    els.save._t = setTimeout(() => { els.savedMsg.hidden = true; }, 2000);
    render();
  });

  els.pause.addEventListener('click', async () => {
    if (!job) return;
    job = await chrome.runtime.sendMessage({ type: 'pause', tabId: tab.id, paused: !job.paused });
    render();
  });

  /* ---------- update check ---------- */

  // Only ever runs when the user clicks the button. Nothing is sent about
  // them or their tabs — it is a plain GET of a small public JSON file.
  const VERSION_URL = 'https://autorefresh.lynchdigitancestudios.workers.dev/version.json';

  function cmpVer(a, b) {
    const A = String(a).split('.').map(Number);
    const B = String(b).split('.').map(Number);
    for (let i = 0; i < Math.max(A.length, B.length); i++) {
      const d = (A[i] || 0) - (B[i] || 0);
      if (d) return d > 0 ? 1 : -1;
    }
    return 0;
  }

  /* Built from DOM nodes, never innerHTML: the text comes over the network. */
  function showVerMsg(parts, cls) {
    els.verMsg.className = 'verMsg' + (cls ? ' verMsg--' + cls : '');
    els.verMsg.textContent = '';
    for (const p of parts) {
      if (typeof p === 'string') { els.verMsg.append(p); continue; }
      const node = document.createElement(p.tag);
      node.textContent = p.text;
      if (p.href) { node.href = p.href; node.target = '_blank'; node.rel = 'noopener'; }
      els.verMsg.append(node);
    }
    els.verMsg.hidden = false;
  }

  els.checkUpdate.addEventListener('click', async () => {
    const mine = chrome.runtime.getManifest().version;
    els.checkUpdate.disabled = true;
    els.checkUpdate.textContent = 'Checking…';
    try {
      const res = await fetch(VERSION_URL + '?t=' + Date.now(), { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      if (cmpVer(data.version, mine) > 0) {
        const url = /^https:\/\//.test(data.downloadUrl || '')
          ? data.downloadUrl
          : VERSION_URL.replace(/version\.json$/, '');
        showVerMsg([
          'Version ', { tag: 'strong', text: String(data.version) }, ' is out. ',
          { tag: 'a', text: 'Download', href: url },
          ', unzip over your folder, then reload the extension.'
        ], 'new');
      } else {
        showVerMsg(['You are on the latest version (' + mine + ').'], 'ok');
      }
    } catch (e) {
      showVerMsg(['Could not check right now. Try again later.'], 'err');
    }
    els.checkUpdate.disabled = false;
    els.checkUpdate.textContent = 'Check for updates';
  });

  /* ---------- Lynch AI: applying settings changes ---------- */

  // A single fenced block, always the tail of the reply. Everything from its
  // opening backticks onward is hidden from the chat, streamed or not, so raw
  // JSON never flashes on screen even if the model never closes the fence.
  const ACTION_FENCE = /```lynch-action\s*([\s\S]*?)```/i;
  const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
  const DAY_KEY = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  const DAY_NAME = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const OPTION_ELS = { hardRefresh: els.hard, notifyOnChange: els.notify, sound: els.sound, jitter: els.jitter, pageTimer: els.pageTimer, humanBlock: els.humanBlock, pauseOnHuman: els.pauseOnHuman, humanize: els.humanize, humanClicks: els.humanClicks };
  const OPTION_LABEL = { hardRefresh: 'Hard refresh', notifyOnChange: 'Needs-a-human alerts', sound: 'Chime', jitter: 'Random ±10% jitter', pageTimer: 'On-page countdown', humanBlock: 'Blocked / human-check alerts', pauseOnHuman: 'Pause when a human is needed', humanize: 'Act human on the page', humanClicks: 'Gentle clicks on empty space' };
  const CONTROL_TYPES = ['start', 'stop', 'pause', 'resume'];

  // Hides from the first ``` onward — including a marker still mid-arrival —
  // so a chunk boundary can never leave a stray "```" or "```lynch-ac"
  // fragment on screen for even one frame. The prompt reserves fences
  // exclusively for the action block, always as the last thing in a reply,
  // so treating any triple-backtick this way is safe for this assistant.
  function stripActionFence(text) {
    const at = text.indexOf('```');
    if (at !== -1) return text.slice(0, at).trimEnd();
    const tail = text.match(/`{1,2}$/);
    return tail ? text.slice(0, -tail[0].length).trimEnd() : text;
  }

  function parseActions(fullText) {
    const m = fullText.match(ACTION_FENCE);
    if (!m) return [];
    try {
      const data = JSON.parse(m[1]);
      return Array.isArray(data) ? data : [data];
    } catch (e) {
      return [];
    }
  }

  /* Mutates local state via the same setters the UI itself uses, then reports
     what it did in a fixed-vocabulary sentence — never the model's own words,
     so nothing unvalidated reaches the page. Unknown or malformed actions are
     ignored rather than thrown, so one bad entry doesn't block the rest. */
  function applyOneAction(a, flags) {
    if (!a || typeof a !== 'object' || typeof a.type !== 'string') return null;

    switch (a.type) {
      case 'add_window': {
        if (!TIME_RE.test(a.from) || !TIME_RE.test(a.to)) return null;
        if (windows.length >= S.MAX_WINDOWS) return 'Already at 7 time windows, the most allowed — remove one first.';
        windows.push({ from: toMin(a.from), to: toMin(a.to) });
        flags.windows = true;
        return 'Added a window ' + S.fmtMin(toMin(a.from)) + '–' + S.fmtMin(toMin(a.to)) + '.';
      }
      case 'remove_window': {
        let idx = -1;
        if (Number.isInteger(a.index)) idx = a.index - 1;
        else if (TIME_RE.test(a.from) && TIME_RE.test(a.to)) {
          idx = windows.findIndex((w) => w.from === toMin(a.from) && w.to === toMin(a.to));
        }
        if (idx < 0 || idx >= windows.length) return null;
        const w = windows[idx];
        windows.splice(idx, 1);
        flags.windows = true;
        return 'Removed the window ' + S.fmtMin(w.from) + '–' + S.fmtMin(w.to) + '.';
      }
      case 'set_windows': {
        if (!Array.isArray(a.windows)) return null;
        const clean = a.windows
          .filter((w) => w && TIME_RE.test(w.from) && TIME_RE.test(w.to))
          .slice(0, S.MAX_WINDOWS)
          .map((w) => ({ from: toMin(w.from), to: toMin(w.to) }));
        if (!clean.length) return null;
        windows = clean;
        flags.windows = true;
        return 'Set your time windows to ' + clean.map((w) => S.fmtMin(w.from) + '–' + S.fmtMin(w.to)).join(', ') + '.';
      }
      case 'clear_windows': {
        if (!windows.length) return null;
        windows = [];
        flags.windows = true;
        return 'Cleared all time windows (now refreshes all day on the chosen days).';
      }
      case 'set_schedule_enabled': {
        if (typeof a.enabled !== 'boolean') return null;
        els.schedOn.checked = a.enabled;
        els.sched.hidden = !a.enabled;
        flags.schedule = true;
        return a.enabled ? 'Turned on "Only during set hours".' : 'Turned off "Only during set hours" (refreshes around the clock).';
      }
      case 'set_days': {
        if (!Array.isArray(a.days)) return null;
        const nums = new Set();
        for (const d of a.days) {
          const key = String(d).slice(0, 3).toLowerCase();
          if (key in DAY_KEY) nums.add(DAY_KEY[key]);
        }
        els.days.querySelectorAll('button').forEach((b) => b.classList.toggle('on', nums.has(Number(b.dataset.d))));
        flags.schedule = true;
        return nums.size
          ? 'Set the days to ' + [...nums].sort().map((n) => DAY_NAME[n]).join(', ') + '.'
          : 'Set the days to every day.';
      }
      case 'set_timezone': {
        if (!S.US_ZONES.some((z) => z.id === a.tz)) return null;
        els.tz.value = a.tz;
        flags.schedule = true;
        return 'Set the time zone to ' + S.US_ZONES.find((z) => z.id === a.tz).label + '.';
      }
      case 'set_interval': {
        const secs = Number(a.seconds);
        if (!Number.isFinite(secs) || secs < 1) return null;
        intervalMs = Math.max(1000, Math.round(secs * 1000));
        els.rangeOn.checked = false;
        const match = [...els.presets.children].find((b) => Number(b.dataset.ms) === intervalMs);
        [...els.presets.children].forEach((b) => b.classList.toggle('on', b === match));
        if (match) { els.customVal.value = ''; }
        else { els.customVal.value = String(secs); els.customUnit.value = '1000'; }
        syncRangeUI();
        flags.other = true;
        return 'Set the refresh interval to every ' + secs + ' seconds.';
      }
      case 'set_range': {
        if (typeof a.enabled !== 'boolean') return null;
        els.rangeOn.checked = a.enabled;
        if (a.enabled) {
          const lo = Number(a.minSeconds), hi = Number(a.maxSeconds);
          if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo < 1 || hi < 1) return null;
          els.rangeMin.value = String(Math.round(Math.min(lo, hi)));
          els.rangeMax.value = String(Math.round(Math.max(lo, hi)));
        }
        syncRangeUI();
        flags.other = true;
        return a.enabled
          ? 'Set a random range of ' + els.rangeMin.value + '–' + els.rangeMax.value + ' seconds.'
          : 'Turned off the random range.';
      }
      case 'set_option': {
        if (!(a.name in OPTION_ELS) || typeof a.value !== 'boolean') return null;
        OPTION_ELS[a.name].checked = a.value;
        syncHumanUI();
        flags.other = true;
        return (a.value ? 'Turned on ' : 'Turned off ') + OPTION_LABEL[a.name] + '.';
      }
      case 'set_label': {
        if (typeof a.label !== 'string') return null;
        const label = a.label.trim().slice(0, 40);
        els.label.value = label;
        flags.other = true;
        return label ? 'Set the account name to \u201C' + label + '\u201D.' : 'Cleared the account name.';
      }
      case 'set_human_words': {
        if (!Array.isArray(a.words)) return null;
        const words = parseWords(a.words.filter((w) => typeof w === 'string').join(','));
        els.humanWords.value = words.join(', ');
        flags.other = true;
        return words.length ? 'Watching for: ' + words.join(', ') + '.' : 'Cleared the words to watch for.';
      }
      default:
        return null; // start/stop/pause/resume are handled after the loop
    }
  }

  /* Applies every action in order, then — if a tab is already refreshing and
     no start/stop/pause was requested this turn — pushes the new settings to
     it live, the same as pressing Save. Returns the confirmation lines. */
  async function applyAiActions(actions) {
    const flags = {};
    const summaries = [];
    for (const a of actions.slice(0, 12)) {
      const s = applyOneAction(a, flags);
      if (s) summaries.push(s);
    }
    if (flags.windows || flags.schedule) { renderWins(); paintSchedule(); }
    if (flags.windows || flags.schedule || flags.other) saveDraft();

    const control = actions.map((a) => a && a.type).reverse().find((t) => CONTROL_TYPES.includes(t));
    if (control === 'start' && !job) {
      job = await chrome.runtime.sendMessage({ type: 'start', tabId: tab.id, opts: collect() });
      summaries.push('Started auto refresh on this tab.');
      render();
    } else if (control === 'stop' && job) {
      await chrome.runtime.sendMessage({ type: 'stop', tabId: tab.id });
      job = null;
      summaries.push('Stopped auto refresh on this tab.');
      render();
    } else if (control === 'pause' && job && !job.paused) {
      job = await chrome.runtime.sendMessage({ type: 'pause', tabId: tab.id, paused: true });
      summaries.push('Paused this tab.');
      render();
    } else if (control === 'resume' && job && job.paused) {
      job = await chrome.runtime.sendMessage({ type: 'pause', tabId: tab.id, paused: false });
      summaries.push('Resumed this tab.');
      render();
    } else if ((flags.windows || flags.schedule || flags.other) && job) {
      clearTimeout(saveTimer);
      const opts = collect();
      await chrome.storage.local.set({ defaults: opts });
      job = await chrome.runtime.sendMessage({ type: 'start', tabId: tab.id, opts });
      render();
    }
    return summaries;
  }

  /* ---------- Lynch AI ---------- */

  const AI_URL = 'https://autorefresh-ai.lynchdigitancestudios.workers.dev/chat';
  const AI_KEEP = 30; // messages kept in the session
  const AI_SEND = 16; // messages sent per request (the worker's own cap)
  const AI_TIMEOUT_MS = 30000;
  const SUGGESTIONS = [
    'How do time windows work?',
    'Why did my tab stop refreshing?',
    'Set it up for 3am to 5am and 7am to 12pm'
  ];

  let aiHistory = [];
  let aiBusy = false;

  function aiBubble(role, text) {
    const b = document.createElement('div');
    b.className = 'ai__msg ai__msg--' + role;
    b.textContent = text; // textContent only: replies are never parsed as HTML
    els.aiLog.appendChild(b);
    els.aiLog.scrollTop = els.aiLog.scrollHeight;
    return b;
  }

  /* Fixed-vocabulary confirmation lines only — never raw model text. */
  function aiApplied(lines) {
    const box = document.createElement('div');
    box.className = 'ai__applied';
    for (const line of lines) {
      const row = document.createElement('div');
      row.textContent = '✓ ' + line;
      box.appendChild(row);
    }
    els.aiLog.appendChild(box);
    els.aiLog.scrollTop = els.aiLog.scrollHeight;
  }

  function renderAi() {
    els.aiLog.textContent = '';
    if (!aiHistory.length) {
      aiBubble('bot', "Hi, I'm Lynch AI. Tell me what to set up — like your time windows — " +
        "and I'll make the change myself, or ask me anything about how this works.");
      const chips = document.createElement('div');
      chips.className = 'ai__chips';
      for (const s of SUGGESTIONS) {
        const c = document.createElement('button');
        c.type = 'button';
        c.className = 'ai__chip';
        c.textContent = s;
        c.addEventListener('click', () => aiSend(s));
        chips.appendChild(c);
      }
      els.aiLog.appendChild(chips);
      return;
    }
    for (const m of aiHistory) aiBubble(m.role === 'user' ? 'user' : 'bot', m.content);
  }

  function saveAi() {
    chrome.storage.session.set({ aiHistory: aiHistory.slice(-AI_KEEP) });
  }

  /* A plain-text picture of the user's setup. Deliberately excludes the page
     address and title — the assistant never needs to know what they watch. */
  function buildContext() {
    const s = collectSchedule();
    const r = collectRange();
    const tz = s.tz;
    const zone = S.US_ZONES.find((z) => z.id === tz);
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const now = S.zoneNow(tz, new Date());
    const lines = [];

    lines.push('Extension version: ' + chrome.runtime.getManifest().version);
    lines.push('Account sync: ' + (acct.signedIn ? 'signed in (settings sync across computers)' : 'not signed in (login is optional)'));
    lines.push('Time zone: ' + (zone ? zone.label : tz) + ' (' + S.zoneAbbr(tz, new Date()) + ')' +
      '. Current time there: ' + dayNames[now.day] + ' ' + S.fmtMin(now.min));
    lines.push('Refresh timing: ' + (r.enabled
      ? 'random range ' + r.minMs / 1000 + ' to ' + r.maxMs / 1000 + ' seconds'
      : 'every ' + Math.round(intervalMs / 1000) + ' seconds' + (els.jitter.checked ? ' with ±10% jitter' : '')));
    lines.push('Options: hard refresh ' + (els.hard.checked ? 'on' : 'off') +
      ', change alerts ' + (els.notify.checked ? 'on' : 'off') +
      ', chime ' + (els.sound.checked ? 'on' : 'off') +
      ', on-page countdown ' + (els.pageTimer.checked ? 'on' : 'off') +
      ', act human on the page ' + (els.humanize.checked ? 'on (' + (els.humanClicks.checked ? 'with gentle clicks' : 'no clicks') + ')' : 'off'));
    // counts only: the account name and the words stay on this computer
    lines.push('Needs-a-human alerts: ' + (els.notify.checked
      ? 'on, account name ' + (els.label.value.trim() ? 'set' : 'not set (the last page title or the site name is used)') +
        ', blocked/human-check ' + (els.humanBlock.checked ? 'on' : 'off') +
        ', ' + parseWords(els.humanWords.value).length + ' word(s) watched' +
        ', pauses the tab: ' + (els.pauseOnHuman.checked ? 'yes' : 'no')
      : 'off') + '. Telegram: ' + (els.tgStatus.classList.contains('tg__status--on') ? 'connected' : 'not connected'));

    if (s.enabled) {
      lines.push('Only during set hours: ON');
      lines.push('Days: ' + (s.days.length ? s.days.sort().map((d) => dayNames[d]).join(', ') : 'every day'));
      lines.push('Time windows: ' + (s.windows.length
        ? s.windows.map((w, i) => (i + 1) + ') ' + S.fmtMin(w.from) + ' to ' + S.fmtMin(w.to) +
            (w.from === w.to ? ' (ignored, same start and end)' : '')).join('; ')
        : 'none (so all day on the chosen days)'));
      const active = S.activeWindow(s, new Date());
      if (active) {
        lines.push('Schedule right now: inside a window' +
          (active.allDay ? ' (all day)' : ', ends at ' + S.fmtMin(active.to)));
      } else {
        const ms = S.msUntilNextStart(s, new Date());
        lines.push('Schedule right now: outside every window' +
          (ms === null ? '' : ', next window opens at ' + zoneTimeIn(tz, ms) + ' (in ' + fmtSpan(ms) + ')'));
      }
    } else {
      lines.push('Only during set hours: OFF (refreshes around the clock)');
    }

    if (!tab) lines.push('This tab: unknown');
    else if (!job) lines.push('This tab: auto refresh is not running');
    else if (job.paused) lines.push('This tab: paused by the user');
    else if (job.sleeping) lines.push('This tab: running, waiting for the next window');
    else lines.push('This tab: refreshing, ' + (job.count || 0) + ' refreshes so far');

    return lines.join('\n');
  }

  async function aiSend(text) {
    text = (text || '').trim();
    if (!text || aiBusy) return;
    // A Telegram bot token is a password. Never let one leave the popup inside a chat message.
    if (/\b\d{6,12}:[A-Za-z0-9_-]{30,60}\b/.test(text)) {
      els.aiInput.value = '';
      aiBubble('bot', "That looks like a Telegram bot token, so I didn't send it. Please don't paste secrets into this chat. Paste it into the Telegram box in Advanced settings instead.");
      return;
    }
    aiBusy = true;
    els.aiSend.disabled = true;
    els.aiInput.value = '';

    if (!aiHistory.length) els.aiLog.textContent = ''; // drop the welcome + chips
    aiHistory.push({ role: 'user', content: text.slice(0, 1500) });
    aiBubble('user', text);
    const reply = aiBubble('bot', '…');
    reply.classList.add('ai__msg--typing');

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), AI_TIMEOUT_MS);
    try {
      const res = await fetch(AI_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: aiHistory.slice(-AI_SEND), context: buildContext() }),
        signal: ctrl.signal
      });

      if (!res.ok) {
        let msg = 'The assistant hit a problem. Please try again in a moment.';
        try { const j = await res.json(); if (j && j.error) msg = j.error; } catch (e) {}
        throw new Error(msg);
      }

      // Read as a stream so a streamed reply appears as it arrives.
      let out = '';
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      reply.classList.remove('ai__msg--typing');
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        out += dec.decode(value, { stream: true });
        // Hide a settings-change block the instant it starts, so raw JSON
        // never flashes on screen even mid-stream.
        reply.textContent = stripActionFence(out);
        els.aiLog.scrollTop = els.aiLog.scrollHeight;
      }
      out = out.trim();
      const visible = stripActionFence(out) || 'Sorry, I could not come up with an answer. Try rephrasing.';
      reply.textContent = visible;
      aiHistory.push({ role: 'assistant', content: visible }); // never the raw fence
      saveAi();

      const actions = parseActions(out);
      if (actions.length) {
        const applied = await applyAiActions(actions);
        if (applied.length) aiApplied(applied);
        else aiApplied(["Couldn't apply that automatically — try the fields above."]);
      }
    } catch (e) {
      // Take the failed question back out so a retry isn't sent twice.
      aiHistory.pop();
      reply.classList.remove('ai__msg--typing');
      reply.classList.add('ai__msg--err');
      reply.textContent = e.name === 'AbortError'
        ? 'That took too long. Check your connection and try again.'
        : (e.message || 'Could not reach the assistant. Check your connection and try again.');
      els.aiInput.value = text;
    } finally {
      clearTimeout(timer);
      aiBusy = false;
      els.aiSend.disabled = false;
      els.aiInput.focus();
    }
  }

  els.aiForm.addEventListener('submit', (e) => {
    e.preventDefault();
    aiSend(els.aiInput.value);
  });
  els.aiInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      aiSend(els.aiInput.value);
    }
  });
  els.aiClear.addEventListener('click', () => {
    aiHistory = [];
    saveAi();
    renderAi();
  });

  /* ---------- needs a human touch + Telegram ---------- */

  function parseWords(text) {
    const seen = new Set();
    const out = [];
    for (const raw of String(text || '').split(/[,\n]/)) {
      const w = raw.trim().slice(0, 60);
      if (w && !seen.has(w.toLowerCase())) { seen.add(w.toLowerCase()); out.push(w); }
      if (out.length >= 10) break;
    }
    return out;
  }

  function syncHumanUI() {
    els.human.hidden = !els.notify.checked;
    els.humanActs.hidden = !els.humanize.checked;
    els.nameCard.hidden = !els.notify.checked; // the account name only matters when alerts are on
    renderSummary();
  }

  /* ---------- the popup's short summary of what is set in Advanced ---------- */

  function sumRow(label, text) {
    const row = document.createElement('div');
    row.className = 'sumrow';
    const b = document.createElement('b');
    b.textContent = label;
    const s = document.createElement('span');
    s.textContent = text;
    row.append(b, s);
    return row;
  }

  function renderSummary() {
    if (!els.sumRows) return;
    const rows = [];

    if (els.schedOn.checked) {
      const days = [...els.days.querySelectorAll('button.on')].map((b) => Number(b.dataset.d)).sort();
      const dayTxt = days.length && days.length < 7 ? days.map((d) => DAY_NAME[d]).join(', ') + ' · ' : '';
      const win = windows.length ? windows.map((w) => S.fmtMin(w.from) + '–' + S.fmtMin(w.to)).join(', ') : 'all day';
      rows.push(['Hours', dayTxt + win + ' ' + S.zoneAbbr(els.tz.value, new Date())]);
    } else {
      rows.push(['Hours', 'All day, every day']);
    }

    const timing = [];
    if (els.rangeOn.checked) {
      const r = collectRange();
      timing.push('random ' + r.minMs / 1000 + '–' + r.maxMs / 1000 + ' s');
    } else if (els.jitter.checked) {
      timing.push('±10% jitter');
    }
    if (els.hard.checked) timing.push('hard refresh');
    if (timing.length) rows.push(['Timing', timing.join(' · ')]);

    const tg = els.tgStatus.classList.contains('tg__status--on');
    rows.push(['Alerts', els.notify.checked ? 'On · Telegram ' + (tg ? 'connected' : 'not connected') : 'Off']);
    if (els.humanize.checked) rows.push(['On page', 'Acts human after each refresh']);

    els.sumRows.textContent = '';
    rows.forEach((r) => els.sumRows.appendChild(sumRow(r[0], r[1])));
  }

  /* ---------- Advanced dashboard ---------- */

  // The popup opens (or brings forward) the dashboard in its own browser tab.
  els.openAdvanced.addEventListener('click', async () => {
    const base = chrome.runtime.getURL('popup.html');
    const all = await chrome.tabs.query({});
    const open = all.find((t) => (t.url || '').startsWith(base) && /[?&]view=advanced/.test(t.url));
    if (open) {
      await chrome.tabs.update(open.id, { active: true });
      await chrome.windows.update(open.windowId, { focused: true });
    } else {
      await chrome.tabs.create({ url: base + '?view=advanced' });
    }
    window.close();
  });

  // Settings made here are saved for every tab started from now on. Tabs that are already running keep
  // the settings they started with until this is pressed.
  let applyTimer = null;
  async function refreshApplyBar() {
    if (!ADV) return;
    let n = 0;
    try { n = ((await chrome.runtime.sendMessage({ type: 'jobs' })) || {}).count || 0; } catch (e) {}
    els.applyBar.hidden = n === 0;
    if (n) {
      els.applyText.textContent = n + (n === 1 ? ' tab is' : ' tabs are') + ' running with the settings ' + (n === 1 ? 'it' : 'they') +
        ' started with. New settings apply to tabs you start next. Apply them to the running ' + (n === 1 ? 'tab' : 'tabs') + ' now?';
    }
  }

  function flashSaved() {
    if (!ADV) return;
    els.advSaved.hidden = false;
    clearTimeout(flashSaved.t);
    flashSaved.t = setTimeout(() => { els.advSaved.hidden = true; }, 1600);
  }

  els.applyBtn.addEventListener('click', async () => {
    clearTimeout(saveTimer);
    const opts = collect();
    await chrome.storage.local.set({ defaults: opts });
    notifyEdited();
    els.applyBtn.disabled = true;
    let r = null;
    try { r = await chrome.runtime.sendMessage({ type: 'applyTech', opts }); } catch (e) {}
    els.applyBtn.disabled = false;
    els.applyText.textContent = r && r.ok
      ? 'Applied to ' + r.applied + (r.applied === 1 ? ' running tab.' : ' running tabs.')
      : 'Could not apply right now. Try again.';
    clearTimeout(applyTimer);
    applyTimer = setTimeout(refreshApplyBar, 3000);
  });
  window.addEventListener('focus', refreshApplyBar);
  els.notify.addEventListener('change', syncHumanUI);
  els.humanize.addEventListener('change', syncHumanUI);

  /* The anonymous install count and the new-version alert: two switches kept on this computer only, both on by default. */
  async function loadPrefs() {
    const { prefs } = await chrome.storage.local.get('prefs');
    const p = prefs || {};
    els.updateAlerts.checked = p.updateAlerts !== false;
    els.usagePing.checked = p.usagePing !== false;
  }
  function savePrefs() {
    chrome.storage.local.set({ prefs: { updateAlerts: els.updateAlerts.checked, usagePing: els.usagePing.checked } });
  }
  els.updateAlerts.addEventListener('change', savePrefs);
  els.usagePing.addEventListener('change', savePrefs);

  function tgSay(text, kind) {
    els.tgMsg.textContent = text || ''; // textContent only
    els.tgMsg.className = 'acct__msg' + (kind ? ' acct__msg--' + kind : '');
    els.tgMsg.hidden = !text;
  }

  // The popup never sees the bot token after Save: the background worker keeps it.
  async function refreshTelegram() {
    const st = (await chrome.runtime.sendMessage({ type: 'tg:status' })) || { connected: false };
    els.tgSetup.hidden = !!st.connected;
    els.tgDone.hidden = !st.connected;
    els.tgStatus.textContent = st.connected ? 'Connected' + (st.bot ? ' to ' + st.bot : '') : 'Not connected';
    els.tgStatus.classList.toggle('tg__status--on', !!st.connected);
    renderSummary();
  }

  els.tgDetect.addEventListener('click', async () => {
    els.tgDetect.disabled = true;
    tgSay('Looking for your message…');
    const r = await chrome.runtime.sendMessage({ type: 'tg:detect', token: els.tgToken.value });
    els.tgDetect.disabled = false;
    if (!r || !r.ok) return tgSay((r && r.error) || 'Could not check Telegram.', 'err');
    els.tgChat.value = r.chatId;
    tgSay('Found the chat' + (r.name ? ' with ' + r.name : '') + '. Press Save to finish.', 'ok');
  });

  els.tgSave.addEventListener('click', async () => {
    els.tgSave.disabled = true;
    tgSay('Connecting…');
    const r = await chrome.runtime.sendMessage({ type: 'tg:save', token: els.tgToken.value, chatId: els.tgChat.value });
    els.tgSave.disabled = false;
    if (!r || !r.ok) return tgSay((r && r.error) || 'Could not connect.', 'err');
    els.tgToken.value = '';
    els.tgChat.value = '';
    await refreshTelegram();
    tgSay('Connected. A confirmation message was sent to your Telegram.', 'ok');
  });

  els.tgTest.addEventListener('click', async () => {
    els.tgTest.disabled = true;
    const r = await chrome.runtime.sendMessage({ type: 'tg:test' });
    els.tgTest.disabled = false;
    tgSay(r && r.ok ? 'Test message sent. Check Telegram.' : (r && r.error) || 'Could not send the test.', r && r.ok ? 'ok' : 'err');
  });

  els.tgOff.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'tg:off' });
    await refreshTelegram();
    tgSay(acct.signedIn
      ? 'Disconnected. The bot token was removed from this computer and from your account.'
      : 'Disconnected. The bot token was removed from this computer.', 'ok');
  });

  /* ---------- account (optional login + sync) ---------- */

  // Mirror of the background's status(); it never holds the session token.
  let acct = { signedIn: false };
  let acctMode = 'login';

  function notifyEdited() {
    if (acct.signedIn) chrome.runtime.sendMessage({ type: 'acct:dirty' });
  }

  function acctSay(text, kind) {
    els.acctMsg.textContent = text || ''; // textContent only
    els.acctMsg.className = 'acct__msg' + (kind ? ' acct__msg--' + kind : '');
    els.acctMsg.hidden = !text;
  }

  function ago(ts) {
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 10) return 'just now';
    if (s < 60) return s + 's ago';
    const m = Math.round(s / 60);
    if (m < 60) return m + ' min ago';
    const h = Math.round(m / 60);
    return h < 48 ? h + 'h ago' : Math.round(h / 24) + 'd ago';
  }

  function setMode(m) {
    acctMode = m;
    els.modeLogin.classList.toggle('on', m === 'login');
    els.modeSignup.classList.toggle('on', m === 'signup');
    els.acctSubmit.textContent = m === 'login' ? 'Log in' : 'Create account';
    els.acctPass.autocomplete = m === 'login' ? 'current-password' : 'new-password';
    els.acctPass.placeholder = m === 'login' ? 'Password' : 'Password (8+ characters)';
    acctSay('');
  }

  function renderAccount() {
    els.acctOut.hidden = acct.signedIn;
    els.acctIn.hidden = !acct.signedIn;
    if (!acct.signedIn) return;
    els.acctWho.textContent = acct.email;
    els.acctSync.textContent = acct.error
      ? 'Sync problem: ' + acct.error
      : acct.dirty ? 'Changes waiting to sync…'
      : acct.lastSync ? 'Synced ' + ago(acct.lastSync) : 'Not synced yet';
  }

  async function refreshAccount() {
    acct = (await chrome.runtime.sendMessage({ type: 'acct:status' })) || { signedIn: false };
    renderAccount();
  }

  /* Settings that arrived from the account (login or sync) replace what's on screen. */
  function adoptRemote(defaults) {
    if (defaults) applyDefaults(defaults);
  }

  async function accountOpened() {
    await refreshAccount();
    if (!acct.signedIn) return;
    const r = await chrome.runtime.sendMessage({ type: 'acct:sync' });
    if (r && r.applied) adoptRemote(r.defaults);
    if (r && r.telegramChanged) await refreshTelegram();
    if (r && r.signedOut) acctSay(r.error, 'err');
    await refreshAccount();
  }

  els.modeLogin.addEventListener('click', () => setMode('login'));
  els.modeSignup.addEventListener('click', () => setMode('signup'));

  els.acctForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = els.acctEmail.value.trim();
    const password = els.acctPass.value;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return acctSay('Enter a valid email address.', 'err');
    if (!password) return acctSay('Enter your password.', 'err');
    if (acctMode === 'signup' && password.length < 8) return acctSay('Your password needs at least 8 characters.', 'err');

    els.acctSubmit.disabled = true;
    acctSay(acctMode === 'login' ? 'Logging in…' : 'Creating your account…');
    const r = await chrome.runtime.sendMessage({ type: acctMode === 'login' ? 'acct:login' : 'acct:signup', email, password });
    els.acctSubmit.disabled = false;
    els.acctPass.value = ''; // the password is never kept anywhere
    if (!r || !r.ok) return acctSay((r && r.error) || 'Something went wrong. Please try again.', 'err');
    if (r.adopted) adoptRemote(r.defaults);
    if (r.telegramChanged) await refreshTelegram();
    await refreshAccount();
    acctSay(acctMode === 'login'
      ? (r.adopted ? 'Logged in. The settings saved on your account are now on this computer.' : 'Logged in. Your settings will sync from now on.')
      : 'Account created. Your settings will now sync to every computer you log in on.', 'ok');
  });

  els.acctSyncNow.addEventListener('click', async () => {
    els.acctSyncNow.disabled = true;
    acctSay('Syncing…');
    const r = await chrome.runtime.sendMessage({ type: 'acct:sync' });
    els.acctSyncNow.disabled = false;
    if (r && r.applied) adoptRemote(r.defaults);
    if (r && r.telegramChanged) await refreshTelegram();
    await refreshAccount();
    if (!r || !r.ok) return acctSay((r && r.error) || 'Could not sync right now.', 'err');
    acctSay(r.applied || r.telegramChanged ? 'Synced. Newer settings from your account were loaded.' : 'Everything is up to date.', 'ok');
  });

  els.acctLogout.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'acct:logout' });
    await refreshAccount();
    acctSay('Logged out. Your settings stay on this computer.', 'ok');
  });

  els.acctDelToggle.addEventListener('click', () => {
    els.acctDel.hidden = !els.acctDel.hidden;
    els.acctDelPass.value = '';
  });

  els.acctDelGo.addEventListener('click', async () => {
    const password = els.acctDelPass.value;
    if (!password) return acctSay('Enter your password to confirm.', 'err');
    els.acctDelGo.disabled = true;
    const r = await chrome.runtime.sendMessage({ type: 'acct:delete', password });
    els.acctDelGo.disabled = false;
    els.acctDelPass.value = '';
    await refreshAccount();
    if (!r || !r.ok) return acctSay((r && r.error) || 'Could not delete the account.', 'err');
    els.acctDel.hidden = true;
    acctSay('Your account and the settings stored for it were deleted. Settings on this computer are untouched.', 'ok');
  });

  /* ---------- boot ---------- */

  (async function init() {
    els.verNum.textContent = chrome.runtime.getManifest().version;
    loadPrefs();

    const store = await chrome.storage.session.get('aiHistory');
    aiHistory = Array.isArray(store.aiHistory) ? store.aiHistory : [];
    renderAi();
    setMode('login');
    refreshTelegram();

    setInterval(paintSchedule, 1000);
    paintSchedule();
    refreshApplyBar();                       // Advanced dashboard: how many tabs are running
    window.LynchReviewsUI.maybePrompt();     // popup: the background says whether it is time for the review window

    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) { renderWins(); return; }

    els.title.textContent = tab.title || 'Untitled tab';
    try {
      els.url.textContent = new URL(tab.url).hostname;
    } catch (e) {
      els.url.textContent = tab.url || '';
    }

    const res = await chrome.runtime.sendMessage({ type: 'status', tabId: tab.id });
    job = res && res.job ? res.job : null;
    // The technical settings always come from what is saved (they are edited in Advanced); a running tab
    // only contributes what is its own: its interval and its account name.
    const saved = res && res.defaults ? res.defaults : null;
    applyDefaults(job ? Object.assign({}, saved || job, { intervalMs: job.intervalMs, label: job.label }) : saved);
    accountOpened(); // pull any settings changed on another computer

    // Settings and the assistant still work on the browser's own pages;
    // only starting a refresh there is impossible.
    const restricted = /^(chrome|edge|about|chrome-extension|devtools):/i.test(tab.url || '');
    if (restricted) {
      els.primary.disabled = true;
      els.primary.textContent = 'Not available on this page';
      return;
    }
    render();
  })();

  window.addEventListener('unload', () => { stopTicker(); clearInterval(pausedPoll); });
})();
