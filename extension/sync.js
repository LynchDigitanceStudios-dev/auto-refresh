/* Lynch Digitance — Auto Refresh: optional account + settings sync.
 *
 * Loaded by the background service worker only (importScripts), so a push still
 * completes if the popup is closed straight after an edit. The popup talks to
 * this through chrome.runtime messages.
 *
 * Nothing here runs unless the user has logged in. Logged out, the extension
 * makes no requests to the accounts server at all.
 *
 * What is synced: the saved `defaults` object (interval, random range, time
 * windows, options) and the Telegram bot connection. The account name and the
 * time zone stay on each computer. Never tab URLs, titles or page content, and
 * running per-tab jobs are not touched.
 *
 * The Telegram connection (bot token + chat ID) is a secret, so it travels on its
 * own route (/telegram) with its own revision and dirty flag, and the server
 * encrypts it before storing it. Same conflict rule as the settings. Disconnecting
 * on one computer disconnects the others on their next sync.
 *
 * Conflict rule — no device clocks involved, so a wrong clock can't lose data:
 *   - the server stamps every save with its own revision number
 *   - a device remembers the revision it last synced (`rev`) and whether it has
 *     unsynced edits (`dirty`)
 *   - dirty  -> push: an edit you just made on this device wins
 *   - clean  -> pull: if the server revision changed, adopt the server settings
 *   - logging in adopts the account's settings when the account already has some
 *
 * Stored in chrome.storage.local under "account":
 *   { email, token, rev, dirty, seq, tgRev, tgDirty, tgSeq, lastSync, error }
 * The password is never stored — only the session token the server returns.
 */
