/* Lynch Digitance — Auto Refresh: Telegram alerts (background service worker only).
 *
 * The extension talks to Telegram directly, with a bot you create yourself via
 * @BotFather. There is no server of ours in between for the alerts themselves.
 *
 * The bot token and chat ID live in chrome.storage.local under "telegram". They are
 * never part of the synced `defaults` object, never given to Lynch AI, and never
 * returned to the popup (status() only reports whether a bot is connected and its
 * @name). When the user is logged in, sync.js also keeps the connection on their
 * account (encrypted by the server) so their other computers can alert too.
 *
 * Nothing here runs until the user connects a bot, and then only when an alert
 * fires or they press Detect / Save / Send test.
 */
(function (root) {
  'use strict';

  const API = 'https://api.telegram.org/bot';
  const TOKEN_RE = /^\d{6,12}:[A-Za-z0-9_-]{30,60}$/;
  const CHAT_RE = /^-?\d{5,20}$/;

  /* One Bot API call. Errors are turned into plain-English messages. */
  async function call(token, method, body) {
    let res;
    try {
      res = await fetch(API + token + '/' + method, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {})
      });
    } catch (e) {
      return { ok: false, error: "Couldn't reach Telegram. Check your connection and try again." };
    }
    let data = null;
    try { data = await res.json(); } catch (e) {}
    if (res.ok && data && data.ok) return { ok: true, result: data.result };

    const desc = (data && data.description) || '';
    if (res.status === 401 || res.status === 404) return { ok: false, error: "Telegram didn't accept that bot token. Copy it again from @BotFather." };
    if (/chat not found/i.test(desc)) return { ok: false, error: "Telegram can't find that chat. Send your bot a message first, then press Detect chat ID." };
    if (/blocked by the user|bot was blocked/i.test(desc)) return { ok: false, error: 'You blocked this bot in Telegram. Unblock it and try again.' };
    if (res.status === 429) return { ok: false, error: 'Telegram says slow down. Try again in a minute.' };
    return { ok: false, error: desc || 'Telegram refused the request.' };
  }

  async function getConfig() {
    const s = await chrome.storage.local.get('telegram');
    return s.telegram || null;
  }

  /* Never includes the token or chat ID. */
  async function status() {
    const c = await getConfig();
    return c ? { connected: true, bot: c.bot || '' } : { connected: false };
  }

  /* Finds the most recent chat that messaged the bot, so the user doesn't have to
     dig out a numeric chat ID by hand. */
  async function detect(token) {
    token = String(token || '').trim();
    if (!TOKEN_RE.test(token)) return { ok: false, error: "That doesn't look like a bot token. It looks like 123456789:AA… and comes from @BotFather." };
    const r = await call(token, 'getUpdates', { limit: 20, timeout: 0 });
    if (!r.ok) return r;
    let found = null;
    for (const u of r.result || []) {
      const m = u.message || u.channel_post || u.edited_message || (u.my_chat_member && { chat: u.my_chat_member.chat });
      if (m && m.chat && m.chat.id !== undefined) found = m.chat;
    }
    if (!found) return { ok: false, error: 'No message found yet. Open your bot in Telegram, send it any message, then press Detect chat ID again.' };
    return { ok: true, chatId: String(found.id), name: found.first_name || found.title || found.username || '' };
  }

  /* Verifies the token and chat by sending a real message, and only then saves them. */
  async function save(token, chatId) {
    token = String(token || '').trim();
    chatId = String(chatId || '').trim();
    if (!TOKEN_RE.test(token)) return { ok: false, error: "That doesn't look like a bot token. It looks like 123456789:AA… and comes from @BotFather." };
    if (!CHAT_RE.test(chatId)) return { ok: false, error: 'The chat ID should be a number. Press Detect chat ID to fill it in.' };
    const me = await call(token, 'getMe');
    if (!me.ok) return me;
    const sent = await call(token, 'sendMessage', {
      chat_id: chatId,
      text: "✅ Auto Refresh is connected. You'll get a message here when a tab needs a human touch."
    });
    if (!sent.ok) return sent;
    const bot = me.result && me.result.username ? '@' + me.result.username : '';
    await chrome.storage.local.set({ telegram: { token, chatId, bot } });
    return { ok: true, bot };
  }

  /* Used by alerts. Quietly does nothing if no bot is connected. */
  async function send(text) {
    const c = await getConfig();
    if (!c) return { ok: false, skipped: true };
    return call(c.token, 'sendMessage', { chat_id: c.chatId, text: String(text).slice(0, 3500), disable_web_page_preview: true });
  }

  async function test() {
    const c = await getConfig();
    if (!c) return { ok: false, error: 'Connect a bot first.' };
    return send('🔔 Test from Auto Refresh. If you can read this, alerts will reach you here.');
  }

  async function off() {
    await chrome.storage.local.remove('telegram');
    return { ok: true };
  }

  /* The popup waits on these replies, so they must never throw. */
  const safe = (fn) => async (...a) => {
    try { return await fn(...a); }
    catch (e) { return { ok: false, error: 'Something went wrong. Please try again.' }; }
  };

  root.LynchAlerts = {
    TOKEN_RE, CHAT_RE,
    status: safe(status), detect: safe(detect), save: safe(save),
    send: safe(send), test: safe(test), off: safe(off)
  };
})(self);
