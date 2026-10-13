export interface JsonRpcRequest {
  jsonrpc: string;
  method: string;
  params?: any;
  id: string | number | null;
}

export interface JsonRpcResponse {
  jsonrpc: string;
  result?: any;
  error?: { code: number; message: string; data?: any };
  id: string | number | null;
}

export const MCP_MODERN_VERSION = '2026-07-28';
export const MCP_LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const MCP_SUPPORTED_VERSIONS = [MCP_MODERN_VERSION, ...MCP_LEGACY_VERSIONS];
export const MCP_SERVER_INFO = { name: 'trading-journal-mcp', version: '2.2.0' };
export const MCP_INSTRUCTIONS = '用于管理交易日志、规则、脑图、自定义设置、图床和 K 线行情。创建完整脑图时必须优先使用 create_detailed_mindmap，根据主题复杂度提交足够具体的多层节点并保存 original_prompt；不要用 add_system 的通用骨架冒充完整结果。AI 整图精修先用 refine_mindmap 生成差异草稿，审阅后再用 apply_mindmap_refinement 应用，生成草稿不会直接覆盖。关联交易系统时会锁定当时的完整脑图快照。写操作需要 write 或 admin 密钥。';

export function jsonRpcError(
  code: number,
  message: string,
  id: string | number | null,
  data?: any
): JsonRpcResponse {
  return { jsonrpc: '2.0', error: { code, message, ...(data === undefined ? {} : { data }) }, id };
}

export function jsonRpcResult(result: any, id: string | number | null): JsonRpcResponse {
  return { jsonrpc: '2.0', result, id };
}
