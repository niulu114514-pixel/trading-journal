import type { MindmapSnapshot } from '../domain/mindmap';

export async function captureTradeStrategySnapshot(
  db: D1Database,
  tradeId: number,
  systemId: number | null | undefined,
  loadMindmapSnapshot: (db: D1Database, systemId: number) => Promise<MindmapSnapshot>
): Promise<void> {
  await db.prepare('DELETE FROM trade_strategy_snapshots WHERE trade_id=?').bind(tradeId).run();
  if (!systemId) return;
  const snapshot = await loadMindmapSnapshot(db, systemId);
  const version = await db.prepare('SELECT id FROM mindmap_versions WHERE system_id=? ORDER BY id DESC LIMIT 1')
    .bind(systemId).first<{ id: number }>();
  await db.prepare(
    'INSERT INTO trade_strategy_snapshots(trade_id,system_id,system_name,version_id,snapshot_json) VALUES(?,?,?,?,?)'
  ).bind(tradeId, systemId, String(snapshot.system.name || '已删除脑图'), version?.id || null, JSON.stringify(snapshot)).run();
}
