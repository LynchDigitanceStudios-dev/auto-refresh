/* Lynch Digitance — Auto Refresh (MV3 service worker)
 *
 * State lives in chrome.storage.session under "jobs": { [tabId]: job }.
 * A job holds its interval, options and the timestamp of the next fire.
 *
 * Scheduling: chrome.alarms has a 30s floor, so intervals >= 30s use an
 * alarm (survives worker sleep) and shorter ones use a chained setTimeout
 * plus a 30s keepalive alarm that re-arms the chain if the worker died.
 *
 * Time windows: outside every window a job sleeps on one alarm set for the
 * next window's start, rather than waking every interval to do nothing.
 */

importScripts('schedule.js', 'sync.js', 'alerts.js', 'human.js'); // define self.LynchSchedule, LynchSync, LynchAlerts and LynchHuman

const ALARM_PREFIX = 'lynch-refresh-';
const KEEPALIVE = 'lynch-keepalive';
const ALARM_FLOOR_MS = 30000;

const timers = new Map(); // tabId -> setTimeout handle (short intervals only)

/* ---------- state helpers ---------- */

async function getJobs() {
  const { jobs } = await chrome.storage.session.get('jobs');
  return jobs || {};
}

async function setJobs(jobs) {
  await chrome.storage.session.set({ jobs });
}

async function getJob(tabId) {
  return (await getJobs())[tabId] || null;
}

async function putJob(tabId, job) {
  const jobs = await getJobs();
  jobs[tabId] = job;
  await setJobs(jobs);
}

async function dropJob(tabId) {
  const jobs = await getJobs();
  delete jobs[tabId];
  await setJobs(jobs);
}

/* ---------- schedule window ---------- */

function withinSchedule(job, now = new Date()) {
  return LynchSchedule.isActive(job.schedule, now);
}

/* ---------- timing ---------- */

function nextDelay(job) {
  // A random range wins over the fixed interval: each cycle rolls its own
  // delay somewhere between min and max, e.g. 250s–300s.
  const r = job.range;
  if (r && r.enabled) {
    const lo = Math.min(r.minMs, r.maxMs);
    const hi = Math.max(r.minMs, r.maxMs);
    return Math.max(1000, Math.round(lo + Math.random() * (hi - lo)));
  }
  const base = job.intervalMs;
  if (!job.jitter) return base;
  return Math.max(1000, Math.round(base * (1 + (Math.random() * 0.2 - 0.1))));
}

async function arm(tabId, job) {
  let delay;
  if (!withinSchedule(job)) {
    // Outside every window: sleep straight through to the next one. When the
    // alarm fires, fire() sees an open window and refreshes immediately.
    const wait = LynchSchedule.msUntilNextStart(job.schedule, new Date());
    delay = wait === null ? 24 * 3600e3 : wait;
    job.sleeping = true;
    job.wakeAt = Date.now() + delay;
  } else {
    delay = nextDelay(job);
    job.sleeping = false;
    job.wakeAt = null;
    // Remember this cycle's length so the popup ring measures against the
    // delay actually rolled, not the fixed interval.
    job.cycleMs = delay;
  }
  job.armedMs = delay;
  job.nextAt = Date.now() + delay;
  await putJob(tabId, job);

  clearTimeout(timers.get(tabId));
  timers.delete(tabId);
  await chrome.alarms.clear(ALARM_PREFIX + tabId);

  if (delay >= ALARM_FLOOR_MS) {
    chrome.alarms.create(ALARM_PREFIX + tabId, { when: job.nextAt });
  } else {
    timers.set(tabId, setTimeout(() => fire(Number(tabId)), delay));
    chrome.alarms.create(KEEPALIVE, { periodInMinutes: 0.5 });
  }

  if (job.pageTimer) syncOverlay(Number(tabId), job);
}

/* ---------- on-page timer (optional) ---------- */

/* Runs inside the page. Must be self-contained: it is serialised and injected.
   A closed shadow root keeps the site's CSS from restyling it, and
   pointer-events:none means it can never block a click. The page itself can
   still see the element exists — that is why this is opt-in. */
