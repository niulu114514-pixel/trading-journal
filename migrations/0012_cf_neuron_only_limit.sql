DELETE FROM app_config
WHERE config_key IN ('ai_cf_daily_request_limit', 'ai_cf_daily_token_limit');
