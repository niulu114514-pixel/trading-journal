CREATE TABLE IF NOT EXISTS ai_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('mindmap_refinement')),
  target_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed')),
  result_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_ai_jobs_created ON ai_jobs(created_at DESC);

CREATE TABLE IF NOT EXISTS ai_daily_usage (
  usage_date TEXT PRIMARY KEY,
  cf_requests INTEGER NOT NULL DEFAULT 0,
  cf_estimated_tokens INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO app_config (config_key, config_value, description) VALUES
  ('ai_cf_daily_request_limit', '20', 'Cloudflare 备用模型 UTC 每日调用上限'),
  ('ai_cf_daily_token_limit', '100000', 'Cloudflare 备用模型 UTC 每日估算 token 上限');

UPDATE app_config
SET config_value = '@cf/meta/llama-3.2-3b-instruct',
    description = 'Cloudflare Workers AI 备用模型'
WHERE config_key = 'ai_cf_fallback_model'
  AND config_value = '@cf/openai/gpt-oss-20b';
