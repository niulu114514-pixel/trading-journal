ALTER TABLE trading_systems ADD COLUMN original_prompt TEXT NOT NULL DEFAULT '';
ALTER TABLE trading_systems ADD COLUMN is_template INTEGER NOT NULL DEFAULT 0;

UPDATE trading_systems
SET original_prompt = COALESCE(NULLIF(TRIM(description), ''), name)
WHERE TRIM(COALESCE(original_prompt, '')) = '';

CREATE TABLE IF NOT EXISTS mindmap_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  system_id INTEGER NOT NULL,
  action TEXT NOT NULL DEFAULT 'manual',
  label TEXT,
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (system_id) REFERENCES trading_systems(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_trading_systems_template ON trading_systems(is_template, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_mindmap_versions_system ON mindmap_versions(system_id, id DESC);
