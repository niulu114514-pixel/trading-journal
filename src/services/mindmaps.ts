import type { MindmapSnapshot } from '../domain/mindmap';
import { captureTradeStrategySnapshot as captureTradeStrategySnapshotService } from './trades';
import {
  normalizeMindmapNodeType,
} from './mindmap-nodes';
type MindmapQuality = { score:number; grade:'优秀'|'良好'|'待完善'; missing:string[]; metrics:{node_count:number;max_depth:number;top_level_count:number;detailed_nodes:number} };
export function calculateMindmapQuality(nodes: Record<string,any>[]): MindmapQuality {
  const usable = nodes.filter(node => node.parent_id !== null);
  const byId = new Map(nodes.map(node => [Number(node.id),node]));
  let maxDepth = 0;
  for (const node of usable) {
    let depth = 1, current:Record<string,any>|undefined = node, guard = 0;
    while (current?.parent_id && guard++ < 10) { depth++; current = byId.get(Number(current.parent_id)); }
    maxDepth = Math.max(maxDepth,depth);
  }
  const topLevelCount = usable.filter(node => byId.get(Number(node.parent_id))?.parent_id === null).length;
  const detailedNodes = usable.filter(node => String(node.content || '').trim().length >= 20).length;
  const corpus = usable.map(node => `${node.node_type} ${node.title} ${node.content || ''}`).join(' ').toLowerCase();
  const dimensions = [
    ['市场环境/前置过滤',/(setup|market|环境|趋势|结构|时段|过滤)/],
    ['入场条件',/(entry|入场|触发|确认)/],
    ['风险与仓位',/(risk|风险|止损|仓位|资金)/],
    ['持仓与出场',/(exit|出场|止盈|持仓|移动止损)/],
    ['复盘与失效条件',/(review|复盘|失效|禁止|偏差)/]
  ] as const;
  const missing = dimensions.filter(([,pattern]) => !pattern.test(corpus)).map(([label]) => label);
  const dimensionScore = (dimensions.length - missing.length) * 13;
  const depthScore = maxDepth >= 4 ? 12 : maxDepth >= 3 ? 9 : maxDepth >= 2 ? 5 : 0;
  const branchScore = Math.min(8,topLevelCount * 2);
  const detailRatio = usable.length ? detailedNodes / usable.length : 0;
  const detailScore = Math.round(detailRatio * 10);
  const countScore = usable.length >= 28 ? 5 : usable.length >= 16 ? 3 : usable.length >= 8 ? 1 : 0;
  const score = Math.min(100,dimensionScore + depthScore + branchScore + detailScore + countScore);
  return { score, grade:score >= 85 ? '优秀' : score >= 65 ? '良好' : '待完善', missing, metrics:{node_count:nodes.length,max_depth:maxDepth,top_level_count:topLevelCount,detailed_nodes:detailedNodes} };
}

export async function loadMindmapSnapshot(db:D1Database,systemId:number):Promise<MindmapSnapshot> {
  const system = await db.prepare('SELECT * FROM trading_systems WHERE id=?').bind(systemId).first<Record<string,unknown>>();
  if (!system) throw new Error('脑图不存在');
  const nodes = await db.prepare('SELECT * FROM trading_system_nodes WHERE system_id=? ORDER BY sort_order,id').bind(systemId).all<Record<string,unknown>>();
  return { version:1, system, nodes:nodes.results };
}

export async function captureTradeStrategySnapshot(db:D1Database,tradeId:number,systemId:number|null|undefined):Promise<void> {
  return captureTradeStrategySnapshotService(db,tradeId,systemId,loadMindmapSnapshot);
}

export async function saveMindmapVersion(db:D1Database,systemId:number,action:string,label?:string):Promise<number> {
  const snapshot = await loadMindmapSnapshot(db,systemId);
  const saved = await db.prepare('INSERT INTO mindmap_versions(system_id,action,label,snapshot_json) VALUES(?,?,?,?)')
    .bind(systemId,action,label || null,JSON.stringify(snapshot)).run();
  await db.batch([
    db.prepare(`UPDATE trade_strategy_snapshots SET version_id=NULL WHERE version_id IN (SELECT id FROM mindmap_versions WHERE system_id=? ORDER BY id DESC LIMIT -1 OFFSET 30)`).bind(systemId),
    db.prepare(`DELETE FROM mindmap_versions WHERE system_id=? AND id IN (SELECT id FROM mindmap_versions WHERE system_id=? ORDER BY id DESC LIMIT -1 OFFSET 30)`).bind(systemId,systemId)
  ]);
  return Number(saved.meta.last_row_id);
}

export function orderMindmapNodesParentFirst(nodes:Record<string,any>[]):Record<string,any>[] {
  const byId=new Map<number,Record<string,any>>();
  for(const node of nodes)byId.set(Number(node.id),node);
  const state=new Map<number,0|1|2>(),ordered:Record<string,any>[]=[];
  const visit=(node:Record<string,any>)=>{
    const id=Number(node.id),current=state.get(id)||0;
    if(current===2)return;
    if(current===1)throw new Error('脑图版本存在循环父子关系');
    state.set(id,1);
    if(node.parent_id!==null){
      const parent=byId.get(Number(node.parent_id));
      if(!parent)throw new Error('脑图版本引用了不存在的父节点');
      visit(parent);
    }
    state.set(id,2);ordered.push(node);
  };
  for(const node of nodes)visit(node);
  return ordered;
}

