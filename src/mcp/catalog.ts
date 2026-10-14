export const MCP_WRITE_METHODS = new Set([
  'add_trade', 'update_trade', 'delete_trade',
  'add_rule', 'update_rule',
  'create_detailed_mindmap', 'update_system',
  'upload_chart_image'
]);

export interface McpToolDef {
  name: string;
  desc: string;
  inputSchema?: Record<string, unknown>;
}

const objectSchema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object', properties, required
});

const mindmapNodeSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ref: { type: 'string', minLength: 1, maxLength: 50, description: '本次请求内唯一的节点引用，用于建立层级' },
    parent_ref: { anyOf: [{ type: 'string' }, { type: 'null' }], description: '父节点 ref；省略或 null 时挂在根节点下' },
    title: { type: 'string', minLength: 1, maxLength: 120 },
    content: { type: 'string', minLength: 8, maxLength: 2000, description: '具体条件、阈值、动作、例外或复盘说明' },
    node_type: { type: 'string', minLength: 1, maxLength: 40 },
    rule_id: { type: 'integer' },
    sort_order: { type: 'integer', minimum: 0 }
  },
  required: ['ref', 'title', 'content']
};

const tradeProperties = {
  symbol: { type: 'string', description: '交易品种，如 XAUUSD' },
  code: { type: 'string', description: '交易编号' },
  lots: { type: 'number', description: '手数' },
  entry_price: { type: 'number', description: '开仓价格' },
  exit_price: { type: 'number', description: '平仓价格' },
  direction: { type: 'string', enum: ['多', '空'] },
  timeframe: { type: 'string', description: '多个时间级别使用逗号分隔' },
  entry_time: { type: 'string', description: '格式 YYYY-MM-DD HH:mm' },
  trading_system_id: { type: 'integer' },
  trade_type: { type: 'string' },
  market_cycle: { type: 'string' },
  patterns: { type: 'string', description: '多个形态使用逗号分隔' },
  trade_logic: { type: 'string' },
  exit_type: { type: 'string' },
  return_amount: { type: 'number' },
  risk_reward_ratio: { type: 'number' },
  result: { type: 'string', enum: ['胜', '败', '平'] },
  notes: { type: 'string', description: '交易复盘' }
};

export const MCP_TOOLS: McpToolDef[] = [
  {
    name: 'list_trades', desc: '获取交易列表',
    inputSchema: objectSchema({
      symbol: { type: 'string' }, result: { type: 'string', enum: ['胜', '败', '平'] },
      month: { type: 'string', description: 'YYYY-MM' }, page: { type: 'integer' }, limit: { type: 'integer' }
    })
  },
  { name: 'get_trade', desc: '获取单笔交易详情和当日 K 线图', inputSchema: objectSchema({ id: { type: 'integer' } }, ['id']) },
  { name: 'add_trade', desc: '添加交易；全天 K 线请按日期单独上传', inputSchema: objectSchema(tradeProperties, ['symbol', 'entry_time']) },
  { name: 'update_trade', desc: '更新交易记录', inputSchema: objectSchema({ id: { type: 'integer' }, ...tradeProperties }, ['id']) },
  { name: 'delete_trade', desc: '删除交易记录', inputSchema: objectSchema({ id: { type: 'integer' } }, ['id']) },
  {
    name: 'get_stats', desc: '获取交易统计',
    inputSchema: objectSchema({ period: { type: 'string', enum: ['day', 'week', 'month', 'year'] } })
  },
  {
    name: 'get_trend', desc: '获取盈亏时间序列',
    inputSchema: objectSchema({ granularity: { type: 'string', enum: ['day', 'week', 'month', 'year'] }, limit: { type: 'integer' } })
  },
  {
    name: 'list_rules', desc: '获取交易规则列表',
    inputSchema: objectSchema({ category: { type: 'string' }, active: { type: 'boolean' } })
  },
  {
    name: 'add_rule', desc: '添加交易规则',
    inputSchema: objectSchema({
      title: { type: 'string' }, category: { type: 'string' }, content: { type: 'string' },
      tags: { type: 'string' }, priority: { type: 'integer' }, is_active: { type: 'boolean' }
    }, ['title', 'content'])
  },
  {
    name: 'update_rule', desc: '更新交易规则',
    inputSchema: objectSchema({
      id: { type: 'integer' }, title: { type: 'string' }, category: { type: 'string' }, content: { type: 'string' },
      tags: { type: 'string' }, priority: { type: 'integer' }, is_active: { type: 'boolean' }
    }, ['id'])
  },
  {
    name: 'list_systems', desc: '获取脑图列表',
    inputSchema: objectSchema({ status: { type: 'string', enum: ['draft', 'active', 'archived'] }, category: { type: 'string' } })
  },
  { name: 'get_system', desc: '获取脑图及完整节点', inputSchema: objectSchema({ id: { type: 'integer' } }, ['id']) },
  {
    name: 'create_detailed_mindmap', desc: '一次创建完整的多层脑图',
    inputSchema: objectSchema({
      name: { type: 'string', minLength: 1, maxLength: 100 },
      category: { type: 'string' }, description: { type: 'string', maxLength: 2000 },
      resource_url: { type: 'string' },
      markets: { type: 'string' }, timeframes: { type: 'string' },
      status: { type: 'string', enum: ['draft', 'active', 'archived'] }, color: { type: 'string' },
      nodes: { type: 'array', items: mindmapNodeSchema }
    }, ['name', 'nodes'])
  },
  {
    name: 'update_system', desc: '更新脑图元数据',
    inputSchema: objectSchema({
      id: { type: 'integer' }, name: { type: 'string' }, category: { type: 'string' }, description: { type: 'string' },
      resource_url: { type: 'string' }, markets: { type: 'string' },
      timeframes: { type: 'string' }, status: { type: 'string', enum: ['draft', 'active', 'archived'] }, color: { type: 'string' }
    }, ['id'])
  },
  {
    name: 'upload_chart_image', desc: '按日期上传一张全天 K 线图，并关联当天全部交易',
    inputSchema: objectSchema({
      image_base64: { type: 'string' }, filename: { type: 'string' },
      mime_type: { type: 'string', enum: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] },
      display_name: { type: 'string' }, category: { type: 'string' }, tags: { type: 'string' },
      resource_url: { type: 'string' }, caption: { type: 'string' },
      trade_date: { type: 'string', description: 'YYYY-MM-DD' }
    }, ['image_base64', 'trade_date'])
  },
  {
    name: 'list_images', desc: '搜索图片',
    inputSchema: objectSchema({ q: { type: 'string' }, category: { type: 'string' }, uncategorized: { type: 'boolean' }, page: { type: 'integer' }, limit: { type: 'integer' } })
  },
  {
    name: 'get_image', desc: '获取图片访问地址',
    inputSchema: { ...objectSchema({ id: { type: 'integer' }, key: { type: 'string' } }), anyOf: [{ required: ['id'] }, { required: ['key'] }] }
  }
];
