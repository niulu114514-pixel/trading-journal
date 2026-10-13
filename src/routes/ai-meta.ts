import type { Hono } from 'hono';
import type { AppEnv } from '../app-types';
import {
  aiErrorMessage,
  aiText,
  normalizeAiUsage,
  resolveAiEndpoint,
  resolveAiModelsEndpoint
} from '../services/ai-protocol';
import { callConfiguredAi } from '../services/ai-provider';
import { resolveCloudflareAiUsage } from '../services/ai-usage';
import { getAllConfig } from '../services/config';

const CURATED_CLOUDFLARE_MODELS = new Map<string, string>([
  ['@cf/qwen/qwen3-30b-a3b-fp8', 'Qwen3 30B A3B（推荐，中文与工具调用）'],
  ['@cf/meta/llama-3.2-3b-instruct', 'Llama 3.2 3B（低成本稳定）'],
  ['@cf/meta/llama-3.2-1b-instruct', 'Llama 3.2 1B（最低成本）'],
  ['@cf/meta/llama-3.1-8b-instruct-fp8-fast', 'Llama 3.1 8B Fast（质量更高）'],
  ['@cf/openai/gpt-oss-20b', 'GPT OSS 20B（推理能力）'],
  ['@cf/google/gemma-4-26b-a4b-it', 'Gemma 4 26B A4B'],
  ['@cf/zai-org/glm-4.7-flash', 'GLM 4.7 Flash'],
  ['@cf/meta/llama-4-scout-17b-16e-instruct', 'Llama 4 Scout（高质量，成本较高）']
]);