function mountOverlay(state) {
  const KEY = '__lynchAutoRefreshTimer';
  const prev = window[KEY];
  if (prev) { clearInterval(prev.t); prev.host.remove(); delete window[KEY]; }
  if (!state) return;

  const host = document.createElement('div');
  host.style.cssText = 'all:initial;position:fixed;top:12px;right:12px;' +
    'z-index:2147483647;pointer-events:none;';
  const root = host.attachShadow({ mode: 'closed' });
  const pill = document.createElement('div');
  pill.style.cssText = 'display:flex;align-items:center;gap:8px;padding:9px 14px;' +
    'border-radius:999px;font:800 17px/1 system-ui,-apple-system,"Segoe UI",sans-serif;' +
    'font-variant-numeric:tabular-nums;letter-spacing:-.01em;color:#f2b583;' +
    'background:rgba(14,14,19,.9);border:1px solid rgba(217,122,61,.65);' +
    'box-shadow:0 8px 24px rgba(0,0,0,.35);';
  const dot = document.createElement('span');
  dot.style.cssText = 'width:9px;height:9px;border-radius:50%;background:#d97a3d;flex:none;';
  const label = document.createElement('span');
  pill.append(dot, label);
  root.appendChild(pill);
  (document.documentElement || document.body).appendChild(host);

  const paint = () => {
    if (state.paused) {
      label.textContent = 'Paused · ' + Math.ceil(state.remainingMs / 1000) + 's';
      dot.style.background = '#8a8a93';
      return;
    }
    const secs = Math.max(0, Math.ceil((state.nextAt - Date.now()) / 1000));
    label.textContent = (state.sleeping ? 'Next window in ' : '') + secs + 's';
    dot.style.background = state.sleeping ? '#8a8a93' : '#d97a3d';
  };
  paint();
  window[KEY] = { host, t: setInterval(paint, 500) };
}

async function syncOverlay(tabId, job) {
  const state = job && job.pageTimer
    ? { nextAt: job.nextAt, sleeping: !!job.sleeping, paused: !!job.paused, remainingMs: job.remainingMs || 0 }
    : null;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func: mountOverlay, args: [state] });
  } catch (e) { /* restricted page, or the tab is mid-reload — onUpdated retries */ }
}

/* ---------- the refresh itself ---------- */

/* ---------- "needs a human touch" ----------
 *
 * After each reload the tab is scanned (human.js, run inside the page) for two
 * things: a block or human check, and any words the user chose. Only a tiny
 * verdict comes back. A problem raises ONE alert and, by default, pauses that
 * tab: reloading a captcha while someone is trying to solve it would only reset
 * it. A paused tab is never reloaded, but it is watched (see "carrying on by
 * itself" below) and resumes on its own once the page is fine. Pressing Resume
 * still works any time; if the problem is still there it alerts again.
 */

const REMIND_MS = 30 * 60000; // re-alert a lingering problem this often, when not pausing

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* Let the reload finish (up to maxMs) so the scan sees the real page. */
async function waitLoaded(tabId, maxMs) {
  await wait(400); // give the tab time to leave its old "complete" state
  const end = Date.now() + maxMs;
  while (Date.now() < end) {
    try {
      const t = await chrome.tabs.get(tabId);
      if (t.status === 'complete') break;
    } catch (e) { return; }
    await wait(250);
  }
  await wait(600); // let scripts paint a challenge or a message
}

async function scanTab(tabId, job) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['human.js'] });
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (cfg) => self.LynchHuman.scanPage(cfg),
      args: [{ block: job.humanBlock !== false, words: job.humanWords || [] }]
    });
    return res && res.result ? res.result : null;
  } catch (e) {
    return null; // restricted page (chrome://, web store, PDF viewer…)
  }
}

/* True when a page TITLE alone says "security check" ("Just a moment...", "Access Denied"). */
const titleLooksBlocked = (t) => !!LynchHuman.scanText({ title: t, text: '' }).block;

/* The name in the alert: what the user typed for this tab. With none typed, the last NORMAL
   page title (on a captcha page the current title is useless: "Just a moment..."), else the site. */
