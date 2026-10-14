const endpoint = process.env.MCP_URL || 'http://127.0.0.1:8790/api/mcp'
const token = process.env.MCP_TOKEN
const readToken = process.env.MCP_READ_TOKEN

if (!token) throw new Error('MCP_TOKEN is required')

const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
let requestId = 0
let tradeId

function expect(condition, message) {
  if (!condition) throw new Error(message)
}

async function storedTokenForm(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  const hex = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
  return `sha256$${hex}$${value.slice(-4)}`
}

async function rpc(method, params = {}, extraHeaders = {}) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { ...headers, ...extraHeaders },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params })
  })
  return { response, body: await response.json() }
}

async function tool(name, args = {}) {
  const { body } = await rpc('tools/call', { name, arguments: args })
  if (body.error || body.result?.isError) throw new Error(`${name} failed: ${JSON.stringify(body)}`)
  return body.result.structuredContent
}

try {
  const getResponse = await fetch(endpoint)
  expect(getResponse.status === 405, 'GET must return 405')
  expect(getResponse.headers.get('allow') === 'POST, OPTIONS', 'GET must advertise allowed methods')

  const unauthorized = await fetch(endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'unauthorized', method: 'ping', params: {} })
  })
  expect(unauthorized.status === 401, 'Missing token must return 401')

  const digestAsBearer = await rpc('ping', {}, { Authorization: `Bearer ${await storedTokenForm(token)}` })
  expect(digestAsBearer.response.status === 401, 'Stored token digest must not be accepted')

  const discover = await rpc('server/discover', {
    _meta: {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientInfo': { name: 'trading-journal-e2e', version: '2.3.0' },
      'io.modelcontextprotocol/clientCapabilities': {}
    }
  })
  expect(discover.body.result?.supportedVersions?.includes('2026-07-28'), 'Modern discovery failed')

  const initialize = await rpc('initialize', { protocolVersion: '2099-01-01' })
  expect(initialize.body.result?.protocolVersion === '2025-11-25', 'Legacy version counter-offer failed')

  const listed = await rpc('tools/list')
  const tools = listed.body.result?.tools || []
  const names = tools.map(item => item.name)
  expect(tools.length === 17, `Expected 17 compact tools, received ${tools.length}`)
  expect(names.includes('upload_chart_image'), 'Daily chart upload tool is missing')
  expect(tools.find(item => item.name === 'upload_chart_image')?.inputSchema?.required?.includes('trade_date'), 'Daily chart date is not required')
  for (const removed of ['get_market_candles', 'refine_mindmap', 'add_setting', 'reconcile_images']) {
    expect(!names.includes(removed), `Removed tool is still exposed: ${removed}`)
    const response = await rpc('tools/call', { name: removed, arguments: {} })
    expect(response.response.status === 400 && response.body.error?.code === -32602, `Removed tool is still callable: ${removed}`)
  }

  if (readToken) {
    const readOnlyWrite = await rpc('tools/call', { name: 'add_trade', arguments: { symbol: 'forbidden', entry_time: '2026-10-14' } }, { Authorization: `Bearer ${readToken}` })
    expect(readOnlyWrite.body.result?.isError === true, 'Read-only token must not call write tools')
  }

  const trade = await tool('add_trade', {
    symbol: 'MCP-E2E', entry_time: '2026-10-14 10:00', direction: '多', timeframe: '5M,15M', lots: 1, notes: 'compact-tool-test'
  })
  tradeId = trade.id
  await tool('update_trade', { id: trade.id, return_amount: 12.5, result: '胜' })
  const detail = await tool('get_trade', { id: trade.id })
  expect(detail.review === 'compact-tool-test' && detail.return_amount === 12.5, 'Trade write/read flow failed')
  expect((await tool('list_trades', { symbol: 'MCP-E2E' })).trades.some(item => Number(item.id) === Number(trade.id)), 'Trade list filter failed')
  await tool('get_stats')
  await tool('get_trend', { granularity: 'day' })
  await tool('list_rules')
  await tool('list_systems')
  await tool('list_images', { limit: 1 })

  const invalidDate = await rpc('tools/call', { name: 'upload_chart_image', arguments: { image_base64: 'bm90LWEtcG5n', trade_date: '2026-02-31' } })
  expect(invalidDate.body.result?.isError === true, 'Invalid daily chart date was not rejected')

  console.log(JSON.stringify({ tools: tools.length, compactCatalog: true, dailyChartDate: true, tradeFlow: true, negativeAuth: true }))
} finally {
  if (tradeId) await tool('delete_trade', { id: tradeId }).catch(() => {})
}
