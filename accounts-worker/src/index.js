// Auto Refresh accounts: optional login + settings sync.
//
// What is stored per user: email, a salted+peppered password hash, one JSON row of
// saved settings (interval, time windows, options) and, if they connected one, their
// Telegram bot connection, encrypted. The time zone and account name are per computer
// and never stored. Nothing about the pages being refreshed ever reaches this server —
// the extension does not send it and the validator below would drop it anyway.

import ADMIN_HTML from "./admin.html";

// Unpacked extensions get a different ID on every machine, so any well-formed
// extension ID is accepted. localhost is only for testing the popup in a page.
const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;
const DEV_ORIGINS = new Set(["http://localhost:8793", "http://127.0.0.1:8793"]);

const MAX_BODY = 8192;        // bytes; settings are tiny, so anything bigger is abuse
const SESSION_DAYS = 90;
const PBKDF2_ITER = 100000;   // Workers' WebCrypto maximum
const DAY = 86400000;
const LOCK_AFTER = 6;            // wrong passwords on one account...
const LOCK_WINDOW = 15 * 60000;  // ...within 15 minutes lock it for the rest of that window

const TZ_IDS = [
  "America/New_York", "America/Chicago", "America/Denver", "America/Phoenix",
  "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu",
];

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const randomHex = (bytes) => hex(crypto.getRandomValues(new Uint8Array(bytes)));
const sha256Hex = async (s) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/* HMAC with the server-side pepper first, then PBKDF2: a stolen database on its
   own cannot be brute-forced, because the pepper lives only as a Worker secret. */
async function hashPassword(password, saltHex, iterations, pepper) {
  const hkey = await crypto.subtle.importKey("raw", enc.encode(pepper), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const peppered = await crypto.subtle.sign("HMAC", hkey, enc.encode(password));
  const key = await crypto.subtle.importKey("raw", peppered, "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: enc.encode(saltHex), iterations },
    key,
    256
  );
  return hex(bits);
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(body, status, cors) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors },
  });
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function readJson(request) {
  const text = await request.text();
  if (text.length > MAX_BODY) throw new HttpError(413, "That request is too large.");
  let body;
  try { body = JSON.parse(text || "{}"); } catch { throw new HttpError(400, "Bad request."); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "Bad request.");
  return body;
}

function normEmail(v) {
  if (typeof v !== "string") return null;
  const e = v.trim().toLowerCase();
  if (e.length < 5 || e.length > 254) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) ? e : null;
}

function int(v, min, max) {
  if (v === null || v === undefined || v === "" || typeof v === "boolean") return null;
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : null;
}

// Like int(), but an out-of-range value is rejected rather than clamped into place
// (a day "9" must not quietly become Saturday).
function strictInt(v, min, max) {
  const n = int(v, -1e12, 1e12);
  return n !== null && n >= min && n <= max ? n : null;
}

function cleanWords(v) {
  if (!Array.isArray(v)) return [];
  const seen = new Set();
  const out = [];
  for (const w of v) {
    if (typeof w !== "string") continue;
    const t = w.trim().slice(0, 60);
    if (t && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); out.push(t); }
    if (out.length >= 10) break;
  }
  return out;
}

/* Strict allow-list: only the fields the extension saves survive, each coerced
   to its expected type and range. Returns null when the shape is unusable. */
function cleanSettings(s) {
  if (!s || typeof s !== "object" || Array.isArray(s)) return null;
  const interval = int(s.intervalMs, 1000, 7 * DAY);
  if (interval === null) return null;

  const r = s.range && typeof s.range === "object" ? s.range : {};
  let lo = int(r.minMs, 1000, 7 * DAY) ?? 250000;
  let hi = int(r.maxMs, 1000, 7 * DAY) ?? 300000;
  if (lo > hi) [lo, hi] = [hi, lo];

  const sc = s.schedule && typeof s.schedule === "object" ? s.schedule : {};
  const windows = Array.isArray(sc.windows)
    ? sc.windows
        .map((w) => ({ from: strictInt(w && w.from, 0, 1439), to: strictInt(w && w.to, 0, 1439) }))
        .filter((w) => w.from !== null && w.to !== null)
        .slice(0, 7)
    : [];
  const days = Array.isArray(sc.days)
    ? [...new Set(sc.days.map((d) => strictInt(d, 0, 6)).filter((d) => d !== null))].sort()
    : [];

  return {
    intervalMs: interval,
    hardRefresh: !!s.hardRefresh,
    notifyOnChange: !!s.notifyOnChange,
    sound: !!s.sound,
    jitter: !!s.jitter,
    pageTimer: !!s.pageTimer,
    humanBlock: s.humanBlock === undefined ? true : !!s.humanBlock,
    pauseOnHuman: s.pauseOnHuman === undefined ? true : !!s.pauseOnHuman,
    humanize: !!s.humanize,
    humanClicks: s.humanClicks === undefined ? true : !!s.humanClicks,
    humanWords: cleanWords(s.humanWords),
    range: { enabled: !!r.enabled, minMs: lo, maxMs: hi },
    schedule: {
      enabled: !!sc.enabled,
      days,
      windows,
    },
  };
}