function alertName(job, tab) {
  const typed = (job.label || '').trim();
  if (typed) return typed.slice(0, 60);
  const now = tab && tab.title && !titleLooksBlocked(tab.title) ? tab.title : '';
  let n = job.lastTitle || now || '';
  if (!n && tab && tab.url) { try { n = new URL(tab.url).hostname; } catch (e) {} }
  return (n || 'A tab').slice(0, 60);
}

/* Where the alert came from, as "site/path". Never the part after ? or #, which can carry tokens. */
function pageWhere(tab) {
  try {
    const u = new URL(tab.url);
    return (u.hostname.replace(/^www\./, '') + (u.pathname === '/' ? '' : u.pathname)).slice(0, 90);
  } catch (e) { return ''; }
}

/* The account name can be edited while a tab runs. Alerts read it fresh, and a cycle that
   started with the old one must not write it back over the new one. */
async function freshLabel(tabId, job) {
  const cur = await getJob(tabId);
  if (cur && typeof cur.label === 'string') job.label = cur.label;
}

async function chime(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        try {
          const ctx = new (window.AudioContext || window.webkitAudioContext)();
          [880, 1180].forEach((f, i) => {
            const o = ctx.createOscillator();
            const g = ctx.createGain();
            o.frequency.value = f;
            g.gain.value = 0.05;
            o.connect(g).connect(ctx.destination);
            o.start(ctx.currentTime + i * 0.18);
            o.stop(ctx.currentTime + i * 0.18 + 0.16);
          });
          setTimeout(() => ctx.close(), 800);
        } catch (e) {}
      }
    });
  } catch (e) {}
}

async function raiseHuman(job, tab, reasons, willPause) {
  const name = alertName(job, tab);
  const reason = reasons.join('; ');
  const where = pageWhere(tab);
  try {
    await chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: name + ' needs a human touch',
      message: reason + (willPause ? ' Paused until it is fixed.' : '')
    });
  } catch (e) { /* notifications may be blocked */ }
  if (job.sound) await chime(job.tabId);
  // Telegram, only if a bot is connected; does nothing otherwise. The name always comes first.
  await LynchAlerts.send(
    '\u{1F590} ' + name + ' needs a human touch' +
    '\nReason: ' + reason +
    (where ? '\nPage: ' + where : '') +
    (willPause ? '\nPaused. Fix it in the tab and it carries on by itself (or press Resume).' : '') +
    ((job.label || '').trim() ? '' : '\n(No account name set. Type one in the popup to see it here.)')
  );
}

/* Returns true when the tab was paused because a human is needed. */
async function humanCheck(tabId, job, tab) {
  const scan = await scanTab(tabId, job);
  if (!scan) return false;

  const found = [];
  if (scan.block) found.push({ key: 'block', reason: scan.block });
  for (const w of scan.words || []) found.push({ key: 'word:' + String(w).toLowerCase(), reason: 'Found \u201C' + w + '\u201D' });

  const state = job.humanState || {};
  const present = new Set(found.map((f) => f.key));
  for (const k of Object.keys(state)) if (!present.has(k)) delete state[k]; // resolved: alert again next time
  const now = Date.now();
  const fresh = found.filter((f) => !state[f.key] || (job.pauseOnHuman === false && now - state[f.key] >= REMIND_MS));
  for (const f of fresh) state[f.key] = now;
  job.humanState = state;
  if (!fresh.length) return false;

  const willPause = job.pauseOnHuman !== false;
  if (willPause) {
    job.paused = true;
    job.humanReason = fresh.map((f) => f.reason).join('; ');
    job.remainingMs = 0;
    job.pausedAt = Date.now();
    delete job.clearSince;
    clearTimeout(timers.get(tabId));
    timers.delete(tabId);
    await chrome.alarms.clear(ALARM_PREFIX + tabId);
  }
  await raiseHuman(job, tab, fresh.map((f) => f.reason), willPause);
  return willPause;
}

