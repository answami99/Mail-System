PRAGMA foreign_keys = ON;
CREATE TABLE access_keys (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, code_hash TEXT NOT NULL UNIQUE,
  code_cipher TEXT NOT NULL, owner_id INTEGER, active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE members (
  user_id INTEGER PRIMARY KEY, key_id TEXT NOT NULL REFERENCES access_keys(id),
  label TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
  blocked INTEGER NOT NULL DEFAULT 0, joined_at INTEGER NOT NULL
);
CREATE INDEX members_key ON members(key_id, active);
CREATE TABLE states (
  user_id INTEGER PRIMARY KEY, stage TEXT NOT NULL, draft TEXT, expires INTEGER NOT NULL
);
CREATE TABLE credentials (
  key_id TEXT PRIMARY KEY REFERENCES access_keys(id), email_cipher TEXT NOT NULL,
  password_cipher TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
  paused INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0,
  last_checked INTEGER, status TEXT NOT NULL DEFAULT 'Awaiting first check',
  lease TEXT, lease_until INTEGER NOT NULL DEFAULT 0, last_slot TEXT
);
CREATE TABLE messages (
  id TEXT PRIMARY KEY, key_id TEXT NOT NULL REFERENCES access_keys(id),
  revision INTEGER NOT NULL, payload TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX messages_key ON messages(key_id, revision);
CREATE TABLE deliveries (
  id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
  lease_until INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0,
  telegram_id INTEGER, UNIQUE(message_id, user_id)
);
CREATE INDEX delivery_queue ON deliveries(state, retry_at, lease_until);
CREATE TABLE limits (bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE updates (id INTEGER PRIMARY KEY, state TEXT NOT NULL, expires INTEGER NOT NULL);
