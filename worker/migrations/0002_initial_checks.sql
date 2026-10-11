CREATE TABLE initial_checks (
  id TEXT PRIMARY KEY, key_id TEXT NOT NULL REFERENCES access_keys(id),
  revision INTEGER NOT NULL, user_id INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending', lease TEXT,
  requested_at INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE INDEX initial_check_queue ON initial_checks(state, key_id, revision);