/* ---------- carrying on by itself once a human has fixed it ----------
 *
 * A tab that paused for a human check is NOT reloaded (that would reset a captcha being
 * solved), but it is still looked at: the page text is re-read through the same scan,
 * touching nothing. Once it is clear (no block, none of the user's words) on two looks at
 * least CLEAR_CONFIRM_MS apart, the tab resumes by itself. Two looks, because a challenge
 * can be blank for an instant while its widget loads. A quick timer does the looking for
 * the first minutes; a 30 s alarm keeps it going after that and wakes a sleeping worker,
 * and a finished page load triggers a look at once.
 */

const WATCH_FAST_MS = 5000;
const WATCH_FAST_FOR_MS = 10 * 60000;
const CLEAR_CONFIRM_MS = 3000;
const HUMAN_ALARM = 'lynch-human-watch';

const watchers = new Map(); // tabId -> timeout of the quick watch
const checking = new Set(); // tabIds being looked at right now (looks never overlap)

const waitingForHuman = (j) => !!(j && j.paused && j.humanReason);

/* The 30 s alarm exists only while some tab is waiting for a human. Created only when
   missing: create() restarts the period, which would starve it. */
async function syncHumanAlarm() {
  const need = Object.values(await getJobs()).some(waitingForHuman);
  const has = await chrome.alarms.get(HUMAN_ALARM);
  if (need && !has) chrome.alarms.create(HUMAN_ALARM, { periodInMinutes: 0.5 });
  else if (!need && has) await chrome.alarms.clear(HUMAN_ALARM);
}

function stopWatch(tabId) {
  clearTimeout(watchers.get(tabId));
  watchers.delete(tabId);
}

function watchHuman(tabId) {
  stopWatch(tabId);
  const tick = async () => {
    watchers.delete(tabId);
    await checkHumanClear(tabId).catch(() => {});
    const j = await getJob(tabId);
    if (waitingForHuman(j) && Date.now() - (j.pausedAt || 0) < WATCH_FAST_FOR_MS && !watchers.has(tabId)) {
      watchers.set(tabId, setTimeout(tick, WATCH_FAST_MS));
    }
  };
  watchers.set(tabId, setTimeout(tick, WATCH_FAST_MS));
}

async function checkHumanClear(tabId) {
  if (checking.has(tabId)) return;
  checking.add(tabId);
  try {
    const job = await getJob(tabId);
    if (!waitingForHuman(job)) return;
    let tab;
    try { tab = await chrome.tabs.get(tabId); } catch (e) { await stop(tabId); return; }
    if (tab.status && tab.status !== 'complete') return;       // still loading: look again shortly
    const scan = await scanTab(tabId, job);
    if (!scan) return;                                         // page can't be read: can't tell, keep waiting

    const cur = await getJob(tabId);                           // it may have changed while the page was read
    if (!waitingForHuman(cur)) return;
    if (scan.block || (scan.words && scan.words.length)) {
      if (cur.clearSince) { delete cur.clearSince; await putJob(tabId, cur); }
      return;                                                  // still needs the human
    }
    const now = Date.now();
    if (!cur.clearSince) {
      cur.clearSince = now;                                    // first clean look: confirm it shortly
      await putJob(tabId, cur);
      setTimeout(() => checkHumanClear(tabId).catch(() => {}), CLEAR_CONFIRM_MS + 400);
      return;
    }
    if (now - cur.clearSince < CLEAR_CONFIRM_MS) return;
    await setPaused(tabId, false);                             // clean twice: carry on, next refresh re-armed
  } finally {
    checking.delete(tabId);
  }
}

/* ---------- act human on the page (optional) ----------
 *
 * With "Act human on the page" on, each reload is followed by one short visit run
 * inside the tab (act.js): pointer moves, a little scrolling, sometimes a click on
 * empty space. It plays while the next refresh counts down, never uses more than
 * ACT_SHARE of that wait, and is skipped when the wait is too short to look natural.
 * A page that looks like it needs a human is left strictly alone.
 */

const ACT_MAX_MS = 12000;
const ACT_MIN_MS = 2500;
const ACT_SHARE = 0.6;

