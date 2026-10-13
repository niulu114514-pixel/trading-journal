const endpoint = process.env.MCP_URL || 'http://127.0.0.1:8790/api/mcp'
const token = process.env.MCP_TOKEN
const readToken = process.env.MCP_READ_TOKEN

if (!token) throw new Error('MCP_TOKEN is required')

const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
let requestId = 0
let settingId
let imageCategoryId
let mindmapCategoryId
let systemId
let duplicateId
let templateId
let fromTemplateId
let tradeId
let imageId

function expect(condition, message) {
  if (!condition) throw new Error(message)
}

async function storedTokenForm(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `sha256$${hex}$${value.slice(-4)}`
}

async function rpc(method, params = {}, extraHeaders = {}) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { ...headers, ...extraHeaders },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params })
  })
  const body = await response.json()
  return { response, body }
}

async function tool(name, args = {}) {
  const { body } = await rpc('tools/call', { name, arguments: args })
  if (body.error || body.result?.isError) throw new Error(`${name} failed: ${JSON.stringify(body)}`)
  return body.result.structuredContent
}

async function cleanup() {
  if (imageId) await tool('delete_image', { id: imageId }).catch(() => {})
  if (tradeId) await tool('delete_trade', { id: tradeId }).catch(() => {})
  if (systemId) await tool('delete_system', { id: systemId }).catch(() => {})
  if (duplicateId) await tool('delete_system', { id: duplicateId }).catch(() => {})
  if (fromTemplateId) await tool('delete_system', { id: fromTemplateId }).catch(() => {})
  if (templateId) await tool('delete_system', { id: templateId }).catch(() => {})
  if (mindmapCategoryId) await tool('delete_setting', { id: mindmapCategoryId }).catch(() => {})
  if (settingId) await tool('delete_setting', { id: settingId }).catch(() => {})
  if (imageCategoryId) await tool('delete_setting', { id: imageCategoryId }).catch(() => {})
}

