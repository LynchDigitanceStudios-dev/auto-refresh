-- Auto Refresh accounts. Run with:
--   wrangler d1 execute autorefresh-accounts --remote --file=schema.sql
-- Safe to re-run (IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  email       TEXT    NOT NULL UNIQUE,      -- trimmed + lower-cased
  pw_salt     TEXT    NOT NULL,
  pw_hash     TEXT    NOT NULL,             -- PBKDF2 of HMAC(pepper, password)
  pw_iter     INTEGER NOT NULL,             -- iterations used, so they can be raised later
  created_at  INTEGER NOT NULL,             -- ms since epoch
  email_updates INTEGER NOT NULL DEFAULT 1  -- 0 = unsubscribed from update emails (added 2026-11-14; ALTER TABLE users ADD COLUMN email_updates INTEGER NOT NULL DEFAULT 1 on older databases)
);

-- Only the SHA-256 of a session token is stored, never the token itself.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT    PRIMARY KEY,
  user_id     INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- One row of saved settings per user. updated_at is a server-assigned revision:
-- devices compare it to know whether anything changed since they last synced.
CREATE TABLE IF NOT EXISTS settings (
  user_id     INTEGER PRIMARY KEY,
  data        TEXT    NOT NULL,             -- validated JSON
  updated_at  INTEGER NOT NULL
);

-- The Telegram bot connection, synced between a user's computers. It is a secret, so
-- "data" holds AES-GCM ciphertext (see tgKey in src/index.js), never the token itself.
-- data NULL = disconnected; updated_at is a server-assigned revision like settings.
CREATE TABLE IF NOT EXISTS telegram (
  user_id     INTEGER PRIMARY KEY,
  data        TEXT,
  updated_at  INTEGER NOT NULL
);

-- Wrong-password counter per email (exact lockout; see LOCK_AFTER in src/index.js).
CREATE TABLE IF NOT EXISTS login_attempts (
  email         TEXT    PRIMARY KEY,
  n             INTEGER NOT NULL,
  window_start  INTEGER NOT NULL
);

-- Anonymous install counter: one random ID per installed copy, pinged about once a day by extension 2.5.5+.
-- Holds only the random ID, the version and when it was seen. Never an email, never a page.
CREATE TABLE IF NOT EXISTS installs (
  id          TEXT    PRIMARY KEY,
  first_seen  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL,
  version     TEXT    NOT NULL,
  pings       INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_installs_seen ON installs(last_seen);

-- Update emails sent from the owner dashboard, and who already got each one (so a send can resume).
CREATE TABLE IF NOT EXISTS announcements (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  INTEGER NOT NULL,
  subject     TEXT    NOT NULL,
  body        TEXT    NOT NULL,
  total       INTEGER NOT NULL,
  sent        INTEGER NOT NULL DEFAULT 0,
  failed      INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS announce_sent (
  announcement_id INTEGER NOT NULL,
  email           TEXT    NOT NULL,
  ok              INTEGER NOT NULL,
  PRIMARY KEY (announcement_id, email)
);

-- Reviews (extension 2.6.0+). One per account, or one per install when posted without an account.
-- "name" is the only identity ever shown publicly (made from the email, never the email itself).
-- hidden = 1 removes it from the extension and the website without deleting it (owner dashboard).
CREATE TABLE IF NOT EXISTS reviews (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER,                         -- NULL when posted without an account
  install_id  TEXT,                            -- random id of the install that posted it
  email       TEXT,                            -- account holders only; owner dashboard only
  name        TEXT    NOT NULL,                -- public display name
  rating      INTEGER NOT NULL,                -- 1..5
  body        TEXT    NOT NULL DEFAULT '',     -- optional written review, max 500 characters
  version     TEXT,                            -- extension version that posted it
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  hidden      INTEGER NOT NULL DEFAULT 0,
  ip_hash     TEXT                             -- keyed hash, only used to cap new reviews per day
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_user ON reviews(user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_install ON reviews(install_id) WHERE install_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reviews_shown ON reviews(hidden, created_at);
