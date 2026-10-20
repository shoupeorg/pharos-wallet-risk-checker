CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  request_key TEXT NOT NULL UNIQUE,
  target TEXT NOT NULL,
  risk_level TEXT,
  coverage_status TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  engine_version TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS reports_captured_at ON reports(captured_at DESC);
