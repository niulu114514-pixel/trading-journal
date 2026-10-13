export type AiProtocol = 'responses' | 'chat_completions';
export type AiUsage = { input_tokens: number; output_tokens: number; total_tokens: number; neurons?: number };
export type AiProviderResult = {
  data: any;
  provider: 'primary' | 'cloudflare';
  model: string;
  protocol: AiProtocol;
  primaryError?: string;
  fallbackMessages?: any[];
  usage?: AiUsage | null;
};

const CF_MODEL_NEURON_RATES: Record<string, { input: number; output: number }> = {
  '@cf/meta/llama-3.2-1b-instruct': { input: 2457, output: 18252 },
  '@cf/meta/llama-3.2-3b-instruct': { input: 4625, output: 30475 },
  '@cf/meta/llama-3.1-8b-instruct-fp8-fast': { input: 4119, output: 34868 },
  '@cf/qwen/qwen3-30b-a3b-fp8': { input: 4625, output: 30475 },
  '@cf/openai/gpt-oss-20b': { input: 18182, output: 27273 },
  '@cf/google/gemma-4-26b-a4b-it': { input: 9091, output: 27273 },
  '@cf/zai-org/glm-4.7-flash': { input: 9091, output: 27273 },
  '@cf/meta/llama-4-scout-17b-16e-instruct': { input: 24570, output: 54130 }
};

export function normalizeAiUsage(raw: any): AiUsage | null {
  if (!raw || typeof raw !== 'object') return null;
  const input = Number(raw.input_tokens ?? raw.prompt_tokens ?? 0);
  const output = Number(raw.output_tokens ?? raw.completion_tokens ?? 0);
  const total = Number(raw.total_tokens ?? input + output);
  if (![input, output, total].some(Number.isFinite)) return null;
  return {
    input_tokens: Math.max(0, input || 0),
    output_tokens: Math.max(0, output || 0),
    total_tokens: Math.max(0, total || input + output)
  };
}

export function cloudflareNeurons(model: string, usage: AiUsage): number | undefined {
  const rates = CF_MODEL_NEURON_RATES[model];
  return rates ? (usage.input_tokens * rates.input + usage.output_tokens * rates.output) / 1_000_000 : undefined;
}

export function resolveAiEndpoint(rawUrl: string, requested = 'auto'): { endpoint: string; protocol: AiProtocol } {
  const url = new URL(rawUrl || 'https://api.openai.com/v1');
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('AI API 地址只支持 HTTP 或 HTTPS');
  const path = url.pathname.replace(/\/+$/, '');
  const detected: AiProtocol | null = /\/chat\/completions$/i.test(path)
    ? 'chat_completions'
    : /\/responses$/i.test(path) ? 'responses' : null;
  const protocol: AiProtocol = requested === 'chat_completions' || requested === 'responses'
    ? requested
    : detected || 'responses';
  const basePath = path.replace(/\/(?:chat\/completions|responses)$/i, '');
  url.pathname = `${basePath}/${protocol === 'chat_completions' ? 'chat/completions' : 'responses'}`.replace(/\/{2,}/g, '/');
  return { endpoint: url.toString(), protocol };
}

export function resolveAiModelsEndpoint(rawUrl: string): string {
  const url = new URL(rawUrl || 'https://api.openai.com/v1');
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('AI API 地址只支持 HTTP 或 HTTPS');
  const path = url.pathname.replace(/\/+$/, '').replace(/\/(?:chat\/completions|responses)$/i, '');
  url.pathname = `${path}/models`.replace(/\/{2,}/g, '/');
  url.search = '';
  return url.toString();
}

export function aiText(data: any, protocol: AiProtocol): string {
  if (protocol === 'chat_completions') {
    if (typeof data?.response === 'string') return data.response.trim();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content === 'string') return content.trim();
    if (Array.isArray(content)) return content.map(item => item?.text || item?.content || '').join('\n').trim();
    return '';
  }
  const output = Array.isArray(data?.output) ? data.output : [];
  return String(data?.output_text || output.flatMap((item: any) => item.content || [])
    .filter((item: any) => item.type === 'output_text').map((item: any) => item.text).join('\n')).trim();
}

export function aiErrorMessage(error: unknown, timeoutMs = 45_000): string {
  if (error instanceof DOMException && error.name === 'TimeoutError') return `请求超时（${Math.ceil(timeoutMs / 1000)} 秒）`;
  if (error instanceof DOMException && error.name === 'AbortError') return '请求已取消';
  return error instanceof Error ? error.message : String(error);
}