async function newSession(env, userId) {
  const token = randomHex(32);
  const now = Date.now();
  await env.DB.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256Hex(token), userId, now, now + SESSION_DAYS * DAY)
    .run();
  return token;
}

async function authUser(request, env) {
  const m = /^Bearer ([0-9a-f]{64})$/.exec(request.headers.get("Authorization") || "");
  if (!m) throw new HttpError(401, "Please log in again.");
  const hash = await sha256Hex(m[1]);
  const row = await env.DB.prepare(
    "SELECT s.user_id AS id, s.expires_at AS exp, u.email AS email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?"
  ).bind(hash).first();
  if (!row || row.exp < Date.now()) throw new HttpError(401, "Please log in again.");
  return { id: row.id, email: row.email, tokenHash: hash };
}

async function getSettings(env, userId) {
  const row = await env.DB.prepare("SELECT data, updated_at FROM settings WHERE user_id = ?").bind(userId).first();
  if (!row) return { settings: null, rev: 0 };
  let settings = null;
  try { settings = JSON.parse(row.data); } catch {}
  // the time zone is per computer and is never part of an account (older rows may still carry one)
  if (settings && settings.schedule) delete settings.schedule.tz;
  return { settings, rev: row.updated_at };
}

async function saveSettings(env, userId, settings) {
  // MAX(...) keeps the revision strictly increasing even if two writes share a millisecond.
  await env.DB.prepare(
    "INSERT INTO settings (user_id, data, updated_at) VALUES (?, ?, ?) " +
    "ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = MAX(excluded.updated_at, settings.updated_at + 1)"
  ).bind(userId, JSON.stringify(settings), Date.now()).run();
  return (await getSettings(env, userId)).rev;
}

/* ---------- Telegram connection (the one secret that syncs) ----------
   Encrypted before it reaches D1: AES-256-GCM, key derived (HKDF) from the PEPPER
   Worker secret, ciphertext bound to the user id. A copy of the database alone shows
   nothing readable. It is not end-to-end: this server holds the key, because it has to
   hand the connection back to the user's other computers. */
const TOKEN_RE = /^\d{6,12}:[A-Za-z0-9_-]{30,60}$/;
const CHAT_RE = /^-?\d{5,20}$/;
const toB64 = (bytes) => btoa(String.fromCharCode(...bytes));
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function tgKey(env) {
  const base = await crypto.subtle.importKey("raw", enc.encode(env.PEPPER), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: enc.encode("autorefresh-telegram"), info: enc.encode("telegram-v1") },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

function cleanTelegram(t) {
  if (!t || typeof t !== "object") return null;
  const token = typeof t.token === "string" ? t.token.trim() : "";
  const chatId = typeof t.chatId === "string" || typeof t.chatId === "number" ? String(t.chatId).trim() : "";
  if (!TOKEN_RE.test(token) || !CHAT_RE.test(chatId)) return null;
  const bot = typeof t.bot === "string" && /^@?[A-Za-z0-9_]{1,40}$/.test(t.bot) ? t.bot : "";
  return { token, chatId, bot };
}

async function getTelegram(env, userId) {
  const row = await env.DB.prepare("SELECT data, updated_at FROM telegram WHERE user_id = ?").bind(userId).first();
  if (!row) return { telegram: null, rev: 0 };
  if (!row.data) return { telegram: null, rev: row.updated_at };
  try {
    const [iv, ct] = row.data.split(".").map(fromB64);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: enc.encode("tg:" + userId) },
      await tgKey(env),
      ct
    );
    return { telegram: cleanTelegram(JSON.parse(new TextDecoder().decode(plain))), rev: row.updated_at };
  } catch {
    // An error, not "disconnected": a failed decrypt must never make a computer drop its bot.
    console.error("telegram decrypt failed");
    throw new HttpError(500, "Something went wrong. Please try again.");
  }
}

