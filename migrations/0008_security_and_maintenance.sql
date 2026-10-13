CREATE TABLE IF NOT EXISTS share_unlock_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  share_id INTEGER NOT NULL,
  ip_hash TEXT NOT NULL,
  attempted_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (share_id) REFERENCES share_links(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_share_unlock_attempts_lookup
  ON share_unlock_attempts(share_id, ip_hash, attempted_at);

CREATE TABLE IF NOT EXISTS maintenance_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('verify_backup', 'restore_backup', 'delete_folder', 'reconcile_images')),
  target_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  progress INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  result_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_maintenance_jobs_created
  ON maintenance_jobs(created_at DESC);
