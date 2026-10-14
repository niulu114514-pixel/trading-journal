export interface Trade {
  id: number
  symbol: string
  code?: string | null
  entry_time: string
  lots: number
  entry_price?: number | null
  exit_price?: number | null
  direction: '多' | '空'
  timeframe: string
  trading_system_id?: number | null
  trading_system_name?: string | null
  strategy_snapshot_locked?: number | boolean
  strategy_version_id?: number | null
  strategy_snapshot_at?: string | null
  trade_type?: string | null
  market_cycle?: string | null
  patterns?: string | null
  trade_logic?: string | null
  exit_type?: string | null
  return_amount?: number | null
  risk_reward_ratio?: number | null
  result?: '胜' | '败' | '平' | null
  review?: string | null
  daily_chart_id?: number | null
  daily_chart_image?: string | null
  created_at: string
  updated_at: string
}

export interface Rule {
  id: number
  title: string
  category: string
  content: string
  tags?: string | null
  is_active: number | boolean
  priority: number
  created_at: string
  updated_at: string
}

export interface Setting {
  id: number
  category: string
  label: string
  value: string
  color?: string | null
  sort_order: number
  is_active: number | boolean
}

export interface TradingSystemSummary {
  id: number
  name: string
  category?: string | null
  description?: string | null
  resource_url?: string | null
  markets?: string | null
  timeframes?: string | null
  status: 'draft' | 'active' | 'archived'
  color: string
  node_count: number
  trade_count: number
  updated_at: string
  is_template?: number | boolean
}

export interface MindmapQuality {
  score: number
  grade: '优秀' | '良好' | '待完善'
  missing: string[]
  metrics: { node_count:number; max_depth:number; top_level_count:number; detailed_nodes:number }
}

export interface SystemNode {
  id: number
  system_id: number
  parent_id: number | null
  rule_id?: number | null
  title: string
  content?: string | null
  node_type: string
  sort_order: number
  is_collapsed: number | boolean
  rule_title?: string | null
  rule_category?: string | null
}

export interface TradingSystemDetail {
  system: TradingSystemSummary
  nodes: SystemNode[]
  quality: MindmapQuality
}

export interface StoredImage {
  id: number
  storage_type: 'r2' | 'tg'
  storage_key: string
  filename?: string | null
  mime_type?: string | null
  size_bytes?: number | null
  caption?: string | null
  trade_id?: number | null
  public_id?: string | null
  url: string
  public_url?: string
  created_at: string
}