async function saveTelegram(env, userId, tg) {
  let data = null;
  if (tg) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: enc.encode("tg:" + userId) },
      await tgKey(env),
      enc.encode(JSON.stringify(tg))
    ));
    data = toB64(iv) + "." + toB64(ct);
  }
  await env.DB.prepare(
    "INSERT INTO telegram (user_id, data, updated_at) VALUES (?, ?, ?) " +
    "ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = MAX(excluded.updated_at, telegram.updated_at + 1)"
  ).bind(userId, data, Date.now()).run();
  const row = await env.DB.prepare("SELECT updated_at FROM telegram WHERE user_id = ?").bind(userId).first();
  return row.updated_at;
}

/* Exact per-account protection. The Cloudflare limiter below is approximate and
   can miss slow, steady guessing; this counts every wrong password in D1. */
async function lockedUntil(env, email) {
  const row = await env.DB.prepare("SELECT n, window_start FROM login_attempts WHERE email = ?").bind(email).first();
  return row && row.n >= LOCK_AFTER && Date.now() - row.window_start < LOCK_WINDOW ? row.window_start + LOCK_WINDOW : 0;
}

async function noteFailure(env, email) {
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO login_attempts (email, n, window_start) VALUES (?, 1, ?) " +
    "ON CONFLICT(email) DO UPDATE SET " +
    "n = CASE WHEN ? - login_attempts.window_start >= ? THEN 1 ELSE login_attempts.n + 1 END, " +
    "window_start = CASE WHEN ? - login_attempts.window_start >= ? THEN ? ELSE login_attempts.window_start END"
  ).bind(email, now, now, LOCK_WINDOW, now, LOCK_WINDOW, now).run();
}

async function limit(env, key) {
  if (!env.AUTH_LIMITER) return true;
  const { success } = await env.AUTH_LIMITER.limit({ key });
  return success;
}

/* HMAC-SHA256 hex of msg with a secret: used for the unsubscribe links in update emails. */
async function hmacHex(secret, msg) {
  const k = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
}

/* One email through the owner's Google Apps Script sender (the same one the agency site uses). */
async function sendMail(env, to, subject, body) {
  if (!env.MAIL_WEBHOOK_URL || !env.MAIL_SECRET) throw new HttpError(503, "Email sending isn't set up.");
  try {
    const r = await fetch(env.MAIL_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ type: "account_message", secret: env.MAIL_SECRET, to, subject, body }),
      redirect: "follow",
    });
    const d = await r.json();
    return !!(d && d.success);
  } catch { return false; }
}