try {
  const getResponse = await fetch(endpoint)
  expect(getResponse.status === 405, 'GET must return 405')
  expect(getResponse.headers.get('allow') === 'POST, OPTIONS', 'GET must advertise allowed methods')

  const unauthorized = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'unauthorized', method: 'ping', params: {} })
  })
  const unauthorizedBody = await unauthorized.json()
  expect(unauthorized.status === 401 && unauthorizedBody.error?.code === -32001, 'Missing token must return 401')

  const digestAsBearer = await rpc('ping', {}, { Authorization: `Bearer ${await storedTokenForm(token)}` })
  expect(digestAsBearer.response.status === 401, 'Stored token digest must not be accepted as a Bearer token')

  const unknown = await rpc('method_that_does_not_exist')
  expect(unknown.response.status === 404 && unknown.body.error?.code === -32601, 'Unknown method must return -32601')

  if (readToken) {
    const readOnlyWrite = await rpc('add_rule', { title: 'forbidden', content: 'forbidden' }, { Authorization: `Bearer ${readToken}` })
    expect(readOnlyWrite.response.status === 403 && readOnlyWrite.body.error?.code === -32002, 'Read-only token must not call write methods')
  } else {
    console.warn('MCP_READ_TOKEN is not set; read-only permission test skipped')
  }

  const hostileOrigin = await rpc('initialize', { protocolVersion: '2025-11-25' }, { Origin: 'https://untrusted.example' })
  expect(hostileOrigin.response.status === 403, 'Untrusted Origin must be rejected')

  const discover = await rpc('server/discover', {
    _meta: {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientInfo': { name: 'trading-journal-e2e', version: '1.0.0' },
      'io.modelcontextprotocol/clientCapabilities': {}
    }
  })
  expect(discover.body.result?.supportedVersions?.includes('2026-07-28'), 'Modern discovery failed')
  expect(discover.body.result?.resultType === 'complete', 'Modern resultType is missing')

  const initialize = await rpc('initialize', { protocolVersion: '2099-01-01' })
  expect(initialize.body.result?.protocolVersion === '2025-11-25', 'Legacy version counter-offer failed')

  const unsupported = await rpc('ping', {}, { 'MCP-Protocol-Version': '2099-01-01' })
  expect(unsupported.response.status === 400 && unsupported.body.error?.code === -32022, 'Unsupported version was not rejected')

  const listed = await rpc('tools/list')
  const tools = listed.body.result?.tools || []
  expect(!tools.some((item) => item.name === 'tools_list'), 'Redundant tools_list is still exposed')
  expect(tools.find((item) => item.name === 'update_trade')?.inputSchema?.properties?.notes, 'update_trade schema is incomplete')
  expect(tools.find((item) => item.name === 'create_detailed_mindmap')?.inputSchema?.properties?.nodes, 'Detailed mind map tool is missing')
  expect(tools.some((item) => item.name === 'expand_mindmap'), 'Mind map expansion tool is missing')
  expect(tools.some((item) => item.name === 'refine_mindmap'), 'Mind map AI refinement tool is missing')
  expect(tools.some((item) => item.name === 'apply_mindmap_refinement'), 'Mind map refinement apply tool is missing')
  expect(tools.some((item) => item.name === 'discard_mindmap_refinement'), 'Mind map refinement discard tool is missing')
  expect(tools.some((item) => item.name === 'restore_mindmap_version'), 'Mind map version restore tool is missing')

  const setting = await tool('add_setting', {
    category: 'system_node_type',
    label: `端到端决策 ${suffix}`,
    value: `decision_${suffix.replaceAll('-', '_')}`,
    color: '#123456'
  })
  settingId = setting.id
  const mindmapCategory = await tool('add_setting', {
    category: 'mindmap_category',
    label: `E2E 脑图 ${suffix}`,
    value: `E2E 脑图 ${suffix}`,
    color: '#5b8def'
  })
  mindmapCategoryId = mindmapCategory.id

  const detailedNodes = [
    { ref:'market', title:'市场环境', content:'确认当前市场结构、交易时段以及允许参与的方向', node_type:'setup' },
    { ref:'entry', title:'入场流程', content:'依次核对位置、形态、信号与触发条件后才能执行', node_type:'entry' },
    { ref:'risk', title:'风险管理', content:'在下单前确定仓位、止损、失效点和最大风险', node_type:'risk' },
    { ref:'review', title:'复盘流程', content:'记录执行偏差、行情反馈以及下一次改进动作', node_type:'review' },
    { ref:'market_trend', parent_ref:'market', title:'趋势结构判断', content:'比较高低点和关键均线，区分趋势、通道与震荡', node_type:'condition' },
    { ref:'market_volatility', parent_ref:'market', title:'波动过滤', content:'检查当前波幅是否足以覆盖成本并支持目标空间', node_type:'condition' },
    { ref:'entry_signal', parent_ref:'entry', title:'自定义节点', content:'核对信号形态是否完整且出现于计划中的关键位置', node_type:`decision_${suffix.replaceAll('-', '_')}` },
    { ref:'entry_trigger', parent_ref:'entry', title:'触发动作', content:'只有价格突破触发位并完成确认后才允许提交订单', node_type:'entry' },
    { ref:'risk_size', parent_ref:'risk', title:'仓位计算', content:'根据止损距离和账户风险上限反推允许交易手数', node_type:'risk' },
    { ref:'risk_stop', parent_ref:'risk', title:'止损位置', content:'止损必须放在交易逻辑失效点之外并保留波动空间', node_type:'risk' },
    { ref:'review_execution', parent_ref:'review', title:'执行检查', content:'逐项比较计划与实际操作并标记提前或延迟动作', node_type:'review' },
    { ref:'review_data', parent_ref:'review', title:'数据记录', content:'保存截图、结果、盈亏比和规则遵守情况以便统计', node_type:'review' },
    { ref:'market_trend_detail', parent_ref:'market_trend', title:'趋势方向确认', content:'至少由两个同方向摆动高低点确认当前主导方向', node_type:'condition' },
    { ref:'entry_signal_detail', parent_ref:'entry_signal', title:'信号有效性', content:'信号线实体、影线和收盘位置必须支持计划方向', node_type:'condition' },
    { ref:'risk_size_limit', parent_ref:'risk_size', title:'单笔风险上限', content:'任何单笔计划风险都不得超过账户预设百分比', node_type:'risk' },
    { ref:'review_error_detail', parent_ref:'review_execution', title:'偏差归因', content:'把偏差归类为认知、纪律、执行或突发市场因素', node_type:'review' }
  ]
  const originalPrompt = `构建可执行且可持续精修的交易脑图 ${suffix}`
  const system = await tool('create_detailed_mindmap', { name: `MCP E2E ${suffix}`, category: `E2E 脑图 ${suffix}`, original_prompt: originalPrompt, resource_url: 'https://example.com/review-video', nodes: detailedNodes })
  systemId = system.id
  expect(system.node_count === 17 && system.max_depth === 4, 'Detailed mind map did not create the required structure')
  const blockedCategoryDelete = await rpc('tools/call', { name: 'delete_setting', arguments: { id: mindmapCategory.id } })
  expect(blockedCategoryDelete.body.result?.isError === true, 'Deleting an in-use mind map category must fail')
  const renamedMindmapCategory = `E2E 脑图已改名 ${suffix}`
  await tool('update_setting', { id: mindmapCategory.id, label: renamedMindmapCategory, value: renamedMindmapCategory })
  const categorizedSystem = await tool('get_system', { id: system.id })
  expect(categorizedSystem.system.category === renamedMindmapCategory, 'Mind map category rename did not migrate existing mind maps')
  await tool('expand_mindmap', { system_id:system.id, nodes:[
    { ref:'exit', title:'出场管理', content:'为已有脑图补充完整的止盈止损与持仓退出流程', node_type:'exit' },
    { ref:'exit_target', parent_ref:'exit', title:'目标位', content:'根据结构空间和预期盈亏比设置首个利润目标', node_type:'exit' },
    { ref:'exit_failure', parent_ref:'exit', title:'提前失效', content:'关键结构被反向破坏时不等待固定止损而主动退出', node_type:'condition' },
    { ref:'exit_review', parent_ref:'exit_target', title:'移动保护', content:'达到首个目标后按既定规则移动保护而非临时决定', node_type:'exit' }
  ] })
  const expandedDetail = await tool('get_system', { id:system.id })
  expect(expandedDetail.nodes.length === 21, 'Mind map expansion did not add all nodes')
  const node = expandedDetail.nodes.find((item) => item.title === '自定义节点')
  expect(node, 'Custom node from detailed mind map is missing')

  const renamedType = `decision2_${suffix.replaceAll('-', '_')}`
  await tool('update_setting', { id: setting.id, value: renamedType })
  const systemDetail = await tool('get_system', { id: system.id })
  expect(systemDetail.nodes.some((item) => Number(item.id) === Number(node.id) && item.node_type === renamedType), 'Node type rename did not migrate nodes')
  expect(systemDetail.system.original_prompt === originalPrompt, 'Mind map original prompt was not persisted')
  expect(Number.isInteger(systemDetail.quality?.score), 'Mind map completeness score is missing')

  const savedVersion = await tool('save_mindmap_version', { system_id:system.id, label:'E2E restore point' })
  await tool('update_system_node', { system_id:system.id, id:node.id, title:'temporary title' })
  await tool('restore_mindmap_version', { system_id:system.id, version_id:savedVersion.id })
  const restored = await tool('get_system', { id:system.id })
  expect(restored.nodes.some((item) => item.title === '自定义节点'), 'Whole mind map restore did not restore node content')
  expect((await tool('list_mindmap_versions',{system_id:system.id})).length >= 2, 'Mind map version history was not recorded')

  const duplicate = await tool('duplicate_mindmap',{system_id:system.id,name:`E2E 副本 ${suffix}`})
  duplicateId=duplicate.id
  const savedTemplate = await tool('save_mindmap_template',{system_id:system.id,name:`E2E 模板 ${suffix}`})
  templateId=savedTemplate.id
  const templateList=await tool('list_mindmap_templates')
  expect(templateList.some((item)=>Number(item.id)===Number(templateId)), 'Mind map template was not listed')
  const fromTemplate=await tool('create_mindmap_from_template',{template_id:templateId,name:`E2E 模板副本 ${suffix}`})
  fromTemplateId=fromTemplate.id

  const blockedDelete = await rpc('tools/call', { name: 'delete_setting', arguments: { id: setting.id } })
  expect(blockedDelete.body.result?.isError === true, 'Deleting an in-use node type must fail')

  const trade = await tool('add_trade', { symbol: 'E2E', entry_time: '2026-08-28 10:00', notes: 'notes-persisted', trading_system_id: systemId })
  tradeId = trade.id
  const tradeDetail = await tool('get_trade', { id: trade.id })
  expect(Boolean(tradeDetail.strategy_snapshot_locked),'Trade did not lock its mind map snapshot')
  expect(tradeDetail.review === 'notes-persisted', 'Trade notes were not persisted')
  expect(tradeDetail.risk_reward_ratio === null, 'Missing risk/reward ratio must remain null')

  const invalidImage = await rpc('tools/call', { name: 'upload_chart_image', arguments: {
    image_base64: 'bm90LWEtcG5n', filename: 'fake.png', mime_type: 'image/png'
  } })
  expect(invalidImage.body.result?.isError === true, 'Image magic-byte validation did not reject fake PNG data')

  const onePixelPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZL0sAAAAASUVORK5CYII='
  const imageCategory = await tool('add_setting', {
    category: 'image_category',
    label: `E2E 图片 ${suffix}`,
    value: `E2E 图片 ${suffix}`,
    color: '#3ec9c5'
  })
  imageCategoryId = imageCategory.id
  const image = await tool('upload_chart_image', {
    image_base64: onePixelPng,
    filename: 'pixel.png',
    mime_type: 'image/png',
    display_name: 'MCP 分类图片',
    category: `E2E 图片 ${suffix}`,
    tags: 'e2e,category',
    caption: 'MCP E2E'
  })
  imageId = image.id
  expect(new URL(image.url).origin === new URL(endpoint).origin, 'Image URL is not absolute')
  const imageResponse = await fetch(image.url)
  expect(imageResponse.status === 200, 'Public image URL is not reachable')
  expect(imageResponse.headers.get('content-type') === 'image/png', 'Public image has the wrong MIME type')
  expect(imageResponse.headers.get('content-disposition')?.startsWith('inline'), 'Public image is not served inline')

  const categorized = await tool('list_images', { category: `E2E 图片 ${suffix}` })
  expect(categorized.images.some((item) => Number(item.id) === Number(image.id)), 'Category filter did not return the uploaded image')
  const renamedCategory = `E2E 已改名 ${suffix}`
  await tool('update_setting', { id: imageCategory.id, label: renamedCategory, value: renamedCategory })
  const renamedImage = await tool('get_image', { id: image.id })
  expect(renamedImage.category === renamedCategory, 'Image category rename did not migrate existing images')
  await tool('delete_setting', { id: imageCategory.id })
  imageCategoryId = undefined
  const unclassifiedImage = await tool('get_image', { id: image.id })
  expect(!unclassifiedImage.category, 'Deleting a category did not move images to unclassified')
  const unclassified = await tool('list_images', { uncategorized: true })
  expect(unclassified.images.some((item) => Number(item.id) === Number(image.id)), 'Uncategorized filter did not return the image')

  const rules = await tool('list_rules')
  console.log(JSON.stringify({
    tools: tools.length,
    rules: rules.length,
    modernProtocol: '2026-07-28',
    inlineImageMime: imageResponse.headers.get('content-type'),
    customNodeType: true,
    detailedMindmapNodes: expandedDetail.nodes.length,
    mindmapCategories: true,
    imageCategories: true,
    tradeNotes: true,
    negativeAuth: true,
    readOnlyPermission: Boolean(readToken),
    imageMagicBytes: true,
    cleanup: true
  }))
} finally {
  await cleanup()
}
