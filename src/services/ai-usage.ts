import { aiErrorMessage, cloudflareNeurons, normalizeAiUsage, type AiUsage } from './ai-protocol';

export type CloudflareAccountAiUsage = {
  requests: number;
  input_tokens: number;
  output_tokens: number;
  neurons: number;
};

export async function recordCloudflareAiUsage(db: D1Database, model: string, rawUsage: any): Promise<AiUsage | null> {
  const usage = normalizeAiUsage(rawUsage);
  if (!usage) return null;
  usage.neurons = cloudflareNeurons(model, usage);
  const day = new Date().toISOString().slice(0, 10);
  await db.prepare(
    'INSERT OR IGNORE INTO ai_daily_usage(usage_date,cf_requests,cf_estimated_tokens,cf_actual_requests,cf_input_tokens,cf_output_tokens,cf_neurons) VALUES(?,0,0,0,0,0,0)'
  ).bind(day).run();
  await db.prepare(
    `UPDATE ai_daily_usage SET cf_actual_requests=cf_actual_requests+1,cf_input_tokens=cf_input_tokens+?,
     cf_output_tokens=cf_output_tokens+?,cf_neurons=cf_neurons+?,updated_at=datetime('now') WHERE usage_date=?`
  ).bind(usage.input_tokens, usage.output_tokens, usage.neurons || 0, day).run();
  return usage;
}

export async function localCloudflareAiUsage(db: D1Database, day: string): Promise<CloudflareAccountAiUsage> {
  const row = await db.prepare(
    'SELECT cf_actual_requests,cf_input_tokens,cf_output_tokens,cf_neurons FROM ai_daily_usage WHERE usage_date=?'
  ).bind(day).first<{ cf_actual_requests: number; cf_input_tokens: number; cf_output_tokens: number; cf_neurons: number }>();
  return {
    requests: Number(row?.cf_actual_requests || 0),
    input_tokens: Number(row?.cf_input_tokens || 0),
    output_tokens: Number(row?.cf_output_tokens || 0),
    neurons: Number(row?.cf_neurons || 0)
  };
}

export async function cloudflareAccountAiUsage(
  config: Record<string, string>,
  day: string
): Promise<CloudflareAccountAiUsage> {
  if (!config.ai_cf_account_id || !config.ai_cf_api_token) {
    throw new Error('未配置 Cloudflare Account ID 或 Workers AI Read Token');
  }
  const query = `query AccountAiUsage($accountTag: string!, $date: Date!) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        aiInferenceAdaptiveGroups(limit: 10, filter: { date: $date }) {
          count
          sum { totalNeurons totalInputTokens totalOutputTokens }
        }
      }
    }
  }`;
  const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.ai_cf_api_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: { accountTag: config.ai_cf_account_id, date: day } }),
    signal: AbortSignal.timeout(15_000)
  });
  const data = await response.json<any>().catch(() => null);
  if (!response.ok || !data || data.errors?.length) {
    throw new Error(String(data?.errors?.[0]?.message || `Cloudflare Analytics 响应 ${response.status}`).slice(0, 500));
  }
  const groups = data?.data?.viewer?.accounts?.[0]?.aiInferenceAdaptiveGroups;
  if (!Array.isArray(groups)) throw new Error('Cloudflare Analytics 未返回 Workers AI 用量');
  return groups.reduce((total: CloudflareAccountAiUsage, group: any) => ({
    requests: total.requests + Number(group?.count || 0),
    input_tokens: total.input_tokens + Number(group?.sum?.totalInputTokens || 0),
    output_tokens: total.output_tokens + Number(group?.sum?.totalOutputTokens || 0),
    neurons: total.neurons + Number(group?.sum?.totalNeurons || 0)
  }), { requests: 0, input_tokens: 0, output_tokens: 0, neurons: 0 });
}

export async function resolveCloudflareAiUsage(db: D1Database, config: Record<string, string>, day: string) {
  const local = await localCloudflareAiUsage(db, day);
  try {
    const account = await cloudflareAccountAiUsage(config, day);
    return { source: 'cloudflare_account' as const, effective_neurons: Math.max(account.neurons, local.neurons), account, local };
  } catch (error) {
    return {
      source: 'local_fallback' as const,
      effective_neurons: local.neurons,
      account: null,
      local,
      warning: aiErrorMessage(error)
    };
  }
}

export async function assertCloudflareNeuronBudget(
  db: D1Database,
  config: Record<string, string>,
  model: string,
  estimatedInputTokens: number,
  maxOutputTokens: number
): Promise<void> {
  const neuronLimit = Math.max(0, Math.min(10_000, Number(config.ai_cf_daily_neuron_limit || 9000)));
  if (!neuronLimit) throw new Error('Cloudflare Workers AI 神经元保护已关闭备用模型');
  const usage = await resolveCloudflareAiUsage(db, config, new Date().toISOString().slice(0, 10));
  const projected = cloudflareNeurons(model, {
    input_tokens: estimatedInputTokens,
    output_tokens: maxOutputTokens,
    total_tokens: estimatedInputTokens + maxOutputTokens
  }) || 0;
  if (usage.effective_neurons >= neuronLimit || usage.effective_neurons + projected > neuronLimit) {
    const projectedText = projected ? `，本次预计最多 ${projected.toFixed(2)}` : '';
    throw new Error(
      `Cloudflare Workers AI 神经元保护已触发（账户今日 ${usage.effective_neurons.toFixed(2)}${projectedText} / ${neuronLimit} neurons）`
    );
  }
}
