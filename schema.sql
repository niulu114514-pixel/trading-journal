-- Trading Journal 当前版本数据库基线（不包含用户数据）
PRAGMA foreign_keys = ON;
PRAGMA defer_foreign_keys = TRUE;
BEGIN TRANSACTION;
CREATE TABLE trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 交易标的
  symbol TEXT NOT NULL DEFAULT 'XAUUSD',       -- 代码全称
  code TEXT,                                   -- 代码（如 XAUUSD → XAU）
  -- 基础信息
  entry_time TEXT NOT NULL DEFAULT (datetime('now')),  -- 开仓时间
  lots REAL NOT NULL DEFAULT 1.0,              -- 手数
  entry_price REAL,                            -- 开仓价格
  exit_price REAL,                             -- 平仓价格
  direction TEXT NOT NULL DEFAULT '多',          -- 多/空
  timeframe TEXT NOT NULL DEFAULT '5M',         -- 时间级别
  -- 交易类型分类
  trade_type TEXT,                              -- 交易类型: 高胜率低盈亏/高胜率高盈亏/低胜率高盈亏
  market_cycle TEXT,                            -- 市场周期: 极速突破/窄幅通道/宽幅通道/震荡区间/反转
  -- 技术分析
  patterns TEXT,                                -- 形态（多选，逗号分隔）
  trade_logic TEXT,                             -- 交易逻辑（为什么做这笔交易）
  -- 出场方式
  exit_type TEXT,                               -- 是否手动止盈: 目标自动止盈/符合规则手动止盈止损/恐惧手动止盈止损/止损点自动止损/贪婪利润回吐止损
  -- 结果统计
  return_amount REAL,                           -- 回报
  risk_reward_ratio REAL,                      -- 盈亏比（未填写时保持 NULL）
  result TEXT,                                  -- 胜/败/平
  -- 复盘总结
  review TEXT,                                  -- 反馈/复盘
  chart_image TEXT,                             -- K线图（base64 或 URL）

  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
, trading_system_id INTEGER REFERENCES trading_systems(id) ON DELETE SET NULL);
CREATE TABLE trading_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,                          -- 规则标题
  category TEXT NOT NULL DEFAULT '入场规则',     -- 分类: 入场规则/出场规则/资金管理/心态纪律/复盘总结
  content TEXT NOT NULL,                        -- 规则内容（富文本/markdown）
  tags TEXT,                                    -- 标签（逗号分隔）
  is_active INTEGER NOT NULL DEFAULT 1,         -- 是否启用
  priority INTEGER NOT NULL DEFAULT 0,          -- 优先级/重要程度
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE monthly_stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  month TEXT NOT NULL UNIQUE,                   -- 月份：YYYY-MM
  total_trades INTEGER NOT NULL DEFAULT 0,
  win_count INTEGER NOT NULL DEFAULT 0,
  loss_count INTEGER NOT NULL DEFAULT 0,
  total_return REAL NOT NULL DEFAULT 0,
  win_rate REAL NOT NULL DEFAULT 0,
  avg_rr REAL NOT NULL DEFAULT 0,
  profit_factor REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,            -- 分类: symbol / trade_type / market_cycle / pattern / exit_type / timeframe / rule_category
  label TEXT NOT NULL,               -- 显示名称
  value TEXT NOT NULL,               -- 选项值
  color TEXT,                        -- 颜色（可选）
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(category, value)
);
CREATE TABLE app_config (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  config_key TEXT NOT NULL UNIQUE,
  config_value TEXT,
  description TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE mcp_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,                -- 密钥名称
  token TEXT NOT NULL UNIQUE,        -- API 密钥的 SHA-256 摘要
  permissions TEXT NOT NULL DEFAULT 'read',  -- read / write / admin
  is_active INTEGER NOT NULL DEFAULT 1,
  last_used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,         -- 版本化 PBKDF2-SHA256
  salt TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip TEXT NOT NULL,
  attempted_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE share_unlock_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  share_id INTEGER NOT NULL,
  ip_hash TEXT NOT NULL,
  attempted_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (share_id) REFERENCES share_links(id) ON DELETE CASCADE
);
CREATE TABLE image_folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  color TEXT NOT NULL DEFAULT '#3ec9c5',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,            -- R2 key 或 TG file_id
  storage TEXT NOT NULL DEFAULT 'r2',  -- r2 / tg
  filename TEXT,
  mime_type TEXT,
  size INTEGER,
  tg_file_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
