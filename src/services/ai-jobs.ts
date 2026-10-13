export function isRetryableAiJobError(message: string): boolean {
  return /请求超时|timeout|timed out|429|rate.?limit|temporar|network|fetch failed|connection|\b5\d\d\b|service unavailable|gateway/i.test(message);
}

export function chooseAiJobFailureMessage(
  existing: string | undefined | null,
  incoming: string
): string {
  const current = String(existing || '').trim();
  const next = String(incoming || 'AI 后台任务失败').trim();
  const workflowInternalError = /internal workflows error|workflow.*internal/i;
  return workflowInternalError.test(next) && current && !workflowInternalError.test(current)
    ? current
    : next;
}

export async function failAiJobPreservingCause(
  env: Bindings,
  id: string,
  error: unknown
): Promise<string> {
  const incoming = aiErrorMessage(error).slice(0, 500);
  const row = await env.DB.prepare('SELECT error FROM ai_jobs WHERE id=?')
    .bind(id).first<{ error: string | null }>();
  const message = chooseAiJobFailureMessage(row?.error, incoming).slice(0, 500);
  await updateAiJob(env, id, 'failed', { error: message });
  return message;
}
import type { Bindings } from '../app-types';
import { aiErrorMessage } from './ai-protocol';

export async function createAiJob(
  env: Bindings,
  kind: 'mindmap_refinement',
  targetId: string
): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE ai_jobs SET status='failed',error=COALESCE(NULLIF(error,''),'后台任务超过 30 分钟未更新，已自动结束'),completed_at=datetime('now'),updated_at=datetime('now')
       WHERE status IN ('queued','running') AND updated_at < datetime('now','-30 minutes')`
    ),
    env.DB.prepare('INSERT INTO ai_jobs(id,kind,target_id,status) VALUES(?,?,?,?)')
      .bind(id, kind, targetId, 'queued'),
    env.DB.prepare("DELETE FROM ai_jobs WHERE completed_at < datetime('now','-30 days')")
  ]);
  return id;
}

export async function updateAiJob(
  env: Bindings,
  id: string,
  status: 'running' | 'completed' | 'failed',
  values: { result?: unknown; error?: string } = {}
): Promise<void> {
  await env.DB.prepare(
    `UPDATE ai_jobs SET status=?,result_json=CASE WHEN ?='running' THEN NULL ELSE COALESCE(?,result_json) END,error=?,updated_at=datetime('now'),completed_at=CASE WHEN ? IN ('completed','failed') THEN datetime('now') ELSE NULL END WHERE id=?`
  ).bind(
    status,
    status,
    values.result === undefined ? null : JSON.stringify(values.result),
    values.error || null,
    status,
    id
  ).run();
}
