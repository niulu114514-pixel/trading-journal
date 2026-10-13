import type { Bindings } from '../app-types';
import {
  aiErrorMessage,
  aiRequestSignal,
  aiText,
  consumeAiEventStream,
  isReadableByteStream,
  normalizeAiUsage,
  resolveAiEndpoint,
  type AiCallOptions,
  type AiProtocol,
  type AiProviderResult
} from './ai-protocol';
import { assertCloudflareNeuronBudget, recordCloudflareAiUsage } from './ai-usage';

export async function callConfiguredAi(
  env: Bindings,
  config: Record<string, string>,
  protocol: AiProtocol,
  payload: Record<string, unknown>,
  rawOptions: boolean | AiCallOptions = {}
): Promise<AiProviderResult> {
  const options: AiCallOptions = typeof rawOptions === 'boolean' ? { skipPrimary: rawOptions } : rawOptions;
  const skipPrimary = options.skipPrimary === true;
  const timeoutMs = Math.max(10_000, Math.min(300_000, Number(options.timeoutMs || 45_000)));
  let primaryError = '';
  if (!skipPrimary && config.ai_api_key && config.ai_model) {
    try {
      const { endpoint } = resolveAiEndpoint(config.ai_base_url || 'https://api.openai.com/v1', protocol);
      const streaming = Boolean(options.onDelta);
      const requestPayload: Record<string, unknown> = { ...payload, model: config.ai_model };
      if (streaming) {
        requestPayload.stream = true;
        if (protocol === 'chat_completions') requestPayload.stream_options = { include_usage: true };
      }
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.ai_api_key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(requestPayload),
        signal: aiRequestSignal(timeoutMs, options.signal)
      });
      if (!response.ok) {
        const errorData = await response.json<any>().catch(() => null);
        throw new Error(String(errorData?.error?.message || `上游响应 ${response.status}`).slice(0, 500));
      }
      const eventStream = streaming && response.body && /text\/event-stream/i.test(response.headers.get('Content-Type') || '');
      const data = eventStream
        ? await consumeAiEventStream(response.body!, protocol, options.onDelta)
        : await response.json<any>().catch(() => null);
      if (!data) throw new Error('上游未返回可解析的数据');
      if (streaming && !eventStream) {
        const delta = aiText(data, protocol);
        if (delta) options.onDelta?.(delta);
      }
      return { data, provider: 'primary', model: config.ai_model, protocol, usage: normalizeAiUsage(data.usage) };
    } catch (error) {
      if (options.signal?.aborted) throw error;
      primaryError = aiErrorMessage(error, timeoutMs).slice(0, 500);
      if (options.onDelta && config.ai_cf_fallback_enabled !== 'false') options.onReset?.();
    }
  } else if (!skipPrimary) {
    primaryError = '主模型配置不完整';
  } else {
    primaryError = '此前主模型请求失败，本轮继续使用备用模型';
  }

  if (config.ai_cf_fallback_enabled === 'false') throw new Error(`主模型不可用：${primaryError}`);
  const model = config.ai_cf_fallback_model || '@cf/meta/llama-3.2-3b-instruct';
  try {
    const fallbackMessages: any[] = protocol === 'chat_completions'
      ? [...((payload.messages as any[]) || [])]
      : [{ role: 'system', content: String(payload.instructions || '') }, ...((payload.input as any[]) || []).flatMap(item => {
          if (item?.role && typeof item.content === 'string') return [{ role: item.role, content: item.content }];
          if (item?.type === 'function_call') {
            return [{ role: 'assistant', content: null, tool_calls: [{
              id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments || '{}' }
            }] }];
          }
          if (item?.type === 'function_call_output') {
            return [{ role: 'tool', tool_call_id: item.call_id, content: item.output || '' }];
          }
          return [];
        })];
    const fallbackTools = protocol === 'chat_completions'
      ? payload.tools
      : Array.isArray(payload.tools)
        ? (payload.tools as any[]).map(tool => ({
            type: 'function',
            function: { name: tool.name, description: tool.description, parameters: tool.parameters, strict: false }
          }))
        : undefined;
    const maxTokens = Number(payload.max_tokens || payload.max_output_tokens || 4000);
    await assertCloudflareNeuronBudget(
      env.DB, config, model, Math.ceil(JSON.stringify(fallbackMessages).length / 4), maxTokens
    );
    const fallbackPayload: Record<string, unknown> = {
      messages: fallbackMessages,
      max_tokens: maxTokens,
      stream: Boolean(options.onDelta)
    };
    if (fallbackTools) Object.assign(fallbackPayload, { tools: fallbackTools, tool_choice: 'auto' });
    const rawData = await (env.AI as any).run(model, fallbackPayload, {
      signal: aiRequestSignal(timeoutMs, options.signal)
    });
    if (!rawData) throw new Error('Cloudflare Workers AI 未返回数据');
    const streamResponse = isReadableByteStream(rawData);
    const data = streamResponse
      ? await consumeAiEventStream(rawData, 'chat_completions', options.onDelta)
      : rawData;
    if (options.onDelta && !streamResponse) {
      const delta = aiText(data, 'chat_completions');
      if (delta) options.onDelta(delta);
    }
    const usage = await recordCloudflareAiUsage(env.DB, model, data.usage);
    return { data, provider: 'cloudflare', model, protocol: 'chat_completions', primaryError, fallbackMessages, usage };
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new Error(
      `主模型不可用：${primaryError}；Cloudflare 备用模型失败：${aiErrorMessage(error, timeoutMs).slice(0, 500)}`
    );
  }
}

export async function runAiText(
  env: Bindings,
  config: Record<string, string>,
  instructions: string,
  prompt: string,
  maxTokens: number,
  timeoutMs = 45_000
): Promise<AiProviderResult & { text: string; protocol: AiProtocol }> {
  const primaryConfigured = Boolean(config.ai_api_key && config.ai_model);
  const resolved = primaryConfigured
    ? resolveAiEndpoint(config.ai_base_url || 'https://api.openai.com/v1', config.ai_api_format || 'auto')
    : { protocol: 'responses' as AiProtocol };
  const payload = resolved.protocol === 'chat_completions'
    ? { messages: [{ role: 'system', content: instructions }, { role: 'user', content: prompt }], max_tokens: maxTokens }
    : { instructions, input: [{ role: 'user', content: prompt }], store: false, max_output_tokens: maxTokens };
  const result = await callConfiguredAi(env, config, resolved.protocol, payload, { timeoutMs });
  return { ...result, text: aiText(result.data, result.protocol) };
}