export async function replaceMindmapFromSnapshot(db:D1Database,systemId:number,snapshot:MindmapSnapshot):Promise<void> {
  if (!Array.isArray(snapshot?.nodes) || !snapshot.nodes.length || snapshot.nodes.length > 501) throw new Error('脑图版本快照无效');
  const typeRows=await db.prepare("SELECT value,label FROM settings WHERE category='system_node_type' AND is_active=1 ORDER BY sort_order,id").all<{value:string;label:string}>();
  if(!typeRows.results.length)throw new Error('没有可用的脑图节点类型，请先到设置中启用节点类型');
  const normalizedNodes:Record<string,any>[]=snapshot.nodes.map(node=>node.parent_id===null?{...node,node_type:'root'}:{...node,node_type:normalizeMindmapNodeType(node.node_type,node.title,node.content,typeRows.results)});
  const oldIds = new Set(normalizedNodes.map(node => Number(node.id)));
  if (normalizedNodes.some(node => !Number.isInteger(Number(node.id)) || (node.parent_id !== null && !oldIds.has(Number(node.parent_id))))) throw new Error('脑图版本节点关系无效');
  const roots = normalizedNodes.filter(node => node.parent_id === null);
  if (roots.length !== 1) throw new Error('脑图版本必须且只能包含一个根节点');
  const orderedNodes=orderMindmapNodesParentFirst(normalizedNodes);
  const maxRow = await db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM trading_system_nodes').first<{id:number}>();
  let nextId = Number(maxRow?.id || 0) + 1;
  const idMap = new Map<number,number>();
  for (const node of orderedNodes) idMap.set(Number(node.id),nextId++);
  const statements = [db.prepare('DELETE FROM trading_system_nodes WHERE system_id=?').bind(systemId)];
  for (const node of orderedNodes) statements.push(db.prepare(
    `INSERT INTO trading_system_nodes(id,system_id,parent_id,rule_id,title,content,node_type,sort_order,is_collapsed,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(idMap.get(Number(node.id)),systemId,node.parent_id === null ? null : idMap.get(Number(node.parent_id)),node.rule_id ?? null,String(node.title || ''),node.content ?? null,String(node.node_type || 'condition'),Number(node.sort_order)||0,Number(node.is_collapsed)||0,node.created_at || new Date().toISOString(),new Date().toISOString()));
  statements.push(db.prepare("UPDATE trading_systems SET name=?,category=?,description=?,resource_url=?,markets=?,timeframes=?,status=?,color=?,updated_at=datetime('now') WHERE id=?")
    .bind(snapshot.system.name,snapshot.system.category,snapshot.system.description ?? null,snapshot.system.resource_url ?? null,snapshot.system.markets ?? null,snapshot.system.timeframes ?? null,snapshot.system.status ?? 'draft',snapshot.system.color ?? '#3ec9c5',systemId));
  await db.batch(statements);
}

export async function cloneMindmap(db:D1Database,sourceId:number,options:{name?:string;category?:string;isTemplate?:boolean}={}) {
  const source = await loadMindmapSnapshot(db,sourceId);
  const category = options.category || String(source.system.category || '');
  const cloneName = options.name || `${source.system.name}${options.isTemplate ? ' 模板' : ' 副本'}`;
  const created = await db.prepare(`INSERT INTO trading_systems(name,category,description,resource_url,markets,timeframes,status,color,is_template) VALUES(?,?,?,?,?,?,?,?,?)`)
    .bind(cloneName,category,source.system.description ?? null,source.system.resource_url ?? null,source.system.markets ?? null,source.system.timeframes ?? null,options.isTemplate ? 'draft' : source.system.status ?? 'draft',source.system.color ?? '#3ec9c5',options.isTemplate ? 1 : 0).run();
  const id = Number(created.meta.last_row_id);
  const nodes = source.nodes.map(node => node.parent_id === null ? {...node,title:cloneName} : node);
  try { await replaceMindmapFromSnapshot(db,id,{...source,nodes,system:{...source.system,name:cloneName,category,status:options.isTemplate ? 'draft' : source.system.status}}); }
  catch (error) { await db.prepare('DELETE FROM trading_systems WHERE id=?').bind(id).run(); throw error; }
  return id;
}

export async function isAvailableSystemNodeType(db: D1Database, nodeType: string): Promise<boolean> {
  if (nodeType === 'root') return false;
  return !!await db.prepare(
    "SELECT id FROM settings WHERE category = 'system_node_type' AND value = ? AND is_active = 1"
  ).bind(nodeType).first();
}

export async function resolveActiveMindmapCategory(db: D1Database, requested?: unknown): Promise<string | null> {
  const value = String(requested || '').trim();
  const row = value
    ? await db.prepare("SELECT value FROM settings WHERE category = 'mindmap_category' AND value = ? AND is_active = 1 LIMIT 1")
      .bind(value).first<{ value: string }>()
    : await db.prepare("SELECT value FROM settings WHERE category = 'mindmap_category' AND is_active = 1 ORDER BY sort_order ASC, id ASC LIMIT 1")
      .first<{ value: string }>();
  return row?.value || null;
}
