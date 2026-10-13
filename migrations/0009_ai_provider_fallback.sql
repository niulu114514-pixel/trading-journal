INSERT OR IGNORE INTO app_config (config_key, config_value, description) VALUES
  ('ai_api_format', 'auto', 'AI API 格式：自动、Responses 或 Chat Completions'),
  ('ai_cf_fallback_enabled', 'true', '主模型不可用时启用 Cloudflare Workers AI'),
  ('ai_cf_fallback_model', '@cf/openai/gpt-oss-20b', 'Cloudflare Workers AI 备用模型');
