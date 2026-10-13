import type { Bindings } from '../app-types';

export type MaintenanceJobKind =
  | 'verify_backup'
  | 'restore_backup'
  | 'delete_folder'
  | 'reconcile_images';

export async function createMaintenanceJob(
  env: Bindings,
  kind: MaintenanceJobKind,
  targetId?: string
): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO maintenance_jobs(id,kind,target_id,status) VALUES(?,?,?,?)')
      .bind(id, kind, targetId || null, 'queued'),
    env.DB.prepare("DELETE FROM maintenance_jobs WHERE completed_at < datetime('now','-30 days')")
  ]);
  return id;
}

export async function updateMaintenanceJob(
  env: Bindings,
  id: string,
  status: 'running' | 'completed' | 'failed',
  values: { progress?: number; total?: number; result?: unknown; error?: string } = {}
): Promise<void> {
  await env.DB.prepare(
    `UPDATE maintenance_jobs SET status=?,progress=COALESCE(?,progress),total=COALESCE(?,total),result_json=COALESCE(?,result_json),error=?,updated_at=datetime('now'),completed_at=CASE WHEN ? IN ('completed','failed') THEN datetime('now') ELSE completed_at END WHERE id=?`
  ).bind(
    status,
    values.progress ?? null,
    values.total ?? null,
    values.result === undefined ? null : JSON.stringify(values.result),
    values.error || null,
    status,
    id
  ).run();
}