async function actHuman(tabId, job, loaded) {
  try {
    if (loaded) {
      // the human check already ran: any problem it found is still on the page
      if (Object.keys(job.humanState || {}).length) return;
    } else {
      // alerts are off, so nothing has looked at the page yet: a quiet look, no alert from here
      await waitLoaded(tabId, 8000);
      const scan = await scanTab(tabId, {});
      if (scan && (scan.block || (scan.words && scan.words.length))) return;
    }
    const cur = await getJob(tabId);
    if (!cur || cur.paused) return;
    const budget = Math.min(ACT_MAX_MS, Math.floor(((cur.nextAt || 0) - Date.now()) * ACT_SHARE));
    if (budget < ACT_MIN_MS) return;
    await chrome.scripting.executeScript({ target: { tabId }, files: ['act.js'] });
    await chrome.scripting.executeScript({
      target: { tabId },
      // started and left running: the visit carries on inside the page after this call returns
      func: (cfg) => { self.LynchAct.run(cfg); return true; },
      args: [{ budgetMs: budget, clicks: job.humanClicks !== false }]
    });
  } catch (e) { /* restricted page, or the tab is mid-reload or gone */ }
}

async function fire(tabId) {
  const job = await getJob(tabId);
  if (!job || job.paused) return;

  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (e) {
    await stop(tabId); // tab is gone
    return;
  }

  if (!withinSchedule(job)) {
    await arm(tabId, job); // outside every window: go back to sleep until the next one
    await paintBadge();
    return;
  }

  try {
    await chrome.tabs.reload(tabId, { bypassCache: !!job.hardRefresh });
  } catch (e) {
    await stop(tabId);
    return;
  }

  job.count = (job.count || 0) + 1;
  job.lastRefresh = Date.now();

  let loaded = false; // true once the reloaded page has been waited for
  if (job.notifyOnChange) {
    await waitLoaded(tabId, 8000);
    loaded = true;
    try { tab = await chrome.tabs.get(tabId); } catch (e) { await stop(tabId); return; }
    await freshLabel(tabId, job); // a name typed while this cycle ran counts
    if (await humanCheck(tabId, job, tab)) {
      await putJob(tabId, job);
      if (job.pageTimer) await syncOverlay(tabId, job);
      await paintBadge();
      watchHuman(tabId); // never reloaded while it waits, but watched: it carries on by itself once fixed
      await syncHumanAlarm();
      return; // paused: no next refresh is armed until the page is fine (or the user presses Resume)
    }
    // remember the last normal title: on a captcha page the title is no use as a name
    if (!Object.keys(job.humanState || {}).length && tab.title && !titleLooksBlocked(tab.title)) job.lastTitle = tab.title.slice(0, 60);
  }

  await freshLabel(tabId, job);
  await arm(tabId, job);
  await paintBadge();
  if (job.humanize) actHuman(tabId, job, loaded).catch(() => {}); // plays in the page while the next refresh counts down
}

/* ---------- public actions ---------- */

async function start(tabId, opts) {
  const existing = await getJob(tabId);
  let startTitle = '';
  try {
    const t = await chrome.tabs.get(tabId);
    if (t && t.title && !titleLooksBlocked(t.title)) startTitle = t.title.slice(0, 60);
  } catch (e) { /* tab gone: the next refresh finds out */ }
  const job = {
    tabId,
    intervalMs: opts.intervalMs,
    hardRefresh: !!opts.hardRefresh,
    notifyOnChange: !!opts.notifyOnChange,
    sound: !!opts.sound,
    jitter: !!opts.jitter,
    range: opts.range || null,
    schedule: opts.schedule || null,
    pageTimer: !!opts.pageTimer,
    label: typeof opts.label === 'string' ? opts.label.trim().slice(0, 40) : '',
    humanBlock: opts.humanBlock !== false,
    humanWords: Array.isArray(opts.humanWords) ? opts.humanWords.filter((w) => typeof w === 'string' && w.trim()).slice(0, 10) : [],
    pauseOnHuman: opts.pauseOnHuman !== false,
    humanize: !!opts.humanize,
    humanClicks: opts.humanClicks !== false,
    humanState: {},
    lastTitle: (existing && existing.lastTitle) || startTitle,
    paused: false,
    count: existing ? existing.count || 0 : 0,
    startedAt: existing && existing.startedAt ? existing.startedAt : Date.now()
  };
  // Turned the on-page timer off while running: take it off the page now.
  if (existing && existing.pageTimer && !job.pageTimer) await syncOverlay(tabId, null);
  await arm(tabId, job);
  await paintBadge();
  stopWatch(tabId); // a fresh start is never waiting for a human
  await syncHumanAlarm();
  return job;
}