(function (root) {
  'use strict';

  const API = 'https://autorefresh-accounts.lynchdigitancestudios.workers.dev';
  const ALARM = 'lynch-acct-sync';
  const PULL_EVERY_MIN = 15;
  const PUSH_DELAY_MS = 1200;

  let pushTimer = null;
  let chain = Promise.resolve();

  /* One network job at a time, so a pull can never interleave with a push. */
  function queue(fn) {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  }

  async function call(path, opts) {
    const o = opts || {};
    let res;
    try {
      res = await fetch(API + path, {
        method: o.method || 'GET',
        cache: 'no-store',
        headers: Object.assign(
          { 'Content-Type': 'application/json' },
          o.token ? { Authorization: 'Bearer ' + o.token } : {}
        ),
        body: o.body ? JSON.stringify(o.body) : undefined
      });
    } catch (e) {
      return { ok: false, status: 0, error: "Couldn't reach the server. Check your connection and try again." };
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

  const failure = (r) => ({ ok: false, status: r.status, error: r.error });

  async function getAccount() {
    const s = await chrome.storage.local.get('account');
    return s.account || null;
  }
  const putAccount = (a) => chrome.storage.local.set({ account: a });
  async function localDefaults() {
    const s = await chrome.storage.local.get('defaults');
    return s.defaults || null;
  }

  async function localTelegram() {
    const s = await chrome.storage.local.get('telegram');
    return s.telegram || null;
  }
  const sameTg = (a, b) => (a ? a.token : '') === (b ? b.token : '') && (a ? a.chatId : '') === (b ? b.chatId : '');

  /* Two things belong to each computer and are NOT synced: the account name (`label`)
     and the time zone (`schedule.tz`). They are left out of what is uploaded, and a
     pull keeps this computer's own values. The time windows DO sync, so two computers
     can share the same windows and read them in their own time zones. */
  function forServer(d) {
    const copy = JSON.parse(JSON.stringify(d));
    delete copy.label;
    if (copy.schedule) delete copy.schedule.tz;
    return copy;
  }

  async function adoptRemote(remote) {
    const local = (await localDefaults()) || {};
    const merged = JSON.parse(JSON.stringify(remote));
    if ('label' in local) merged.label = local.label;
    const tz = local.schedule && local.schedule.tz;
    if (tz) merged.schedule = Object.assign({}, merged.schedule, { tz });
    await chrome.storage.local.set({ defaults: merged });
    return merged;
  }

  /* Create only when missing: create() restarts the period, and the worker wakes
     often while tabs are refreshing, so re-creating each time would starve it. */
  async function ensureAlarm() {
    const has = await chrome.alarms.get(ALARM);
    if (await getAccount()) {
      if (!has) chrome.alarms.create(ALARM, { periodInMinutes: PULL_EVERY_MIN });
    } else if (has) {
      await chrome.alarms.clear(ALARM);
    }
  }

  async function dropAccount() {
    clearTimeout(pushTimer);
    await chrome.storage.local.remove('account');
    await chrome.alarms.clear(ALARM);
  }

  /* The server no longer recognises our token: sign out locally, keep the settings. */
  async function expire() {
    await dropAccount();
    return { ok: false, signedOut: true, error: 'Your session expired. Please log in again. Your settings are still saved on this computer.' };
  }

  /* ---------- push / pull ---------- */

  async function push(acct) {
    const local = await localDefaults();
    if (!local) {
      acct.dirty = false;
      await putAccount(acct);
      return { ok: true };
    }
    const seqAtStart = acct.seq || 0;
    const r = await call('/settings', { method: 'PUT', token: acct.token, body: { settings: forServer(local) } });
    if (r.status === 401) return expire();
    const cur = (await getAccount()) || acct;
    if (!r.ok) {
      cur.error = r.error;               // stays dirty; the 15-minute alarm retries
      await putAccount(cur);
      return failure(r);
    }
    cur.rev = r.data.rev;
    // an edit made while the request was in flight has a higher seq: keep it dirty
    cur.dirty = (cur.seq || 0) !== seqAtStart;
    cur.lastSync = Date.now();
    delete cur.error;
    await putAccount(cur);
    if (cur.dirty) schedulePush();
    return { ok: true, pushed: true };
  }

  async function syncSettings() {
    const acct = await getAccount();
    if (!acct) return { ok: false, signedOut: true, error: 'Not signed in.' };
    if (acct.dirty) return push(acct);

    const r = await call('/settings', { token: acct.token });
    if (r.status === 401) return expire();
    if (!r.ok) {
      acct.error = r.error;
      await putAccount(acct);
      return failure(r);
    }
    // the account has nothing saved yet but this computer does: seed it
    if (!r.data.settings && (await localDefaults())) return push(acct);

    let applied = false;
    let defaults = null;
    if (r.data.settings && r.data.rev !== acct.rev) {
      defaults = await adoptRemote(r.data.settings);
      applied = true;
    }
    acct.rev = r.data.rev;
    acct.lastSync = Date.now();
    delete acct.error;
    await putAccount(acct);
    return { ok: true, applied, defaults };
  }

  /* The Telegram bot connection, same dirty/clean rule as the settings:
       - edited here (dirty)            -> push it (or push "disconnected")
       - never synced on this computer  -> the account's bot wins; if the account has
                                           none, this computer's bot seeds it
       - clean, server revision changed -> adopt the account's (or drop ours if the
                                           account was disconnected) */
  async function syncTelegram() {
    const acct = await getAccount();
    if (!acct) return { ok: false, signedOut: true, error: 'Not signed in.' };
    const local = await localTelegram();

    const send = async (tg, seqAtStart) => {
      const r = await call('/telegram', {
        method: 'PUT',
        token: acct.token,
        body: { telegram: tg ? { token: tg.token, chatId: tg.chatId, bot: tg.bot || '' } : null }
      });
      if (r.status === 401) return expire();
      const cur = (await getAccount()) || acct;
      if (!r.ok) {
        cur.error = r.error;               // stays dirty; the 15-minute alarm retries
        await putAccount(cur);
        return failure(r);
      }
      cur.tgRev = r.data.rev;
      // an edit made while the request was in flight has a higher seq: keep it dirty
      cur.tgDirty = (cur.tgSeq || 0) !== seqAtStart;
      cur.lastSync = Date.now();
      delete cur.error;
      await putAccount(cur);
      if (cur.tgDirty) schedulePush();
      return { ok: true, pushed: true };
    };

    if (acct.tgDirty) return send(local, acct.tgSeq || 0);

    const r = await call('/telegram', { token: acct.token });
    if (r.status === 401) return expire();
    if (!r.ok) {
      acct.error = r.error;
      await putAccount(acct);
      return failure(r);
    }
    const remote = r.data.telegram || null;
    let changed = false;
    const adopt = async () => {
      changed = !sameTg(local, remote);
      if (remote) await chrome.storage.local.set({ telegram: remote });
      else await chrome.storage.local.remove('telegram');
    };

    if (acct.tgRev === undefined || acct.tgRev === null) {
      if (remote) await adopt();
      else if (local) return send(local, acct.tgSeq || 0);
    } else if (r.data.rev !== acct.tgRev) {
      await adopt();
    }
    const cur = (await getAccount()) || acct;
    cur.tgRev = r.data.rev;
    cur.lastSync = Date.now();
    delete cur.error;
    await putAccount(cur);
    return { ok: true, changed };
  }

  /* Settings first, then the Telegram connection. */
  async function runSync() {
    const s = await syncSettings();
    if (!s.ok) return s;
    const t = await syncTelegram();
    if (t.signedOut) return t;
    return Object.assign({}, s, { telegramChanged: !!t.changed }, t.ok ? {} : { ok: false, error: t.error });
  }

  function syncNow() {
    return queue(runSync);
  }

  function schedulePush() {
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
      queue(async () => {
        const a = await getAccount();
        if (!a) return;
        if (a.dirty) await push(a);
        const b = await getAccount();   // push() signs out on a rejected token
        if (b && b.tgDirty) await syncTelegram();
      }).catch(() => {});
    }, PUSH_DELAY_MS);
  }

  /* Called by the popup after it saves settings locally. */
  async function markDirty() {
    const a = await getAccount();
    if (!a) return { ok: true, signedIn: false };
    a.seq = (a.seq || 0) + 1;
    a.dirty = true;
    await putAccount(a);
    schedulePush();
    return { ok: true, signedIn: true };
  }

  /* Called by the background worker after the Telegram connection is saved or removed. */
  async function markTelegramDirty() {
    const a = await getAccount();
    if (!a) return { ok: true, signedIn: false };
    a.tgSeq = (a.tgSeq || 0) + 1;
    a.tgDirty = true;
    await putAccount(a);
    schedulePush();
    return { ok: true, signedIn: true };
  }

  /* ---------- account actions ---------- */

  async function signUp(email, password) {
    return queue(async () => {
      const defaults = await localDefaults();
      const r = await call('/signup', { method: 'POST', body: { email, password, settings: defaults ? forServer(defaults) : null } });
      if (!r.ok) return failure(r);
      await putAccount({ email: r.data.email, token: r.data.token, rev: r.data.rev || 0, dirty: false, seq: 0, lastSync: Date.now() });
      await ensureAlarm();
      const t = await syncTelegram();      // a new account takes this computer's bot, if it has one
      return { ok: true, email: r.data.email, seeded: !!defaults, telegramChanged: !!t.changed };
    });
  }

  async function logIn(email, password) {
    return queue(async () => {
      const r = await call('/login', { method: 'POST', body: { email, password } });
      if (!r.ok) return failure(r);
      const acct = { email: r.data.email, token: r.data.token, rev: r.data.rev || 0, dirty: false, seq: 0, lastSync: Date.now() };
      let adopted = false;
      let defaults = null;
      if (r.data.settings) {
        // the account already has settings: they win over whatever this computer had
        defaults = await adoptRemote(r.data.settings);
        adopted = true;
      } else {
        const local = await localDefaults();
        if (local) {
          const p = await call('/settings', { method: 'PUT', token: acct.token, body: { settings: forServer(local) } });
          if (p.ok) acct.rev = p.data.rev;
        }
      }
      await putAccount(acct);
      await ensureAlarm();
      const t = await syncTelegram();      // the account's bot comes with the login (best effort; retried on the next sync)
      return { ok: true, email: acct.email, adopted, defaults, telegramChanged: !!t.changed };
    });
  }

  async function logOut() {
    return queue(async () => {
      const acct = await getAccount();
      if (acct) await call('/logout', { method: 'POST', token: acct.token }); // best effort
      await dropAccount();
      return { ok: true };
    });
  }

  async function deleteAccount(password) {
    return queue(async () => {
      const acct = await getAccount();
      if (!acct) return { ok: false, signedOut: true, error: 'Not signed in.' };
      const r = await call('/account', { method: 'DELETE', token: acct.token, body: { password } });
      if (r.status === 401 && /log in again/i.test(r.error || '')) return expire();
      if (!r.ok) return failure(r);
      await dropAccount();
      return { ok: true };
    });
  }

  /* Never includes the token. */
  async function status() {
    const a = await getAccount();
    if (!a) return { signedIn: false };
    return { signedIn: true, email: a.email, dirty: !!(a.dirty || a.tgDirty), lastSync: a.lastSync || 0, error: a.error || null };
  }

  /* The popup waits on these replies, so they must never throw. */
  const safe = (fn) => async (...args) => {
    try { return await fn(...args); }
    catch (e) { return { ok: false, error: 'Something went wrong. Please try again.' }; }
  };

  root.LynchSync = {
    ALARM,
    API,
    ensureAlarm: safe(ensureAlarm),
    syncNow: safe(syncNow),
    markDirty: safe(markDirty),
    markTelegramDirty: safe(markTelegramDirty),
    signUp: safe(signUp),
    logIn: safe(logIn),
    logOut: safe(logOut),
    deleteAccount: safe(deleteAccount),
    status: safe(status)
  };
})(self);