const cleanMessage = (b) => {
  const subject = typeof b.subject === "string" ? b.subject.trim().slice(0, 150) : "";
  const body = typeof b.body === "string" ? b.body.trim().slice(0, 6000) : "";
  if (!subject || !body) throw new HttpError(400, "Write a subject and a message.");
  return { subject, body };
};

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    // the owner dashboard (GET /admin) calls this same server, so its own origin is fine too
    const allowed = EXTENSION_ORIGIN.test(origin) || DEV_ORIGINS.has(origin) || origin === new URL(request.url).origin;
    // A request with no Origin (curl, a browser address bar) is fine: every
    // route is token-protected. A request from some other website is not.
    if (origin && !allowed) return new Response("Forbidden", { status: 403 });
    const cors = allowed ? corsHeaders(origin) : {};

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const path = new URL(request.url).pathname.replace(/\/+$/, "") || "/";
    const method = request.method;

    try {
      if (!env.DB || !env.PEPPER) throw new HttpError(503, "Accounts aren't set up yet.");

      /* ---------- anonymous install counter ---------- */
      if (method === "POST" && path === "/ping") {
        const ip = request.headers.get("CF-Connecting-IP") || "unknown";
        if (!(await limit(env, "ping:" + ip))) throw new HttpError(429, "Slow down.");
        const b = await readJson(request);
        const id = typeof b.id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(b.id) ? b.id : null;
        const v = typeof b.v === "string" && /^\d{1,3}(\.\d{1,3}){1,3}$/.test(b.v) ? b.v : null;
        if (!id || !v) throw new HttpError(400, "Bad request.");
        const now = Date.now();
        await env.DB.prepare(
          "INSERT INTO installs (id, first_seen, last_seen, version, pings) VALUES (?, ?, ?, ?, 1) " +
          "ON CONFLICT(id) DO UPDATE SET last_seen = excluded.last_seen, version = excluded.version, " +
          "pings = installs.pings + (CASE WHEN excluded.last_seen - installs.last_seen > 21600000 THEN 1 ELSE 0 END)"
        ).bind(id, now, now, v).run();
        return json({ ok: true }, 200, cors);
      }

      /* ---------- unsubscribe from update emails (a button, so a mail scanner opening the link changes nothing) ---------- */
      if (path === "/unsubscribe" && (method === "GET" || method === "POST")) {
        const u = new URL(request.url);
        const email = normEmail(u.searchParams.get("e"));
        const t = u.searchParams.get("t") || "";
        const page = (msg, form) => new Response(
          '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Auto Refresh emails</title>' +
          '<body style="font:16px/1.6 system-ui,sans-serif;background:#fbf6ef;color:#3a2a20;display:grid;place-items:center;min-height:100vh;margin:0"><div style="background:#fff;border:1px solid #e8d9c6;border-radius:16px;padding:28px;max-width:420px;margin:16px">' +
          '<h2 style="margin:0 0 8px">Auto Refresh emails</h2><p style="margin:0 0 16px;color:#6f5e52">' + msg + "</p>" + (form || "") + "</div>",
          { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'" } }
        );
        if (!email || !env.ADMIN_KEY || !timingSafeEqual(t, await hmacHex(env.ADMIN_KEY, "unsub:" + email))) return page("That link isn't valid.");
        if (method === "POST") {
          await env.DB.prepare("UPDATE users SET email_updates = 0 WHERE email = ?").bind(email).run();
          return page("Done. You won't get update emails from Auto Refresh any more. Your account and settings are untouched.");
        }
        return page("Stop update emails to this address? You can still use your account as normal.",
          '<form method="POST"><button style="font:inherit;font-weight:700;padding:10px 18px;border-radius:10px;border:0;background:#e0813a;color:#3a1b08;cursor:pointer">Yes, unsubscribe</button></form>');
      }

      /* ---------- owner dashboard ---------- */
      // The page itself holds no data; it asks for the admin key, then calls /admin/users.
      if (method === "GET" && path === "/admin") {
        return new Response(ADMIN_HTML, {
          status: 200,
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Robots-Tag": "noindex, nofollow",
            "X-Frame-Options": "DENY",
            "Referrer-Policy": "no-referrer",
            "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
          },
        });
      }

      // Admin key: Authorization header (preferred) or ?key= (older). Throttled per IP, and a wrong
      // key looks exactly like a missing page.
      // A signed-in computer carries a 30-day cookie: "<expiry>.<HMAC of it with the admin key>". HttpOnly, so
      // scripts on the page can never read it; SameSite=Strict plus a required header guards deletes.
      const adminToken = async (exp) => hex(await crypto.subtle.sign(
        "HMAC",
        await crypto.subtle.importKey("raw", enc.encode(env.ADMIN_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
        enc.encode("admin-session:" + exp)
      ));
      let viaCookie = false; // a cookie sign-in is renewed on use, so it never runs out while it is being used
      const cookieHeader = async () => {
        const exp = Date.now() + 365 * DAY;
        return "__Host-adm=" + exp + "." + (await adminToken(exp)) + "; Path=/; Max-Age=" + 365 * 86400 + "; HttpOnly; Secure; SameSite=Strict";
      };
      const adminCheck = async (changes) => {
        const ip = request.headers.get("CF-Connecting-IP") || "unknown";
        if (!(await limit(env, "admin:" + ip))) throw new HttpError(429, "Too many tries. Wait a minute.");
        const ck = /(?:^|;\s*)__Host-adm=(\d{10,15})\.([0-9a-f]{64})/.exec(request.headers.get("Cookie") || "");
        if (ck && env.ADMIN_KEY && Number(ck[1]) > Date.now() && timingSafeEqual(ck[2], await adminToken(ck[1]))) {
          if (changes && request.headers.get("X-Admin") !== "1") throw new HttpError(403, "Forbidden.");
          viaCookie = true;
          return;
        }
        const h = /^Bearer (.+)$/.exec(request.headers.get("Authorization") || "");
        const key = h ? h[1] : new URL(request.url).searchParams.get("key") || "";
        if (!env.ADMIN_KEY || !timingSafeEqual(key, env.ADMIN_KEY)) throw new HttpError(404, "Not found.");
      };

      if (method === "POST" && path === "/admin/login") {
        const ip = request.headers.get("CF-Connecting-IP") || "unknown";
        if (!(await limit(env, "admin:" + ip))) throw new HttpError(429, "Too many tries. Wait a minute.");
        const body = await readJson(request);
        if (typeof body.email === "string") {
          // the owner signs in with the email + password of their normal Auto Refresh account
          const email = normEmail(body.email);
          const password = typeof body.password === "string" ? body.password : "";
          if (!email || !password || password.length > 200) throw new HttpError(401, "Wrong email or password.");
          if (await lockedUntil(env, email)) throw new HttpError(429, "Too many wrong passwords. Try again in 15 minutes.");
          const isOwner = !!env.ADMIN_EMAIL && email === normEmail(env.ADMIN_EMAIL);
          const row = isOwner ? await env.DB.prepare("SELECT pw_salt, pw_hash, pw_iter FROM users WHERE email = ?").bind(email).first() : null;
          let good = false;
          if (row) good = timingSafeEqual(await hashPassword(password, row.pw_salt, row.pw_iter, env.PEPPER), row.pw_hash);
          else await hashPassword(password, "0".repeat(32), PBKDF2_ITER, env.PEPPER); // same time for every other email
          // any other email gets the same answer as a wrong password: it never says who the owner is
          if (!good) { await noteFailure(env, email); throw new HttpError(401, "Wrong email or password."); }
          await env.DB.prepare("DELETE FROM login_attempts WHERE email = ?").bind(email).run();
        } else {
          const key = typeof body.key === "string" ? body.key : "";
          if (!env.ADMIN_KEY || !timingSafeEqual(key, env.ADMIN_KEY)) throw new HttpError(404, "Not found.");
        }
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Set-Cookie": await cookieHeader() },
        });
      }

      if (method === "POST" && path === "/admin/logout") {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json", "Set-Cookie": "__Host-adm=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict" },
        });
      }

      /* ---------- owner-only: delete one account and everything stored for it ---------- */
      if (method === "DELETE" && path === "/admin/users") {
        await adminCheck(true);
        const body = await readJson(request);
        const email = normEmail(body.email);
        if (!email) throw new HttpError(400, "Enter a valid email address.");
        const u = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
        if (!u) throw new HttpError(404, "No such user.");
        await env.DB.batch([
          env.DB.prepare("DELETE FROM settings WHERE user_id = ?").bind(u.id),
          env.DB.prepare("DELETE FROM telegram WHERE user_id = ?").bind(u.id),
          env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(u.id),
          env.DB.prepare("DELETE FROM users WHERE id = ?").bind(u.id),
          env.DB.prepare("DELETE FROM login_attempts WHERE email = ?").bind(email),
        ]);
        return json({ ok: true }, 200, cors);
      }

      /* ---------- owner-only: update emails to account holders ---------- */
      // Every email gets a footer with a personal unsubscribe link. A test goes only to the owner.
      const footer = async (email) => "\n\n--\nYou get this because you have an Auto Refresh account. Stop these emails: " +
        new URL(request.url).origin + "/unsubscribe?e=" + encodeURIComponent(email) + "&t=" + (await hmacHex(env.ADMIN_KEY, "unsub:" + email));

      if (method === "POST" && path === "/admin/announce/test") {
        await adminCheck(true);
        const m = cleanMessage(await readJson(request));
        const to = normEmail(env.ADMIN_EMAIL);
        if (!to) throw new HttpError(503, "No owner email is set.");
        const ok = await sendMail(env, to, "[TEST] " + m.subject, m.body + (await footer(to)));
        if (!ok) throw new HttpError(502, "The email sender did not accept it.");
        return json({ ok: true, to }, 200, cors);
      }

      if (method === "POST" && path === "/admin/announce") {
        await adminCheck(true);
        const m = cleanMessage(await readJson(request));
        const total = (await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE email_updates = 1").first()).n;
        const res = await env.DB.prepare("INSERT INTO announcements (created_at, subject, body, total) VALUES (?, ?, ?, ?)").bind(Date.now(), m.subject, m.body, total).run();
        return json({ id: res.meta.last_row_id, total, remaining: total }, 200, cors);
      }

      // sends the next few emails; the dashboard calls it until nothing remains
      if (method === "POST" && path === "/admin/announce/send") {
        await adminCheck(true);
        const b = await readJson(request);
        const ann = await env.DB.prepare("SELECT id, subject, body FROM announcements WHERE id = ?").bind(int(b.id, 1, 1e12)).first();
        if (!ann) throw new HttpError(404, "No such announcement.");
        const todo = (await env.DB.prepare(
          "SELECT email FROM users WHERE email_updates = 1 AND email NOT IN (SELECT email FROM announce_sent WHERE announcement_id = ?) LIMIT 8"
        ).bind(ann.id).all()).results || [];
        let sent = 0, failed = 0;
        for (const r of todo) {
          const ok = await sendMail(env, r.email, ann.subject, ann.body + (await footer(r.email)));
          await env.DB.prepare("INSERT OR IGNORE INTO announce_sent (announcement_id, email, ok) VALUES (?, ?, ?)").bind(ann.id, r.email, ok ? 1 : 0).run();
          ok ? sent++ : failed++;
        }
        await env.DB.prepare("UPDATE announcements SET sent = sent + ?, failed = failed + ? WHERE id = ?").bind(sent, failed, ann.id).run();
        const remaining = (await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM users WHERE email_updates = 1 AND email NOT IN (SELECT email FROM announce_sent WHERE announcement_id = ?)"
        ).bind(ann.id).first()).n;
        const totals = await env.DB.prepare("SELECT sent, failed FROM announcements WHERE id = ?").bind(ann.id).first();
        return json({ sent: totals.sent, failed: totals.failed, remaining }, 200, cors);
      }

      /* ---------- owner-only: every account (never passwords, tokens or Telegram secrets) ---------- */
      if (method === "GET" && path === "/admin/users") {
        await adminCheck();
        const now = Date.now();
        const rows = (await env.DB.prepare(
          "SELECT u.id, u.email, u.created_at AS created, " +
          "(SELECT MAX(created_at) FROM sessions s WHERE s.user_id = u.id) AS lastLogin, " +
          "(SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > ?) AS devices, " +
          "st.updated_at AS lastSync, st.data AS settings, " +
          "(SELECT COUNT(*) FROM telegram t WHERE t.user_id = u.id AND t.data IS NOT NULL) AS tg, u.email_updates AS eu " +
          "FROM users u LEFT JOIN settings st ON st.user_id = u.id ORDER BY u.created_at DESC LIMIT 5000"
        ).bind(now).all()).results || [];

        const users = rows.map((r) => {
          let c = {};
          try { c = r.settings ? JSON.parse(r.settings) : {}; } catch { c = {}; }
          const sc = c.schedule || {};
          return {
            email: r.email,
            created: r.created,
            lastLogin: r.lastLogin || null,
            lastSync: r.lastSync || null,
            devices: r.devices || 0,
            interval: c.intervalMs || null,
            range: c.range && c.range.enabled ? [c.range.minMs, c.range.maxMs] : null,
            windows: sc.enabled ? (Array.isArray(sc.windows) ? sc.windows.length : 0) : null,
            alerts: !!c.notifyOnChange,
            humanize: !!c.humanize,
            telegram: !!r.tg,
            updates: r.eu !== 0,
          };
        });

        const since = now - 30 * DAY;
        const byDay = new Map(
          ((await env.DB.prepare("SELECT date(created_at / 1000, 'unixepoch') AS d, COUNT(*) AS n FROM users WHERE created_at > ? GROUP BY d").bind(since).all()).results || [])
            .map((r) => [r.d, r.n])
        );
        const daily = [];
        for (let i = 29; i >= 0; i--) {
          const day = new Date(now - i * DAY).toISOString().slice(0, 10);
          daily.push({ day, n: byDay.get(day) || 0 });
        }

        // anonymous installs (extension 2.5.5+ pings once a day: random ID + version, nothing else)
        const cnt = async (sql, ...b) => (await env.DB.prepare(sql).bind(...b).first()).n;
        const instDays = new Map(
          ((await env.DB.prepare("SELECT date(first_seen / 1000, 'unixepoch') AS d, COUNT(*) AS n FROM installs WHERE first_seen > ? GROUP BY d").bind(since).all()).results || [])
            .map((r) => [r.d, r.n])
        );
        const installs = {
          total: await cnt("SELECT COUNT(*) AS n FROM installs"),
          active24h: await cnt("SELECT COUNT(*) AS n FROM installs WHERE last_seen > ?", now - DAY),
          active7d: await cnt("SELECT COUNT(*) AS n FROM installs WHERE last_seen > ?", now - 7 * DAY),
          active30d: await cnt("SELECT COUNT(*) AS n FROM installs WHERE last_seen > ?", now - 30 * DAY),
          new7d: await cnt("SELECT COUNT(*) AS n FROM installs WHERE first_seen > ?", now - 7 * DAY),
          versions: ((await env.DB.prepare("SELECT version, COUNT(*) AS n FROM installs GROUP BY version ORDER BY n DESC LIMIT 12").all()).results || []),
          daily: Array.from({ length: 30 }, (_, i) => { const day = new Date(now - (29 - i) * DAY).toISOString().slice(0, 10); return { day, n: instDays.get(day) || 0 }; }),
          recent: ((await env.DB.prepare("SELECT id, version, first_seen AS firstSeen, last_seen AS lastSeen, pings FROM installs ORDER BY last_seen DESC LIMIT 200").all()).results || [])
            .map((r) => ({ ...r, id: r.id.slice(0, 8) })),
        };
        const out = json({
          installs,
          emailUsers: users.filter((u) => u.updates).length,
          stats: {
            users: users.length,
            signups24h: users.filter((u) => u.created > now - DAY).length,
            signups7d: users.filter((u) => u.created > now - 7 * DAY).length,
            signups30d: users.filter((u) => u.created > since).length,
            activeSessions: users.reduce((n, u) => n + u.devices, 0),
            withTelegram: users.filter((u) => u.telegram).length,
            humanizeOn: users.filter((u) => u.humanize).length,
            alertsOn: users.filter((u) => u.alerts).length,
          },
          daily,
          users,
        }, 200, cors);
        if (viaCookie) out.headers.append("Set-Cookie", await cookieHeader()); // renew for another year
        return out;
      }

      /* ---------- owner-only counts ---------- */
      if (method === "GET" && path === "/admin/stats") {
        await adminCheck();
        const now = Date.now();
        const one = async (sql, ...b) => (await env.DB.prepare(sql).bind(...b).first()).n;
        return json({
          users: await one("SELECT COUNT(*) AS n FROM users"),
          signupsLast24h: await one("SELECT COUNT(*) AS n FROM users WHERE created_at > ?", now - DAY),
          signupsLast7d: await one("SELECT COUNT(*) AS n FROM users WHERE created_at > ?", now - 7 * DAY),
          withSavedSettings: await one("SELECT COUNT(*) AS n FROM settings"),
          withTelegram: await one("SELECT COUNT(*) AS n FROM telegram WHERE data IS NOT NULL"),
          activeSessions: await one("SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ?", now),
        }, 200, cors);
      }

      /* ---------- create account ---------- */
      if (method === "POST" && path === "/signup") {
        const ip = request.headers.get("CF-Connecting-IP") || "unknown";
        if (!(await limit(env, "ip:" + ip))) throw new HttpError(429, "Too many tries. Wait a minute and try again.");
        const body = await readJson(request);
        const email = normEmail(body.email);
        const password = typeof body.password === "string" ? body.password : "";
        if (!email) throw new HttpError(400, "Enter a valid email address.");
        if (password.length < 8 || password.length > 200) throw new HttpError(400, "Your password needs at least 8 characters.");
        let settings = null;
        if (body.settings !== undefined && body.settings !== null) {
          settings = cleanSettings(body.settings);
          if (!settings) throw new HttpError(400, "Those settings couldn't be saved.");
        }

        if (await env.DB.prepare("SELECT 1 AS x FROM users WHERE email = ?").bind(email).first()) {
          throw new HttpError(409, "That email already has an account. Try logging in.");
        }
        const salt = randomHex(16);
        const hash = await hashPassword(password, salt, PBKDF2_ITER, env.PEPPER);
        let userId;
        try {
          const res = await env.DB.prepare(
            "INSERT INTO users (email, pw_salt, pw_hash, pw_iter, created_at) VALUES (?, ?, ?, ?, ?)"
          ).bind(email, salt, hash, PBKDF2_ITER, Date.now()).run();
          userId = res.meta.last_row_id;
        } catch {
          throw new HttpError(409, "That email already has an account. Try logging in.");
        }
        let rev = 0;
        if (settings) rev = await saveSettings(env, userId, settings);
        const token = await newSession(env, userId);
        return json({ token, email, settings: null, rev }, 201, cors);
      }

      /* ---------- log in ---------- */
      if (method === "POST" && path === "/login") {
        const ip = request.headers.get("CF-Connecting-IP") || "unknown";
        if (!(await limit(env, "ip:" + ip))) throw new HttpError(429, "Too many tries. Wait a minute and try again.");
        const body = await readJson(request);
        const email = normEmail(body.email);
        const password = typeof body.password === "string" ? body.password : "";
        if (!email || !password || password.length > 200) throw new HttpError(401, "Wrong email or password.");
        if (!(await limit(env, "login:" + email))) throw new HttpError(429, "Too many tries. Wait a minute and try again.");

        if (await lockedUntil(env, email)) throw new HttpError(429, "Too many wrong passwords for this account. Try again in 15 minutes.");
        const user = await env.DB.prepare("SELECT id, pw_salt, pw_hash, pw_iter FROM users WHERE email = ?").bind(email).first();
        let ok = false;
        if (user) {
          ok = timingSafeEqual(await hashPassword(password, user.pw_salt, user.pw_iter, env.PEPPER), user.pw_hash);
        } else {
          // burn the same time for unknown emails so response speed doesn't reveal them
          await hashPassword(password, "0".repeat(32), PBKDF2_ITER, env.PEPPER);
        }
        if (!ok) {
          await noteFailure(env, email); // unknown emails too, so a lockout never reveals whether an account exists
          throw new HttpError(401, "Wrong email or password.");
        }
        await env.DB.prepare("DELETE FROM login_attempts WHERE email = ?").bind(email).run();

        await env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND expires_at < ?").bind(user.id, Date.now()).run();
        const token = await newSession(env, user.id);
        const { settings, rev } = await getSettings(env, user.id);
        return json({ token, email, settings, rev }, 200, cors);
      }

      /* ---------- everything below needs a session ---------- */
      const user = await authUser(request, env);

      if (method === "POST" && path === "/logout") {
        await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(user.tokenHash).run();
        return json({ ok: true }, 200, cors);
      }

      if (method === "GET" && path === "/settings") {
        return json(await getSettings(env, user.id), 200, cors);
      }

      if (method === "PUT" && path === "/settings") {
        const body = await readJson(request);
        const settings = cleanSettings(body.settings);
        if (!settings) throw new HttpError(400, "Those settings couldn't be saved.");
        return json({ rev: await saveSettings(env, user.id, settings) }, 200, cors);
      }

      if (method === "GET" && path === "/telegram") {
        return json(await getTelegram(env, user.id), 200, cors);
      }

      if (method === "PUT" && path === "/telegram") {
        const body = await readJson(request);
        if (body.telegram === undefined) throw new HttpError(400, "That Telegram connection couldn't be saved.");
        let tg = null; // null = disconnect
        if (body.telegram !== null) {
          tg = cleanTelegram(body.telegram);
          if (!tg) throw new HttpError(400, "That Telegram connection couldn't be saved.");
        }
        return json({ rev: await saveTelegram(env, user.id, tg) }, 200, cors);
      }

      if (method === "DELETE" && path === "/account") {
        const body = await readJson(request);
        const password = typeof body.password === "string" ? body.password : "";
        const row = await env.DB.prepare("SELECT pw_salt, pw_hash, pw_iter FROM users WHERE id = ?").bind(user.id).first();
        const ok = row && password && password.length <= 200 &&
          timingSafeEqual(await hashPassword(password, row.pw_salt, row.pw_iter, env.PEPPER), row.pw_hash);
        if (!ok) throw new HttpError(401, "That password isn't right.");
        await env.DB.batch([
          env.DB.prepare("DELETE FROM settings WHERE user_id = ?").bind(user.id),
          env.DB.prepare("DELETE FROM telegram WHERE user_id = ?").bind(user.id),
          env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(user.id),
          env.DB.prepare("DELETE FROM users WHERE id = ?").bind(user.id),
          env.DB.prepare("DELETE FROM login_attempts WHERE email = ?").bind(user.email),
        ]);
        return json({ ok: true }, 200, cors);
      }

      throw new HttpError(404, "Not found.");
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status, cors);
      console.error("accounts error", String(err).slice(0, 300));
      return json({ error: "Something went wrong. Please try again." }, 500, cors);
    }
  },
};