async function stop(tabId) {
  clearTimeout(timers.get(tabId));
  timers.delete(tabId);
  await chrome.alarms.clear(ALARM_PREFIX + tabId);
  const job = await getJob(tabId);
  if (job && job.pageTimer) await syncOverlay(tabId, null);
  await dropJob(tabId);
  await paintBadge();
  stopWatch(tabId);
  await syncHumanAlarm();
}

async function setPaused(tabId, paused) {
  const job = await getJob(tabId);
  if (!job) return null;
  job.paused = paused;
  if (paused) {
    clearTimeout(timers.get(tabId));
    timers.delete(tabId);
    await chrome.alarms.clear(ALARM_PREFIX + tabId);
    job.remainingMs = Math.max(0, (job.nextAt || Date.now()) - Date.now());
    await putJob(tabId, job);
    if (job.pageTimer) await syncOverlay(tabId, job);
  } else {
    delete job.humanReason; // handled (or it will be detected again after the next refresh)
    delete job.clearSince;
    delete job.pausedAt;
    job.humanState = {};
    await arm(tabId, job);
    stopWatch(tabId);
  }
  await paintBadge();
  await syncHumanAlarm();
  return job;
}

/* ---------- once a day: count this install, and say when a new version is out ----------
 *
 * One request a day to the accounts server with a RANDOM install ID and the version number, so the
 * owner can count how many copies are in use. Nothing else goes with it: no email, no settings, no
 * page. A second request fetches the public version.json; if a newer version exists the user gets a
 * desktop notification and, if they connected their own Telegram bot, a message there (once per
 * version). Both are on by default and each has its own switch in the popup ("prefs").
 */
const VERSION_URL = 'https://autorefresh.lynchdigitancestudios.workers.dev/version.json';
const DAILY_ALARM = 'lynch-daily';
const DAILY_EVERY_MS = 20 * 3600e3;

const verParts = (v) => String(v).split('.').map((n) => parseInt(n, 10) || 0);
function isNewer(a, b) {
  const x = verParts(a), y = verParts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d > 0;
  }
  return false;
}

async function getPrefs() {
  const { prefs } = await chrome.storage.local.get('prefs');
  return Object.assign({ usagePing: true, updateAlerts: true }, prefs || {});
}

async function installId() {
  const s = await chrome.storage.local.get('installId');
  if (s.installId) return s.installId;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ installId: id });
  return id;
}

async function dailyCheck() {
  const prefs = await getPrefs();
  const version = chrome.runtime.getManifest().version;

  if (prefs.usagePing) {
    try {
      await fetch(LynchSync.API + '/ping', {
        method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: await installId(), v: version })
      });
    } catch (e) { /* offline or blocked: tomorrow */ }
  }

  if (prefs.updateAlerts) {
    let data = null;
    try {
      const res = await fetch(VERSION_URL + '?t=' + Date.now(), { cache: 'no-store' });
      if (res.ok) data = await res.json();
    } catch (e) { return; }
    if (!data || typeof data.version !== 'string' || !isNewer(data.version, version)) return;
    const { lastTold } = await chrome.storage.local.get('lastTold');
    if (lastTold === data.version) return;                       // already told about this one
    await chrome.storage.local.set({ lastTold: data.version });
    const note = typeof data.notes === 'string' ? data.notes.trim().slice(0, 300) : '';
    const link = /^https:\/\//.test(data.downloadUrl || '') ? data.downloadUrl : VERSION_URL.replace(/version\.json$/, '');
    try {
      await chrome.notifications.create({
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: 'Auto Refresh ' + data.version + ' is out',
        message: note || 'Open the extension and press Check for updates.'
      });
    } catch (e) { /* notifications may be blocked */ }
    // the user's own Telegram bot, only if they connected one
    await LynchAlerts.send('\u{1F504} Auto Refresh ' + data.version + ' is out' + (note ? '\n' + note : '') + '\nDownload: ' + link);
  }
}

