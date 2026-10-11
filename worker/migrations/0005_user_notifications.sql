ALTER TABLE members ADD COLUMN notifications_paused INTEGER NOT NULL DEFAULT 0 CHECK (notifications_paused IN (0,1));
CREATE TABLE key_blocks (
  user_id INTEGER NOT NULL, key_id TEXT NOT NULL REFERENCES access_keys(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL, PRIMARY KEY(user_id,key_id)
);
INSERT INTO key_blocks SELECT user_id,key_id,joined_at FROM members WHERE blocked=1;
CREATE TABLE blacklist (user_id INTEGER PRIMARY KEY, created_at INTEGER NOT NULL);
CREATE TABLE retired_codes (code_hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
