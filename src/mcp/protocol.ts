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
export const MCP_SERVER_INFO = { name: 'trading-journal-mcp', version: '2.3.0' };
export const MCP_INSTRUCTIONS = '用于管理交易日志、统计、规则、脑图和每日 K 线截图。每天只需通过 upload_chart_image 为交易日期上传一张全天走势图，同一天的全部交易会共用该图片。创建完整脑图时使用 create_detailed_mindmap。关联交易系统时会锁定当时的完整脑图快照。写操作需要 write 或 admin 密钥。';

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