async function maybeDaily() {
  try {
    const { lastDaily } = await chrome.storage.local.get('lastDaily');
    if (lastDaily && Date.now() - lastDaily < DAILY_EVERY_MS) return;
    await chrome.storage.local.set({ lastDaily: Date.now() });
    await dailyCheck();
  } catch (e) { /* never let this reach the refresh logic */ }
}

async function ensureDaily() {
  if (!(await chrome.alarms.get(DAILY_ALARM))) chrome.alarms.create(DAILY_ALARM, { periodInMinutes: 1440 }); // only when missing
}

/* ---------- badge ---------- */

/* Each refreshing tab shows its OWN countdown on the toolbar icon, in seconds.
   Tabs that aren't refreshing show nothing. Repainted every second while any
   tab is counting down; the per-second extension API call is also what keeps
   the service worker awake so the count never freezes. */

const GOLD = '#d97a3d';
const GREY = '#6b6b76';
let badgeTicker = null;
let paintedTabs = new Set();

function badgeFor(job, now) {
  if (job.paused) return job.humanReason ? { text: '!', color: '#ff5f57' } : { text: '||', color: GREY };
  const secs = Math.max(0, Math.ceil(((job.nextAt || now) - now) / 1000));
  // The badge fits four characters: 9999s is ~2.8h, longer waits show hours.
  const text = secs <= 9999 ? String(secs) : Math.round(secs / 3600) + 'h';
  return { text, color: job.sleeping ? GREY : GOLD };
}

async function paintBadge() {
  const jobs = await getJobs();
  const now = Date.now();
  const seen = new Set();

  for (const [id, job] of Object.entries(jobs)) {
    const tabId = Number(id);
    const { text, color } = badgeFor(job, now);
    seen.add(tabId);
    try {
      await chrome.action.setBadgeText({ tabId, text });
      await chrome.action.setBadgeBackgroundColor({ tabId, color });
      // dark digits on gold, white on grey (Chrome 110+)
      if (chrome.action.setBadgeTextColor) {
        await chrome.action.setBadgeTextColor({ tabId, color: color === GOLD ? '#141109' : '#ffffff' });
      }
    } catch (e) { /* tab closed between reads */ }
  }

  // Clear tabs that stopped since the last paint.
  for (const tabId of paintedTabs) {
    if (!seen.has(tabId)) {
      try { await chrome.action.setBadgeText({ tabId, text: '' }); } catch (e) {}
    }
  }
  paintedTabs = seen;

  const ticking = Object.values(jobs).some((j) => !j.paused);
  if (ticking && !badgeTicker) badgeTicker = setInterval(paintBadge, 1000);
  if (!ticking && badgeTicker) { clearInterval(badgeTicker); badgeTicker = null; }
}

/* ---------- events ---------- */

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === LynchSync.ALARM) {
    LynchSync.syncNow(); // optional account sync; only ever armed while logged in
    return;
  }
  if (alarm.name === DAILY_ALARM) {
    maybeDaily();
    return;
  }
  if (alarm.name === HUMAN_ALARM) {
    // the slow watch: also what restarts the quick one if the worker was asleep
    for (const [id, job] of Object.entries(await getJobs())) {
      if (!waitingForHuman(job)) continue;
      const tabId = Number(id);
      checkHumanClear(tabId).catch(() => {});
      if (!watchers.has(tabId) && Date.now() - (job.pausedAt || 0) < WATCH_FAST_FOR_MS) watchHuman(tabId);
    }
    await syncHumanAlarm();
    return;
  }
  if (alarm.name === KEEPALIVE) {
    // Re-arm any short-interval job whose chained timeout died with the worker.
    const jobs = await getJobs();
    const short = (j) => (j.armedMs || j.cycleMs || j.intervalMs) < ALARM_FLOOR_MS;
    for (const [id, job] of Object.entries(jobs)) {
      if (job.paused || !short(job)) continue;
      if (!timers.has(Number(id))) {
        if ((job.nextAt || 0) <= Date.now()) fire(Number(id));
        else await arm(Number(id), job);
      }
    }
    if (!Object.values(jobs).some((j) => !j.paused && short(j))) {
      await chrome.alarms.clear(KEEPALIVE);
    }
    return;
  }
  if (alarm.name.startsWith(ALARM_PREFIX)) {
    fire(Number(alarm.name.slice(ALARM_PREFIX.length)));
  }
});

