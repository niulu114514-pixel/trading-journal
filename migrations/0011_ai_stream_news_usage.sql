ALTER TABLE ai_messages ADD COLUMN analysis_json TEXT;
ALTER TABLE ai_messages ADD COLUMN provider TEXT;
ALTER TABLE ai_messages ADD COLUMN model TEXT;
ALTER TABLE ai_messages ADD COLUMN usage_json TEXT;

ALTER TABLE ai_daily_usage ADD COLUMN cf_actual_requests INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ai_daily_usage ADD COLUMN cf_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ai_daily_usage ADD COLUMN cf_output_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ai_daily_usage ADD COLUMN cf_neurons REAL NOT NULL DEFAULT 0;

INSERT OR IGNORE INTO app_config (config_key, config_value, description) VALUES
  ('ai_cf_daily_neuron_limit', '9000', 'Cloudflare Workers AI UTC 每日本系统神经元保护阈值'),
  ('ai_cf_account_id', '', '可选：用于动态获取 Workers AI 模型目录的 Cloudflare Account ID'),
  ('ai_cf_api_token', '', '可选：Workers AI Read 权限令牌，仅用于读取模型目录');