export type AiCallOptions = {
  skipPrimary?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  onDelta?: (delta: string) => void;
  onReset?: () => void;
};

export function aiRequestSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export function isReadableByteStream(value: unknown): value is ReadableStream<Uint8Array> {
  return !!value && typeof (value as ReadableStream<Uint8Array>).getReader === 'function';
}

type StreamToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };

export async function consumeAiEventStream(
  stream: ReadableStream<Uint8Array>,
  protocol: AiProtocol,
  onDelta?: (delta: string) => void
): Promise<any> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let usage: any = null;
  let completedResponse: any = null;
  const chatTools = new Map<number, StreamToolCall>();
  const responseItems = new Map<number, any>();

  const appendText = (delta: unknown) => {
    if (typeof delta !== 'string' || !delta) return;
    text += delta;
    onDelta?.(delta);
  };
  const mergeChatTool = (item: any, fallbackIndex: number) => {
    const index = Number.isInteger(Number(item?.index)) ? Number(item.index) : fallbackIndex;
    const current = chatTools.get(index) || {
      id: String(item?.id || `call_${index}`), type: 'function' as const, function: { name: '', arguments: '' }
    };
    if (item?.id) current.id = String(item.id);
    const fn = item?.function || item;
    if (fn?.name) current.function.name += String(fn.name);
    if (fn?.arguments !== undefined) {
      current.function.arguments += typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments);
    }
    chatTools.set(index, current);
  };
  const processPayload = (eventName: string, payload: any) => {
    if (!payload || typeof payload !== 'object') return;
    const eventType = String(payload.type || eventName || '');
    if (payload.error) throw new Error(String(payload.error?.message || payload.error).slice(0, 500));
    if (payload.usage) usage = payload.usage;
    if (protocol === 'responses') {
      if (eventType === 'response.output_text.delta') appendText(payload.delta);
      if (eventType === 'response.output_item.added' && payload.item) {
        responseItems.set(Number(payload.output_index || 0), { ...payload.item });
      }
      if (eventType === 'response.function_call_arguments.delta') {
        const index = Number(payload.output_index || 0);
        const current = responseItems.get(index) || {
          type: 'function_call', id: payload.item_id, call_id: payload.item_id, name: '', arguments: ''
        };
        current.arguments = String(current.arguments || '') + String(payload.delta || '');
        responseItems.set(index, current);
      }
      if (eventType === 'response.output_item.done' && payload.item) {
        responseItems.set(Number(payload.output_index || 0), payload.item);
      }
      if (eventType === 'response.completed' && payload.response) {
        completedResponse = payload.response;
        usage = payload.response.usage || usage;
      }
      return;
    }

    for (const choice of Array.isArray(payload.choices) ? payload.choices : []) {
      const delta = choice?.delta || choice?.message || {};
      appendText(typeof delta.content === 'string' ? delta.content : undefined);
      for (const [index, tool] of (Array.isArray(delta.tool_calls) ? delta.tool_calls : []).entries()) {
        mergeChatTool(tool, index);
      }
    }
    if (!Array.isArray(payload.choices)) appendText(payload.response);
    for (const [index, tool] of (Array.isArray(payload.tool_calls) ? payload.tool_calls : []).entries()) {
      mergeChatTool(tool, index);
    }
  };
  const processBlock = (block: string) => {
    let eventName = '';
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) eventName = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    const raw = data.join('\n').trim();
    if (!raw || raw === '[DONE]') return;
    try { processPayload(eventName, JSON.parse(raw)); }
    catch (error) {
      if (error instanceof SyntaxError) return;
      throw error;
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() || '';
    for (const block of blocks) processBlock(block);
  }
  buffer += decoder.decode();
  if (buffer.trim()) processBlock(buffer);

  if (protocol === 'responses') {
    if (completedResponse) return completedResponse;
    const output = [...responseItems.entries()].sort(([a], [b]) => a - b).map(([, item]) => item);
    if (text) output.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
    return { output, output_text: text, usage };
  }
  const toolCalls = [...chatTools.entries()].sort(([a], [b]) => a - b).map(([, item]) => item);
  return {
    choices: [{ message: { role: 'assistant', content: text || null, tool_calls: toolCalls } }],
    response: text,
    tool_calls: toolCalls,
    usage
  };
}