chrome.tabs.onRemoved.addListener((tabId) => { stop(tabId); });

// A reload wipes the on-page timer, so put it back once the new page is ready.
// A page that finishes loading while the tab waits for a human may be the fixed one: look at once.
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status !== 'complete') return;
  const job = await getJob(tabId);
  if (job && job.pageTimer) syncOverlay(tabId, job);
  if (waitingForHuman(job)) setTimeout(() => checkHumanClear(tabId).catch(() => {}), 1500);
});

// Whenever the worker wakes (alarm, restart), resume the badge countdown.
chrome.action.setBadgeText({ text: '' });
paintBadge();
LynchSync.ensureAlarm();
ensureDaily().then(maybeDaily);

chrome.runtime.onStartup.addListener(async () => {
  await setJobs({});
  await paintBadge();
  LynchSync.ensureAlarm();
  LynchSync.syncNow(); // pick up changes made on another computer
});

chrome.commands.onCommand.addListener(async (cmd) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  const job = await getJob(tab.id);

  if (cmd === 'toggle-refresh') {
    if (job) await stop(tab.id);
    else {
      const { defaults } = await chrome.storage.local.get('defaults');
      await start(tab.id, defaults || { intervalMs: 30000 });
    }
  } else if (cmd === 'toggle-pause' && job) {
    await setPaused(tab.id, !job.paused);
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case 'start':
        await chrome.storage.local.set({ defaults: msg.opts });
        sendResponse(await start(msg.tabId, msg.opts));
        break;
      case 'stop':
        await stop(msg.tabId);
        sendResponse({ ok: true });
        break;
      case 'pause':
        sendResponse(await setPaused(msg.tabId, msg.paused));
        break;
      case 'status': {
        const { defaults } = await chrome.storage.local.get('defaults');
        sendResponse({ job: await getJob(msg.tabId), defaults: defaults || null });
        break;
      }
      case 'label': {
        // the account name applies to a tab that is already refreshing, the moment it is typed
        const j = await getJob(msg.tabId);
        if (j) {
          j.label = typeof msg.label === 'string' ? msg.label.trim().slice(0, 40) : '';
          await putJob(msg.tabId, j);
        }
        sendResponse({ ok: !!j });
        break;
      }
      case 'tg:status': sendResponse(await LynchAlerts.status()); break;
      case 'tg:detect': sendResponse(await LynchAlerts.detect(msg.token)); break;
      case 'tg:save': {
        const r = await LynchAlerts.save(msg.token, msg.chatId);
        if (r && r.ok) await LynchSync.markTelegramDirty(); // synced to the account when logged in
        sendResponse(r);
        break;
      }
      case 'tg:test': sendResponse(await LynchAlerts.test()); break;
      case 'tg:off': {
        const had = (await LynchAlerts.status()).connected;
        const r = await LynchAlerts.off();
        // only a bot that really was connected is disconnected account-wide: pressing it with none
        // here must never tell the account to drop the bot the other computers are using
        if (had) await LynchSync.markTelegramDirty();
        sendResponse(r);
        break;
      }
      case 'acct:status': sendResponse(await LynchSync.status()); break;
      case 'acct:signup': sendResponse(await LynchSync.signUp(msg.email, msg.password)); break;
      case 'acct:login': sendResponse(await LynchSync.logIn(msg.email, msg.password)); break;
      case 'acct:logout': sendResponse(await LynchSync.logOut()); break;
      case 'acct:delete': sendResponse(await LynchSync.deleteAccount(msg.password)); break;
      case 'acct:sync': sendResponse(await LynchSync.syncNow()); break;
      case 'acct:dirty': sendResponse(await LynchSync.markDirty()); break;
      default:
        sendResponse(null);
    }
  })();
  return true; // async response
});
