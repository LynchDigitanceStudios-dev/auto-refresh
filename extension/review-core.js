/* Lynch Digitance — Auto Refresh: reviews (background side).
 *
 * Runs only in the background worker (importScripts). The popup never sees the account token: it
 * asks this module, which talks to the accounts server.
 *
 * chrome.storage.local "review":
 *   state   'pending'  not reviewed yet, will be asked when dueAt passes
 *           'snoozed'  pressed "Maybe later" (asked again after a week)
 *           'done'     reviewed (can still be edited from the Reviews tab)
 *           'never'    pressed "Don't ask again"
 *   dueAt   ms: the review window opens on the first popup open at or after this moment
 *   firstUse  the first time a tab was started. A NEW install is asked 3 days after it.
 *   asks    how many times the window has been shown
 *   mine    the review this computer sent: { rating, text, name }
 *
 * Who is asked, and when:
 *  - A new install: 3 days after the first refresh was started.
 *  - Someone who updates from an older version (before reviews existed): at once, on the next popup open.
 *  - Showing the window counts as an ask: if it is ignored it comes back tomorrow, not on every open.
 *  - "Maybe later" = 7 days. "Don't ask again" = never. Sending a review = never asked again.
 *  - Someone who already reviewed with the same account on another computer is not asked.
 */