export function registerAiMetaRoutes(app: Hono<AppEnv>): void {
  app.get('/api/ai/models', async context => {
    const config = await getAllConfig(context.env.DB, context.env.CONFIG_ENCRYPTION_KEY);
    const models = new Set<string>();
    if (config.ai_model) models.add(config.ai_model);
    let warning = '';
    if (config.ai_api_key) {
      try {
        const response = await fetch(resolveAiModelsEndpoint(config.ai_base_url || 'https://api.openai.com/v1'), {
          headers: { Authorization: `Bearer ${config.ai_api_key}` },
          signal: AbortSignal.any([context.req.raw.signal, AbortSignal.timeout(15_000)])
        });
        const data = await response.json<Record<string, unknown>>().catch(() => null);
        if (!response.ok || !data) {
          const error = data?.error && typeof data.error === 'object' ? data.error as Record<string, unknown> : null;
          throw new Error(String(error?.message || `上游响应 ${response.status}`));
        }
        const rawItems = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : [];
        for (const item of rawItems) {
          const record = item && typeof item === 'object' ? item as Record<string, unknown> : null;
          const id = String(typeof item === 'string' ? item : record?.id || record?.name || '').trim();
          if (id) models.add(id);
        }
      } catch (error) {
        warning = aiErrorMessage(error).slice(0, 300);
      }
    }

    const cloudflareModels = new Map(CURATED_CLOUDFLARE_MODELS);
    let cloudflareCatalogSource: 'curated' | 'account_api' = 'curated';
    let cloudflareWarning = '';
    if (config.ai_cf_account_id && config.ai_cf_api_token) {
      try {
        const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(config.ai_cf_account_id)}/ai/models/search?per_page=100`, {
          headers: { Authorization: `Bearer ${config.ai_cf_api_token}` },
          signal: AbortSignal.any([context.req.raw.signal, AbortSignal.timeout(15_000)])
        });
        const data = await response.json<Record<string, unknown>>().catch(() => null);
        const errors = Array.isArray(data?.errors) ? data.errors : [];
        const firstError = errors[0] && typeof errors[0] === 'object' ? errors[0] as Record<string, unknown> : null;
        if (!response.ok || data?.success === false) throw new Error(String(firstError?.message || `Cloudflare 响应 ${response.status}`));
        const result = data?.result;
        const resultRecord = result && typeof result === 'object' && !Array.isArray(result) ? result as Record<string, unknown> : null;
        const rawItems = Array.isArray(result) ? result : Array.isArray(resultRecord?.models) ? resultRecord.models : [];
        for (const item of rawItems) {
          const record = item && typeof item === 'object' ? item as Record<string, unknown> : null;
          if (!record) continue;
          const id = String(record.name || record.id || '').trim();
          const taskRecord = record.task && typeof record.task === 'object' ? record.task as Record<string, unknown> : null;
          const task = String(taskRecord?.name || record.task || '');
          if (id.startsWith('@cf/') && (!task || task.toLowerCase() === 'text generation')) {
            const description = String(record.description || '').trim().replace(/\s+/g, ' ');
            cloudflareModels.set(id, description ? `${id} · ${description.slice(0, 90)}` : id);
          }
        }
        cloudflareCatalogSource = 'account_api';
      } catch (error) {
        cloudflareWarning = aiErrorMessage(error).slice(0, 300);
      }
    }
    if (config.ai_cf_fallback_model && !cloudflareModels.has(config.ai_cf_fallback_model)) {
      cloudflareModels.set(config.ai_cf_fallback_model, config.ai_cf_fallback_model);
    }
    return context.json({
      models: [...models].sort(),
      warning: warning || undefined,
      cloudflare_models: [...cloudflareModels].map(([id, label]) => ({ id, label })),
      cloudflare_catalog_source: cloudflareCatalogSource,
      cloudflare_warning: cloudflareWarning || undefined
    });
  });

  app.get('/api/ai/cloudflare-usage', async context => {
    const config = await getAllConfig(context.env.DB, context.env.CONFIG_ENCRYPTION_KEY);
    const day = new Date().toISOString().slice(0, 10);
    const usage = await resolveCloudflareAiUsage(context.env.DB, config, day);
    return context.json({
      usage_date: day,
      neurons: usage.account?.neurons ?? usage.local.neurons,
      effective_neurons: usage.effective_neurons,
      neuron_limit: Number(config.ai_cf_daily_neuron_limit || 9000),
      source: usage.source,
      account_requests: usage.account?.requests ?? null,
      account_input_tokens: usage.account?.input_tokens ?? null,
      account_output_tokens: usage.account?.output_tokens ?? null,
      local_neurons: usage.local.neurons,
      local_requests: usage.local.requests,
      warning: usage.warning,
      reset_at: '00:00 UTC'
    });
  });

  app.post('/api/ai/test', async context => {
    const body: { provider?: string } = await context.req.json<{ provider?: string }>().catch(() => ({}));
    const provider = body.provider === 'cloudflare' ? 'cloudflare' : 'primary';
    const config = await getAllConfig(context.env.DB, context.env.CONFIG_ENCRYPTION_KEY);
    const started = Date.now();
    try {
      const result = provider === 'cloudflare'
        ? await callConfiguredAi(context.env, { ...config, ai_cf_fallback_enabled: 'true' }, 'chat_completions', { messages: [{ role: 'user', content: '只回复：连接正常' }], max_tokens: 32 }, true)
        : await callConfiguredAi(
            context.env,
            { ...config, ai_cf_fallback_enabled: 'false' },
            resolveAiEndpoint(config.ai_base_url || 'https://api.openai.com/v1', config.ai_api_format || 'auto').protocol,
            config.ai_api_format === 'chat_completions' || /chat\/completions/i.test(config.ai_base_url || '')
              ? { messages: [{ role: 'user', content: '只回复：连接正常' }], max_tokens: 32 }
              : { input: [{ role: 'user', content: '只回复：连接正常' }], max_output_tokens: 32, store: false }
          );
      return context.json({
        success: true,
        provider: result.provider,
        model: result.model,
        latency_ms: Date.now() - started,
        text: aiText(result.data, result.protocol),
        usage: result.usage || normalizeAiUsage(result.data?.usage)
      });
    } catch (error) {
      return context.json({ success: false, provider, latency_ms: Date.now() - started, error: aiErrorMessage(error) }, 502);
    }
  });
}
