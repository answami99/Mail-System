CREATE TABLE scheduler_ticks (
  slot TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('dispatching','accepted','failed')),
  attempted_at INTEGER NOT NULL,
  finished_at INTEGER,
  http_status INTEGER,
  attempts INTEGER NOT NULL DEFAULT 1,
  lease TEXT NOT NULL,
  lease_until INTEGER NOT NULL
);
