CREATE TABLE push_subscriptions (
  key_id TEXT PRIMARY KEY REFERENCES access_keys(id), revision INTEGER NOT NULL,
  generation TEXT NOT NULL UNIQUE, token_hash TEXT NOT NULL,
  subscription_hash TEXT, folder_hash TEXT, state TEXT NOT NULL DEFAULT 'provisioning',
  created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL DEFAULT 0, last_request INTEGER NOT NULL DEFAULT 0, callback_error TEXT,
  event_seq INTEGER NOT NULL DEFAULT 0, done_seq INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE push_receipts (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
CREATE TABLE push_dispatch (id TEXT PRIMARY KEY, requested_at INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0);
INSERT INTO push_dispatch(id) VALUES('events');
CREATE TABLE settings (id TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO settings VALUES('realtime_hours','always');
ALTER TABLE credentials ADD COLUMN push_generation TEXT;
ALTER TABLE credentials ADD COLUMN push_seq INTEGER;
