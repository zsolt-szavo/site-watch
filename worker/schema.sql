CREATE TABLE IF NOT EXISTS watches (
  id           TEXT PRIMARY KEY,
  device_id    TEXT,              -- owner: random id kept by the PWA (X-Device-Id); NULL = orphaned
  url          TEXT NOT NULL,
  name         TEXT NOT NULL,
  selector     TEXT,              -- optional CSS selector to narrow the watched part
  contains     TEXT,              -- optional: only alert when this text appears/disappears
  ignore       TEXT NOT NULL DEFAULT '[]',  -- JSON array of regexes for noisy lines
  mode         TEXT NOT NULL DEFAULT 'auto', -- auto | plain | browser | feed
  created_at   TEXT NOT NULL,
  last_checked TEXT,
  last_change  TEXT,
  last_hash    TEXT,
  last_text    TEXT,
  last_diff    TEXT,
  last_error   TEXT
);
CREATE TABLE IF NOT EXISTS subscriptions (
  endpoint   TEXT NOT NULL,
  watch_id   TEXT NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
  keys       TEXT NOT NULL,       -- JSON {p256dh, auth}
  created_at TEXT NOT NULL,
  PRIMARY KEY (endpoint, watch_id)
);
CREATE INDEX IF NOT EXISTS watches_by_device ON watches(device_id);
CREATE INDEX IF NOT EXISTS subs_by_watch ON subscriptions(watch_id);
CREATE TABLE IF NOT EXISTS meta (   -- small key/value state, e.g. last_dispatch (ISO time the check workflow was last started)
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
-- Page screenshots from the checker. kind: 'baseline' (first check), 'change' (a check that found a change,
-- with its diff), 'latest' (the most recent check, one per watch). Baseline + changes form the history, of
-- which the newest SHOT_HISTORY are kept. Kept out of `watches` so the list query stays small.
CREATE TABLE IF NOT EXISTS shots (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  watch_id TEXT NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
  kind     TEXT NOT NULL CHECK (kind IN ('baseline', 'change', 'latest')),
  taken_at TEXT NOT NULL,
  diff     TEXT,
  jpeg     BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS shots_by_watch ON shots(watch_id, kind);
-- Versions of the page text, like the screenshot history: kind 'baseline' (the first check) or 'change' (a check
-- that found a change, with its diff); the newest SHOT_HISTORY are kept. The newest one is what the page says now.
CREATE TABLE IF NOT EXISTS text_versions (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  watch_id TEXT NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
  kind     TEXT NOT NULL CHECK (kind IN ('baseline', 'change')),
  taken_at TEXT NOT NULL,
  diff     TEXT,
  text     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS text_versions_by_watch ON text_versions(watch_id);
