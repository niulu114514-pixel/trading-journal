export const MCP_WRITE_METHODS = new Set([
  'add_trade', 'update_trade', 'delete_trade',
  'upload_chart_image', 'set_trade_chart',
  'update_image', 'delete_image', 'reconcile_images',
  'add_rule', 'update_rule', 'delete_rule',
  'add_system', 'update_system', 'delete_system',
  'create_detailed_mindmap', 'expand_mindmap', 'refine_mindmap', 'apply_mindmap_refinement', 'discard_mindmap_refinement', 'save_mindmap_version', 'restore_mindmap_version', 'delete_mindmap_version',
  'duplicate_mindmap', 'save_mindmap_template', 'create_mindmap_from_template',
  'add_system_node', 'update_system_node', 'delete_system_node',
  'add_setting', 'update_setting', 'delete_setting'
]);

// MCP 工具目录（inputSchema 供标准 MCP 客户端使用）
export interface McpToolDef {
  name: string;
  desc: string;
  inputSchema?: any;
}
const OBJ = (properties: Record<string, any>, required: string[] = []) => ({ type: 'object', properties, required });
const MINDMAP_BATCH_NODE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ref: { type: 'string', minLength: 1, maxLength: 50, description: '本次请求内唯一的节点引用，如 market_trend；用于 parent_ref 建立层级' },
    parent_ref: { anyOf: [{ type: 'string' }, { type: 'null' }], description: '父节点 ref；省略或 null 表示挂在根节点/指定锚点下' },
    title: { type: 'string', minLength: 1, maxLength: 120, description: '具体、可直接执行或判断的节点标题' },
    content: { type: 'string', minLength: 8, maxLength: 2000, description: '详细说明，写清条件、阈值、动作、例外或复盘问题，不能只重复标题' },
    node_type: { type: 'string', minLength: 1, maxLength: 40, description: '节点类型值；先用 list_settings(system_node_type) 查询可用值' },
    rule_id: { type: 'integer', description: '可选：引用已有交易规则 ID' },
    sort_order: { type: 'integer', minimum: 0, description: '同级排序，默认按数组顺序' }
  },
  required: ['ref', 'title', 'content']
};
const TRADE_TOOL_PROPERTIES = {
  symbol: { type: 'string', description: '交易品种，如 XAUUSD' },
  code: { type: 'string', description: '交易编号' },
  lots: { type: 'number', description: '手数' },
  entry_price: { type: 'number', description: '开仓价格' },
  exit_price: { type: 'number', description: '平仓价格' },
  direction: { type: 'string', enum: ['多', '空'], description: '交易方向' },
  timeframe: { type: 'string', description: '时间级别；可填写一个值，多个值使用逗号分隔，如 5M,15M,1H' },
  entry_time: { type: 'string', description: '入场时间，格式 YYYY-MM-DD HH:mm' },
  trading_system_id: { type: 'integer', description: '本次交易执行的交易系统 ID' },
  trade_type: { type: 'string', description: '交易类型' },
  market_cycle: { type: 'string', description: '市场周期' },
  patterns: { type: 'string', description: '交易形态，多个值可用逗号分隔' },
  trade_logic: { type: 'string', description: '交易逻辑' },
  exit_type: { type: 'string', description: '出场方式' },
  return_amount: { type: 'number', description: '盈亏金额' },
  risk_reward_ratio: { type: 'number', description: '直接填写风险/回报比原始数值，例如 0.71' },
  result: { type: 'string', enum: ['胜', '败', '平'], description: '交易结果' },
  notes: { type: 'string', description: '交易笔记（保存到复盘字段）' },
  chart_image_url: { type: 'string', description: 'K 线图 URL' },
  chart_image_base64: { type: 'string', description: 'K 线图 base64 内容（与 URL 二选一）' },
  chart_image_filename: { type: 'string', description: 'base64 图片文件名，建议包含扩展名' },
  chart_image_mime: { type: 'string', enum: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] },
  caption: { type: 'string', description: '图片备注' }
};