(function (root) {
  'use strict';

  const KEY = 'review';
  const DAY = 86400000;
  const FIRST_ASK_AFTER = 3 * DAY;
  const SNOOZE_LATER = 7 * DAY;
  const SNOOZE_SHOWN = DAY;
  const SINCE = '2.6.0';           // reviews arrived in this version
  const TEXT_MAX = 500;
  const TIMEOUT_MS = 12000;

  const API = root.LynchSync.API;

  const verParts = (v) => String(v).split('.').map((n) => parseInt(n, 10) || 0);
  function isOlder(a, b) {
    const x = verParts(a), y = verParts(b);
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      const d = (x[i] || 0) - (y[i] || 0);
      if (d) return d < 0;
    }
    return false;
  }

  async function get() {
    const s = await chrome.storage.local.get(KEY);
    return Object.assign({ state: 'pending', dueAt: null, firstUse: null, asks: 0, mine: null }, s[KEY] || {});
  }
  const put = (r) => chrome.storage.local.set({ [KEY]: r });

  // the same random install ID the daily check uses (stored under the same key)
  async function installId() {
    const s = await chrome.storage.local.get('installId');
    if (s.installId) return s.installId;
    const id = crypto.randomUUID();
    await chrome.storage.local.set({ installId: id });
    return id;
  }

  async function req(path, o) {
    o = o || {};
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), TIMEOUT_MS) : null;
    let res;
    try {
      res = await fetch(API + path, {
        method: o.method || 'GET',
        cache: 'no-store',
        headers: Object.assign({ 'Content-Type': 'application/json' }, o.token ? { Authorization: 'Bearer ' + o.token } : {}),
        body: o.body ? JSON.stringify(o.body) : undefined,
        signal: ctrl ? ctrl.signal : undefined
      });
    } catch (e) {
      return { ok: false, status: 0, error: "Couldn't reach the server. Check your connection and try again." };
    } finally {
      if (timer) clearTimeout(timer);
    }
    let data = null;
    try { data = await res.json(); } catch (e) {}
    return {
      ok: res.ok,
      status: res.status,
      data,
      error: res.ok ? null : (data && data.error) || 'Something went wrong. Please try again.'
    };
  }

  /* Browser start / extension update. Returns { openNow } so the worker can pop the window open at once. */
  async function onInstalled(details) {
    if (!details || details.reason !== 'update') return { openNow: false };
    // someone who used an older version: ask right away (never someone who already answered)
    if (!isOlder(details.previousVersion || '0', SINCE)) return { openNow: false };
    const r = await get();
    if (r.state !== 'done' && r.state !== 'never') {
      r.state = 'pending';
      r.dueAt = Date.now();
    }
    if (!r.firstUse) r.firstUse = Date.now();
    await put(r);
    return { openNow: r.state === 'pending' };
  }

  /* Called whenever a tab is started: the clock for a new install begins at its first use. */
  async function noteUse() {
    const r = await get();
    if (r.firstUse) return;
    r.firstUse = Date.now();
    if (r.state === 'pending' && !r.dueAt) r.dueAt = r.firstUse + FIRST_ASK_AFTER;
    await put(r);
  }

  /* The popup asks this each time it opens. Showing the window counts as an ask. */
  async function prompt() {
    const r = await get();
    const now = Date.now();
    if ((r.state !== 'pending' && r.state !== 'snoozed') || !r.dueAt || now < r.dueAt) return { show: false };

    const token = await root.LynchSync.getToken();
    if (token) {
      const m = await req('/reviews/mine', { token });
      if (m.status === 401) await root.LynchSync.expire();
      else if (m.ok && m.data && m.data.review) {
        r.state = 'done';
        r.mine = m.data.review;
        await put(r);
        return { show: false };
      }
    }
    r.dueAt = now + SNOOZE_SHOWN;
    r.asks = (r.asks || 0) + 1;
    await put(r);
    return { show: true, mine: r.mine || null, signedIn: !!token };
  }

  async function later() {
    const r = await get();
    if (r.state === 'done' || r.state === 'never') return { ok: true };
    r.state = 'snoozed';
    r.dueAt = Date.now() + SNOOZE_LATER;
    await put(r);
    return { ok: true };
  }

  async function never() {
    const r = await get();
    if (r.state !== 'done') r.state = 'never';
    await put(r);
    return { ok: true };
  }

  async function submit(rating, text) {
    rating = Number(rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) return { ok: false, error: 'Choose 1 to 5 stars.' };
    text = typeof text === 'string' ? text.trim() : '';
    if (text.length > TEXT_MAX) return { ok: false, error: 'Please keep your review under 500 characters.' };
    if (/(https?:\/\/|www\.)/i.test(text)) return { ok: false, error: 'Please leave links out of your review.' };

    const token = await root.LynchSync.getToken();
    const body = { rating, text, install: await installId(), v: chrome.runtime.getManifest().version };
    let r = await req('/reviews', { method: 'POST', token, body });
    if (r.status === 401 && token) {
      // the saved login expired: sign out here and send it as a review without an account
      await root.LynchSync.expire();
      r = await req('/reviews', { method: 'POST', body });
    }
    if (!r.ok) return { ok: false, error: r.error };

    const st = await get();
    st.state = 'done';
    st.mine = { rating, text, name: r.data && r.data.name ? r.data.name : '' };
    await put(st);
    return { ok: true, name: st.mine.name, created: !!(r.data && r.data.created) };
  }

  /* The public reviews plus this person's own (the Reviews tab). */
  async function list() {
    const token = await root.LynchSync.getToken();
    const inst = await installId();
    const [pub, mine] = await Promise.all([
      req('/reviews?limit=30'),
      req('/reviews/mine?install=' + encodeURIComponent(inst), { token })
    ]);
    if (!pub.ok || !pub.data) return { ok: false, error: pub.error || 'Could not load the reviews.' };
    if (mine.status === 401 && token) await root.LynchSync.expire();

    let m = null;
    const st = await get();
    if (mine.ok && mine.data) {
      m = mine.data.review || null;
      // the server is the truth: a review that was removed (account deleted) is no longer "mine"
      if ((m ? JSON.stringify(m) : '') !== (st.mine ? JSON.stringify(st.mine) : '')) {
        st.mine = m;
        if (m && st.state !== 'never') st.state = 'done';
        await put(st);
      }
    } else {
      m = st.mine || null; // offline for this part: show what was last sent
    }
    return { ok: true, count: pub.data.count || 0, average: pub.data.average || 0, reviews: pub.data.reviews || [], mine: m };
  }

  /* The popup waits on every reply, so none of these may throw. */
  const safe = (fn, fallback) => async (...args) => {
    try { return await fn(...args); } catch (e) { return fallback; }
  };
  const FAIL = { ok: false, error: 'Something went wrong. Please try again.' };

  root.LynchReview = {
    SINCE,
    FIRST_ASK_AFTER,
    onInstalled: safe(onInstalled, { openNow: false }),
    noteUse: safe(noteUse, null),
    prompt: safe(prompt, { show: false }),
    later: safe(later, FAIL),
    never: safe(never, FAIL),
    submit: safe(submit, FAIL),
    list: safe(list, { ok: false, error: 'Could not load the reviews.' })
  };
})(self);
