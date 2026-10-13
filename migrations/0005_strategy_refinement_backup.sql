CREATE TABLE IF NOT EXISTS trade_strategy_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_id INTEGER NOT NULL UNIQUE,
  system_id INTEGER,
  system_name TEXT NOT NULL,
  version_id INTEGER,
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (trade_id) REFERENCES trades(id) ON DELETE CASCADE,
  FOREIGN KEY (version_id) REFERENCES mindmap_versions(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS trade_rule_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_id INTEGER NOT NULL,
  rule_id INTEGER,
  rule_title_snapshot TEXT NOT NULL,
  rule_category_snapshot TEXT NOT NULL,
  rule_content_snapshot TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'not_applicable' CHECK (status IN ('followed','violated','not_applicable')),
  note TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (trade_id) REFERENCES trades(id) ON DELETE CASCADE,
  FOREIGN KEY (rule_id) REFERENCES trading_rules(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS mindmap_refinement_drafts (
  id TEXT PRIMARY KEY,
  system_id INTEGER NOT NULL,
  base_updated_at TEXT NOT NULL,
  base_snapshot_json TEXT NOT NULL,
  proposed_snapshot_json TEXT NOT NULL,
  diff_json TEXT NOT NULL,
  instructions TEXT,
  summary TEXT,
  model TEXT,
  usage_json TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','applied','discarded')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  applied_at TEXT,
  FOREIGN KEY (system_id) REFERENCES trading_systems(id) ON DELETE CASCADE
);

ALTER TABLE backups ADD COLUMN workflow_instance_id TEXT;
ALTER TABLE backups ADD COLUMN backup_mode TEXT NOT NULL DEFAULT 'incremental';
ALTER TABLE backups ADD COLUMN reused_object_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE backups ADD COLUMN verified_at TEXT;

CREATE INDEX IF NOT EXISTS idx_trade_strategy_snapshots_trade ON trade_strategy_snapshots(trade_id);
CREATE INDEX IF NOT EXISTS idx_trade_rule_checks_trade ON trade_rule_checks(trade_id, sort_order, id);
CREATE INDEX IF NOT EXISTS idx_trade_rule_checks_status ON trade_rule_checks(status, trade_id);
CREATE INDEX IF NOT EXISTS idx_refinement_drafts_system ON mindmap_refinement_drafts(system_id, created_at DESC);

INSERT OR IGNORE INTO app_config(config_key,config_value,description)
VALUES('backup_retention','7','自动保留最近多少份完整备份');