export const MCP_TOOLS: McpToolDef[] = [
  {
    name: 'list_trades', desc: '获取交易列表（支持 symbol/result/month 筛选与分页）',
    inputSchema: OBJ({
      symbol: { type: 'string', description: '按交易品种筛选，如 XAUUSD' },
      result: { type: 'string', enum: ['胜', '败', '平'], description: '按结果筛选' },
      month: { type: 'string', description: '按月份筛选，格式 YYYY-MM' },
      page: { type: 'integer', description: '页码，默认 1' },
      limit: { type: 'integer', description: '每页数量，默认 50，最大 200' }
    })
  },
  {
    name: 'get_trade', desc: '获取单笔交易详情（含 K 线图 URL）',
    inputSchema: OBJ({ id: { type: 'integer', description: '交易 ID' } }, ['id'])
  },
  {
    name: 'add_trade', desc: '添加新交易（支持 chart_image_url 或 chart_image_base64 直接附图）',
    inputSchema: OBJ(TRADE_TOOL_PROPERTIES, ['symbol', 'entry_time'])
  },
  {
    name: 'update_trade', desc: '更新交易记录（支持 chart_image_url / chart_image_base64）',
    inputSchema: OBJ({ id: { type: 'integer', description: '交易 ID' }, ...TRADE_TOOL_PROPERTIES }, ['id'])
  },
  {
    name: 'delete_trade', desc: '删除交易记录',
    inputSchema: OBJ({ id: { type: 'integer', description: '交易 ID' } }, ['id'])
  },
  {
    name: 'get_stats', desc: '获取交易统计（period: day/week/month/year，默认全部）',
    inputSchema: OBJ({ period: { type: 'string', enum: ['day', 'week', 'month', 'year'], description: '统计周期，默认全部' } })
  },
  {
    name: 'get_trend', desc: '获取盈亏时间序列（granularity: day/week/month/year）',
    inputSchema: OBJ({
      granularity: { type: 'string', enum: ['day', 'week', 'month', 'year'], description: '聚合粒度，默认 month' },
      limit: { type: 'integer', description: '返回期数，默认 30，最大 120' }
    })
  },
  {
    name: 'list_rules', desc: '获取交易规则列表',
    inputSchema: OBJ({
      category: { type: 'string', description: '按分类筛选' },
      active: { type: 'boolean', description: '仅返回启用或停用的规则' }
    })
  },
  {
    name: 'get_rule', desc: '获取单条规则详情',
    inputSchema: OBJ({ id: { type: 'integer', description: '规则 ID' } }, ['id'])
  },
  {
    name: 'add_rule', desc: '添加交易规则',
    inputSchema: OBJ({
      title: { type: 'string', description: '规则标题' },
      category: { type: 'string', description: '规则分类，如入场规则/出场规则/资金管理' },
      content: { type: 'string', description: '规则正文' },
      tags: { type: 'string', description: '逗号分隔的标签' },
      priority: { type: 'integer', description: '优先级，数值越大越靠前' },
      is_active: { type: 'boolean', description: '是否启用，默认 true' }
    }, ['title', 'content'])
  },
  {
    name: 'update_rule', desc: '更新交易规则',
    inputSchema: OBJ({
      id: { type: 'integer', description: '规则 ID' },
      title: { type: 'string' }, category: { type: 'string' }, content: { type: 'string' },
      tags: { type: 'string' }, priority: { type: 'integer' }, is_active: { type: 'boolean' }
    }, ['id'])
  },
  {
    name: 'delete_rule', desc: '删除交易规则',
    inputSchema: OBJ({ id: { type: 'integer', description: '规则 ID' } }, ['id'])
  },
  {
    name: 'list_systems', desc: '获取脑图列表（可用于交易系统、复盘或学习笔记）',
    inputSchema: OBJ({ status: { type: 'string', enum: ['draft', 'active', 'archived'], description: '按状态筛选' }, category: { type: 'string', description: '按脑图分类筛选' } })
  },
  {
    name: 'get_system', desc: '获取交易系统及其完整脑图节点，可看到节点引用的规则',
    inputSchema: OBJ({ id: { type: 'integer', description: '交易系统 ID' } }, ['id'])
  },
  {
    name: 'add_system', desc: '只创建空白脑图或 5 个通用骨架分支；不要用它生成完整脑图，完整/详细脑图必须使用 create_detailed_mindmap',
    inputSchema: OBJ({
      name: { type: 'string', description: '系统名称' },
      category: { type: 'string', description: '脑图分类；从 mindmap_category 设置中读取' },
      description: { type: 'string', description: '系统目标或适用场景' },
      original_prompt: { type: 'string', maxLength: 12000, description: '创建脑图的原始完整提示词；后续 AI 精修会始终参考' },
      resource_url: { type: 'string', description: '整张脑图的网盘视频或资料链接' },
      markets: { type: 'string', description: '适用品种，逗号分隔' },
      timeframes: { type: 'string', description: '适用时间级别，逗号分隔' },
      status: { type: 'string', enum: ['draft', 'active', 'archived'] },
      color: { type: 'string', description: '十六进制主题色' },
      template: { type: 'boolean', description: '是否创建默认脑图分支，默认 true' }
    }, ['name'])
  },
  {
    name: 'create_detailed_mindmap',
    desc: '【创建脑图时首选】一次创建可直接使用的详细多层脑图。节点数量和层级由主题复杂度决定；完整覆盖必要分支，并为节点填写具体条件、动作、阈值和例外，不要只给概括标题',
    inputSchema: OBJ({
      name: { type: 'string', minLength: 1, maxLength: 100, description: '脑图名称' },
      category: { type: 'string', description: '脑图分类；先用 list_settings(mindmap_category) 查询，默认交易系统' },
      description: { type: 'string', maxLength: 2000, description: '系统核心逻辑、适用边界和目标的完整说明' },
      original_prompt: { type: 'string', maxLength: 12000, description: '原始完整需求、背景、约束与目标；建议必填' },
      resource_url: { type: 'string', description: '整张脑图根级的视频或网盘资料链接' },
      markets: { type: 'string', description: '适用品种，逗号分隔' },
      timeframes: { type: 'string', description: '适用时间级别，逗号分隔' },
      status: { type: 'string', enum: ['draft', 'active', 'archived'], description: '默认 draft；内容已确认后才使用 active' },
      color: { type: 'string', description: '十六进制主题色' },
      nodes: {
        type: 'array',
        description: '完整节点清单。先设计市场环境、前置过滤、入场、仓位风险、持仓管理、出场、禁止条件、复盘等一级分支，再拆成可执行条件；parent_ref 指向同数组中的 ref',
        items: MINDMAP_BATCH_NODE_SCHEMA
      }
    }, ['name', 'nodes'])
  },
  {
    name: 'expand_mindmap',
    desc: '一次为已有脑图批量增加一组相关的多层节点；用于把概括脑图精修为具体流程，节点数量由需要补充的内容决定',
    inputSchema: OBJ({
      system_id: { type: 'integer', description: '已有脑图 ID' },
      anchor_id: { type: 'integer', description: '新增结构的锚点节点 ID；省略时使用脑图根节点' },
      nodes: {
        type: 'array',
        description: '待新增的节点；parent_ref 省略时挂到锚点，填写时指向本数组内的 ref',
        items: MINDMAP_BATCH_NODE_SCHEMA
      }
    }, ['system_id', 'nodes'])
  },
  {
    name:'refine_mindmap',desc:'在后台基于原始提示词和当前整图生成精修草稿；立即返回 job_id，不会阻塞或直接覆盖脑图',
    inputSchema:OBJ({system_id:{type:'integer',description:'脑图 ID'},instructions:{type:'string',maxLength:4000,description:'本次额外精修重点'}},['system_id'])
  },
  {name:'get_ai_job',desc:'查询脑图精修后台任务状态；完成后 result 中返回 draft_id',inputSchema:OBJ({job_id:{type:'string'}},['job_id'])},
  {name:'apply_mindmap_refinement',desc:'应用已审阅的精修草稿；可排除不接受的新节点，并保留 AI 建议删除的旧节点',inputSchema:OBJ({system_id:{type:'integer'},draft_id:{type:'string'},excluded_node_ids:{type:'array',items:{type:'integer'}},preserve_removed_node_ids:{type:'array',items:{type:'integer'}}},['system_id','draft_id'])},
  {name:'discard_mindmap_refinement',desc:'丢弃精修草稿，当前脑图保持不变',inputSchema:OBJ({system_id:{type:'integer'},draft_id:{type:'string'}},['system_id','draft_id'])},
  {name:'list_mindmap_versions',desc:'列出脑图最近 30 个整图版本',inputSchema:OBJ({system_id:{type:'integer'}},['system_id'])},
  {name:'save_mindmap_version',desc:'手动保存当前整张脑图版本',inputSchema:OBJ({system_id:{type:'integer'},label:{type:'string',maxLength:100}},['system_id'])},
  {name:'restore_mindmap_version',desc:'整图回撤到指定版本；回撤前自动保存当前版本',inputSchema:OBJ({system_id:{type:'integer'},version_id:{type:'integer'}},['system_id','version_id'])},
  {name:'delete_mindmap_version',desc:'删除单个脑图版本；保留交易中存储的完整脑图快照',inputSchema:OBJ({system_id:{type:'integer'},version_id:{type:'integer'}},['system_id','version_id'])},
  {name:'duplicate_mindmap',desc:'复制一张脑图及全部节点、原始提示词和配置',inputSchema:OBJ({system_id:{type:'integer'},name:{type:'string'}},['system_id'])},
  {name:'save_mindmap_template',desc:'将当前脑图保存为可复用模板',inputSchema:OBJ({system_id:{type:'integer'},name:{type:'string'}},['system_id'])},
  {name:'list_mindmap_templates',desc:'列出脑图模板及节点数量'},
  {name:'create_mindmap_from_template',desc:'从模板创建独立脑图副本',inputSchema:OBJ({template_id:{type:'integer'},name:{type:'string'},category:{type:'string'}},['template_id'])},
  {
    name: 'update_system', desc: '更新交易系统元数据',
    inputSchema: OBJ({
      id: { type: 'integer' }, name: { type: 'string' }, description: { type: 'string' }, original_prompt:{type:'string',maxLength:12000},
      category: { type: 'string' }, resource_url: { type: 'string' },
      markets: { type: 'string' }, timeframes: { type: 'string' },
      status: { type: 'string', enum: ['draft', 'active', 'archived'] }, color: { type: 'string' }
    }, ['id'])
  },
  {
    name: 'delete_system', desc: '删除交易系统及其脑图节点；不会删除已关联交易',
    inputSchema: OBJ({ id: { type: 'integer', description: '交易系统 ID' } }, ['id'])
  },
  {
    name: 'add_system_node', desc: '只添加单个脑图节点；批量创建或精修详细脑图时请使用 create_detailed_mindmap / expand_mindmap',
    inputSchema: OBJ({
      system_id: { type: 'integer' }, parent_id: { type: 'integer' }, rule_id: { type: 'integer' },
      title: { type: 'string' }, content: { type: 'string' },
      node_type: { type: 'string', minLength: 1, maxLength: 40, description: '节点类型值；可从 system_node_type 设置中读取和自定义' },
      sort_order: { type: 'integer' }
    }, ['system_id', 'parent_id', 'title'])
  },
  {
    name: 'update_system_node', desc: '更新脑图节点、排序、折叠状态或关联规则',
    inputSchema: OBJ({
      system_id: { type: 'integer' }, id: { type: 'integer' }, parent_id: { type: 'integer' },
      rule_id: { anyOf: [{ type: 'integer' }, { type: 'null' }] }, title: { type: 'string' }, content: { type: 'string' },
      node_type: { type: 'string' }, sort_order: { type: 'integer' }, is_collapsed: { type: 'boolean' }
    }, ['system_id', 'id'])
  },
  {
    name: 'delete_system_node', desc: '删除脑图节点及其全部子节点（根节点不能删除）',
    inputSchema: OBJ({ system_id: { type: 'integer' }, id: { type: 'integer' } }, ['system_id', 'id'])
  },
  {
    name: 'list_settings', desc: '读取自定义选项；可按类别筛选（含 symbol 交易品种、timeframe 时间级别、image_category 图片分类、mindmap_category 脑图分类）',
    inputSchema: OBJ({
      category: { type: 'string', description: '类别，如 symbol、timeframe、pattern、trade_type、rule_category、system_node_type、image_category、mindmap_category' },
      active: { type: 'boolean', description: '仅返回启用或停用的选项' }
    })
  },
  {
    name: 'add_setting', desc: '添加自定义选项，例如新增交易品种或时间级别',
    inputSchema: OBJ({
      category: { type: 'string', description: '类别；交易品种使用 symbol，时间级别使用 timeframe' },
      label: { type: 'string', description: '显示名称，如 15分钟' },
      value: { type: 'string', description: '选项值，如 15M' },
      color: { type: 'string', description: '可选颜色，如 #22c55e' },
      sort_order: { type: 'integer', description: '排序值' },
      is_active: { type: 'boolean', description: '是否启用，默认 true' }
    }, ['category', 'label', 'value'])
  },
  {
    name: 'update_setting', desc: '更新自定义选项',
    inputSchema: OBJ({
      id: { type: 'integer', description: '选项 ID' }, category: { type: 'string' }, label: { type: 'string' },
      value: { type: 'string' }, color: { type: 'string' }, sort_order: { type: 'integer' }, is_active: { type: 'boolean' }
    }, ['id'])
  },
  {
    name: 'delete_setting', desc: '删除自定义选项',
    inputSchema: OBJ({ id: { type: 'integer', description: '选项 ID' } }, ['id'])
  },
  {
    name: 'get_market_candles', desc: '获取可用于分析或绘图的 OHLC K 线数据（来自 td-forex-mcp）',
    inputSchema: OBJ({
      symbol: { type: 'string', description: '标的，如 XAU/USD、EUR/USD、BTC/USD' },
      interval: { type: 'string', enum: ['1min', '5min', '15min', '30min', '45min', '1h', '2h', '4h', '1day', '1week', '1month'] },
      outputsize: { type: 'integer', description: 'K 线数量，默认 120，最大 2000' },
      fresh: { type: 'boolean', description: '绕过 60 秒缓存请求最新数据，会消耗上游额度' }
    })
  },
  {
    name: 'upload_chart_image', desc: '上传 K 线图或图床图片（base64），可命名、分类、添加标签并关联 trade_id；返回图片 URL',
    inputSchema: OBJ({
      image_base64: { type: 'string', description: '图片 base64 内容（支持 data: 前缀）' },
      filename: { type: 'string', description: '文件名，用于推断 MIME，默认 mcp-chart-<ts>.png' },
      mime_type: { type: 'string', enum: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] },
      display_name: { type: 'string', description: '图片显示名称' },
      category: { type: 'string', description: '图片分类值；先用 list_settings(category=image_category) 查询' },
      tags: { type: 'string', description: '逗号分隔标签' },
      resource_url: { type: 'string', description: '关联视频或网盘资料链接（http/https）' },
      caption: { type: 'string', description: '图片说明' },
      trade_id: { type: 'integer', description: '可选：关联的交易 ID' }
    }, ['image_base64'])
  },
  {
    name: 'set_trade_chart', desc: '为已存在的交易设置 K 线图',
    inputSchema: {
      ...OBJ({
        trade_id: { type: 'integer', description: '交易 ID' },
        image_base64: { type: 'string', description: '图片 base64 内容' },
        image_url: { type: 'string', description: '或直接提供图片 URL' },
        filename: { type: 'string', description: '文件名' },
        mime_type: { type: 'string', enum: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] },
        caption: { type: 'string', description: '图片备注' }
      }, ['trade_id']),
      anyOf: [{ required: ['image_base64'] }, { required: ['image_url'] }]
    }
  },
  {
    name: 'list_images', desc: '搜索并分页获取图片（名称、分类、标签、备注）',
    inputSchema: OBJ({
      q: { type: 'string', description: '搜索名称、原文件名、备注或标签' },
      category: { type: 'string', description: '按图片分类筛选' },
      uncategorized: { type: 'boolean', description: '仅返回未分类图片；为 true 时忽略 category' },
      page: { type: 'integer', description: '页码，默认 1' },
      limit: { type: 'integer', description: '每页数量，默认 20，最大 100' }
    })
  },
  {
    name: 'get_image', desc: '获取图片访问 URL',
    inputSchema: {
      ...OBJ({
        id: { type: 'integer', description: '图片记录 ID（推荐）' },
        key: { type: 'string', description: '兼容旧客户端：图片存储 key' }
      }),
      anyOf: [{ required: ['id'] }, { required: ['key'] }]
    }
  },
  {
    name: 'update_image', desc: '修改图片显示名称、分类、标签和备注',
    inputSchema: OBJ({
      id: { type: 'integer', description: '图片记录 ID' },
      display_name: { type: 'string', description: '方便识别的显示名称' },
      category: { type: 'string', description: '图片分类值；传空字符串可移除分类' },
      tags: { type: 'string', description: '逗号分隔标签' },
      resource_url: { type: 'string', description: '关联视频或网盘资料链接；空字符串可移除' },
      caption: { type: 'string', description: '备注说明' }
    }, ['id'])
  },
  {
    name: 'delete_image', desc: '永久删除图片及其交易引用',
    inputSchema: OBJ({ id: { type: 'integer', description: '图片记录 ID' } }, ['id'])
  },
  {
    name: 'reconcile_images', desc: '对账 R2 与图片元数据，清理已从 R2 手动删除的残留记录'
  }
];
