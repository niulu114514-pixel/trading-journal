-- Upgrade existing installations to the current minimal schema.
DROP TABLE IF EXISTS ai_messages;
DROP TABLE IF EXISTS ai_action_batches;
DROP TABLE IF EXISTS ai_conversations;
DROP TABLE IF EXISTS mindmap_refinement_drafts;
DROP TABLE IF EXISTS ai_jobs;
DROP TABLE IF EXISTS ai_daily_usage;

DELETE FROM app_config
WHERE config_key LIKE 'ai_%'
   OR config_key IN ('market_data_url', 'market_data_key');

ALTER TABLE trades DROP COLUMN chart_image;
ALTER TABLE trading_systems DROP COLUMN original_prompt;

-- This repository keeps only the current migration baseline.
DELETE FROM d1_migrations
WHERE name <> '0017_current_schema.sql';