, public_id TEXT, caption TEXT, tg_message_id TEXT, display_name TEXT, category TEXT, tags TEXT, resource_url TEXT,
  folder_id INTEGER REFERENCES image_folders(id) ON DELETE SET NULL);
CREATE TABLE daily_chart_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_date TEXT NOT NULL UNIQUE,
  image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
  image_url TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_daily_chart_images_date ON daily_chart_images(trade_date);
CREATE TABLE share_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,
  target_type TEXT NOT NULL CHECK (target_type IN ('image', 'folder', 'mindmap')),
  target_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  password_hash TEXT,
  password_salt TEXT,
  expires_at TEXT,
  burn_after_read INTEGER NOT NULL DEFAULT 0,
  burned_at TEXT,
  burn_access_hash TEXT,
  access_count INTEGER NOT NULL DEFAULT 0,
  last_accessed_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE trading_systems (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  markets TEXT,
  timeframes TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'archived')),
  color TEXT NOT NULL DEFAULT '#3ec9c5',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
, category TEXT NOT NULL DEFAULT '交易系统', resource_url TEXT,
  original_prompt TEXT NOT NULL DEFAULT '',
  is_template INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS "trading_system_nodes" (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  system_id INTEGER NOT NULL,
  parent_id INTEGER,
  rule_id INTEGER,
  title TEXT NOT NULL,
  content TEXT,
  node_type TEXT NOT NULL DEFAULT 'condition',
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_collapsed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (system_id) REFERENCES trading_systems(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_id) REFERENCES "trading_system_nodes"(id) ON DELETE CASCADE,
  FOREIGN KEY (rule_id) REFERENCES trading_rules(id) ON DELETE SET NULL
);
CREATE TABLE mindmap_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  system_id INTEGER NOT NULL,
  action TEXT NOT NULL DEFAULT 'manual',
  label TEXT,
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (system_id) REFERENCES trading_systems(id) ON DELETE CASCADE
);
CREATE TABLE ai_conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '新对话',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE ai_action_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL,
  actions_json TEXT NOT NULL DEFAULT '[]',
  undo_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'rolled_back')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  rolled_back_at TEXT,
  FOREIGN KEY (conversation_id) REFERENCES ai_conversations(id) ON DELETE CASCADE
);
CREATE TABLE ai_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  actions_json TEXT,
  analysis_json TEXT,
  provider TEXT,
  model TEXT,
  usage_json TEXT,
  action_batch_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (conversation_id) REFERENCES ai_conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (action_batch_id) REFERENCES ai_action_batches(id) ON DELETE SET NULL
);
CREATE TABLE backups (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
  manifest_key TEXT,
  table_count INTEGER NOT NULL DEFAULT 0,
  row_count INTEGER NOT NULL DEFAULT 0,
  object_count INTEGER NOT NULL DEFAULT 0,
  total_size INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  workflow_instance_id TEXT,
  backup_mode TEXT NOT NULL DEFAULT 'incremental',
  reused_object_count INTEGER NOT NULL DEFAULT 0,
  verified_at TEXT
);
CREATE TABLE maintenance_jobs (
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
CREATE TABLE ai_jobs (
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
CREATE TABLE ai_daily_usage (
  usage_date TEXT PRIMARY KEY,
  cf_requests INTEGER NOT NULL DEFAULT 0,
  cf_estimated_tokens INTEGER NOT NULL DEFAULT 0,
  cf_actual_requests INTEGER NOT NULL DEFAULT 0,
  cf_input_tokens INTEGER NOT NULL DEFAULT 0,
  cf_output_tokens INTEGER NOT NULL DEFAULT 0,
  cf_neurons REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE trade_strategy_snapshots (
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
CREATE TABLE trade_rule_checks (
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
CREATE TABLE mindmap_refinement_drafts (
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
CREATE INDEX idx_trades_entry_time ON trades(entry_time);
CREATE INDEX idx_trades_symbol ON trades(symbol);
CREATE INDEX idx_trading_rules_category ON trading_rules(category);
CREATE INDEX idx_trading_rules_is_active ON trading_rules(is_active);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_login_attempts_ip ON login_attempts(ip, attempted_at);
CREATE INDEX idx_share_unlock_attempts_lookup ON share_unlock_attempts(share_id, ip_hash, attempted_at);
CREATE INDEX idx_images_key ON images(key);
CREATE UNIQUE INDEX idx_images_public_id ON images(public_id);
CREATE INDEX idx_trading_systems_status ON trading_systems(status);
CREATE INDEX idx_trades_trading_system ON trades(trading_system_id);
CREATE INDEX idx_images_category ON images(category);
CREATE INDEX idx_images_created_at ON images(created_at);
CREATE INDEX idx_images_folder ON images(folder_id, created_at DESC);
CREATE INDEX idx_image_folders_sort ON image_folders(sort_order, id);
CREATE INDEX idx_share_links_target ON share_links(target_type, target_id, created_at DESC);
CREATE UNIQUE INDEX idx_share_links_token ON share_links(token);
CREATE INDEX idx_share_links_expiry ON share_links(expires_at) WHERE revoked_at IS NULL;
CREATE INDEX idx_system_nodes_system ON trading_system_nodes(system_id, sort_order, id);
CREATE INDEX idx_system_nodes_parent ON trading_system_nodes(parent_id, sort_order, id);
CREATE INDEX idx_system_nodes_rule ON trading_system_nodes(rule_id);
CREATE INDEX idx_trading_systems_category ON trading_systems(category);
CREATE INDEX idx_trading_systems_template ON trading_systems(is_template, updated_at DESC);
CREATE INDEX idx_mindmap_versions_system ON mindmap_versions(system_id, id DESC);
CREATE INDEX idx_ai_conversations_user_updated ON ai_conversations(user_id, updated_at DESC);
CREATE INDEX idx_ai_messages_conversation ON ai_messages(conversation_id, id);
CREATE INDEX idx_ai_batches_conversation ON ai_action_batches(conversation_id, id);
CREATE INDEX idx_backups_created ON backups(created_at DESC);
CREATE INDEX idx_maintenance_jobs_created ON maintenance_jobs(created_at DESC);
CREATE INDEX idx_ai_jobs_created ON ai_jobs(created_at DESC);
CREATE INDEX idx_trades_result_entry_time ON trades(result, entry_time DESC);
CREATE INDEX idx_trade_strategy_snapshots_trade ON trade_strategy_snapshots(trade_id);
CREATE INDEX idx_trade_rule_checks_trade ON trade_rule_checks(trade_id, sort_order, id);
CREATE INDEX idx_trade_rule_checks_status ON trade_rule_checks(status, trade_id);
CREATE INDEX idx_refinement_drafts_system ON mindmap_refinement_drafts(system_id, created_at DESC);

-- 新数据库默认配置
INSERT OR IGNORE INTO settings (category, label, value, sort_order) VALUES
  ('symbol', 'XAUUSD', 'XAUUSD', 1),
  ('trade_type', '高胜率低盈亏', '高胜率低盈亏', 1),
  ('trade_type', '高胜率高盈亏', '高胜率高盈亏', 2),
  ('trade_type', '低胜率高盈亏', '低胜率高盈亏', 3),
  ('trade_type', '中等胜率中等盈亏', '中等胜率中等盈亏', 4),
  ('market_cycle', '极速突破', '极速突破', 1),
  ('market_cycle', '窄幅通道', '窄幅通道', 2),
  ('market_cycle', '宽幅通道', '宽幅通道', 3),
  ('market_cycle', '震荡区间', '震荡区间', 4),
  ('market_cycle', '反转', '反转', 5),
  ('pattern', '三推楔形', '三推楔形', 1),
  ('pattern', '三角形突破', '三角形突破', 2),
  ('pattern', '趋势K线', '趋势K线', 3),
  ('pattern', '双重顶/底', '双重顶/底', 4),
  ('pattern', '头肩顶/底', '头肩顶/底', 5),
  ('pattern', '双K反转', '双K反转', 6),
  ('pattern', 'ii/iii/ioi', 'ii/iii/ioi', 7),
  ('pattern', '突破缺口/均线缺口', '突破缺口/均线缺口', 8),
  ('pattern', '回补缺口/均线缺口', '回补缺口/均线缺口', 9),
  ('pattern', '50%回调', '50%回调', 10),
  ('pattern', 'H1/H2/L1/L2', 'H1/H2/L1/L2', 11),
  ('pattern', '站稳ema20上/下', '站稳ema20上/下', 12),
  ('pattern', '突破支撑位/压力位', '突破支撑位/压力位', 13),
  ('pattern', '反弹支撑位/压力位', '反弹支撑位/压力位', 14),
  ('pattern', '信号K线', '信号K线', 15),
  ('exit_type', '目标自动止盈', '目标自动止盈', 1),
  ('exit_type', '符合规则手动止盈/止损', '符合规则手动止盈/止损', 2),
  ('exit_type', '恐惧手动止盈/止损', '恐惧手动止盈/止损', 3),
  ('exit_type', '止损点自动止损', '止损点自动止损', 4),
  ('exit_type', '贪婪利润回吐止损', '贪婪利润回吐止损', 5),
  ('timeframe', '5M', '5M', 1),
  ('timeframe', '30M', '30M', 2),
  ('timeframe', '1h', '1h', 3),
  ('timeframe', '1D', '1D', 4);

INSERT OR IGNORE INTO settings (category, label, value, color, sort_order) VALUES
  ('system_node_type', '市场环境', 'setup', '#5b8def', 1),
  ('system_node_type', '判断条件', 'condition', '#9b8afb', 2),
  ('system_node_type', '入场', 'entry', '#22c55e', 3),
  ('system_node_type', '风控', 'risk', '#f0b429', 4),
  ('system_node_type', '出场', 'exit', '#ef5b66', 5),
  ('system_node_type', '复盘', 'review', '#4fb6d8', 6),
  ('system_node_type', '备注', 'note', '#8b95a8', 7);

INSERT OR IGNORE INTO settings (category, label, value, color, sort_order, is_active) VALUES
  ('mindmap_category', '交易系统', '交易系统', '#3ec9c5', 1, 1),
  ('mindmap_category', '复盘脑图', '复盘脑图', '#5b8def', 2, 1),
  ('mindmap_category', '学习笔记', '学习笔记', '#9b8afb', 3, 1);

INSERT OR IGNORE INTO app_config (config_key, config_value, description) VALUES
  ('app_name', '交易日志系统', '应用名称'),
  ('default_symbol', 'XAUUSD', '默认交易品种'),
  ('mcp_enabled', 'true', 'MCP 服务开关'),
  ('mcp_endpoint', '/api/mcp', 'MCP 端点路径'),
  ('tg_bot_token', '', 'Telegram Bot Token'),
  ('tg_chat_id', '', 'Telegram Chat ID'),
  ('image_storage', 'r2', '图片存储方式: r2 / tg / both'),
  ('market_data_url', '', '行情服务 URL（td-forex-mcp）'),
  ('market_data_key', '', '行情服务访问密钥'),
  ('ai_enabled', 'false', '是否启用站内 AI 工作台'),
  ('ai_base_url', 'https://api.openai.com/v1', 'AI API 基础地址或完整端点'),
  ('ai_api_format', 'auto', 'AI API 格式：自动、Responses 或 Chat Completions'),
  ('ai_model', '', 'AI 模型 ID'),
  ('ai_api_key', '', 'AI API 密钥'),
  ('ai_cf_fallback_enabled', 'true', '主模型不可用时启用 Cloudflare Workers AI'),
  ('ai_cf_fallback_model', '@cf/meta/llama-3.2-3b-instruct', 'Cloudflare Workers AI 备用模型'),
  ('ai_cf_daily_neuron_limit', '9000', 'Cloudflare Workers AI UTC 每日账户神经元保护阈值'),
  ('ai_cf_account_id', '', '可选：用于动态获取 Workers AI 模型目录和账户用量的 Cloudflare Account ID'),
  ('ai_cf_api_token', '', '可选：Workers AI Read 权限令牌，用于读取模型目录和账户用量');

INSERT OR IGNORE INTO app_config (config_key, config_value, description) VALUES
  ('backup_retention', '7', '自动保留最近多少份完整备份');

-- 新数据库使用完整基线创建后，把基线已包含的增量迁移登记为已应用，
-- 以后即可安全执行 `wrangler d1 migrations apply`。
CREATE TABLE IF NOT EXISTS d1_migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);
INSERT OR IGNORE INTO d1_migrations(name) VALUES
  ('0004_mindmap_refinement.sql'),
  ('0005_strategy_refinement_backup.sql'),
  ('0006_folders_and_shares.sql'),
  ('0007_burn_after_read.sql'),
  ('0008_security_and_maintenance.sql'),
  ('0009_ai_provider_fallback.sql'),
  ('0010_ai_jobs_and_limits.sql'),
  ('0011_ai_stream_news_usage.sql');

COMMIT;
