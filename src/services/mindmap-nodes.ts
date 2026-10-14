export type MindmapBatchNode = {
  ref: string;
  parentRef: string | null;
  title: string;
  content: string;
  nodeType: string;
  ruleId: number | null;
  sortOrder: number;
  depth: number;
};

export type MindmapNodeTypeOption = { value: string; label?: string };

export function normalizeMindmapNodeType(
  rawType: unknown,
  title: unknown,
  content: unknown,
  options: MindmapNodeTypeOption[]
): string {
  const available = options.filter(option => option?.value && option.value !== 'root');
  if (!available.length) return 'condition';
  const raw = String(rawType || '').trim();
  const exact = available.find(option => option.value === raw || String(option.label || '').trim() === raw);
  if (exact) return exact.value;
  const text = `${String(title || '')} ${String(content || '')}`;
  const preferred = [
    { value: 'risk', pattern: /风险|风控|止损|仓位|回撤|亏损|保护/ },
    { value: 'exit', pattern: /出场|离场|止盈|平仓|退出|无效|失效/ },
    { value: 'review', pattern: /复盘|记录|总结|评估|统计|检查清单/ },
    { value: 'entry', pattern: /入场|进场|开仓|下单|触发/ },
    { value: 'setup', pattern: /市场|环境|周期|品种|时段|方向|前提|准备|背景/ }
  ];
  for (const candidate of preferred) {
    if (candidate.pattern.test(text) && available.some(option => option.value === candidate.value)) {
      return candidate.value;
    }
  }
  return available.find(option => option.value === 'condition')?.value || available[0].value;
}

export function parseMindmapBatchNodes(raw: unknown): MindmapBatchNode[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('nodes 至少需要包含一个节点');
  if (raw.length > 500) throw new Error('单次提交节点过多，请分批处理');

  const nodes: MindmapBatchNode[] = raw.map((value, index) => {
    const node = value && typeof value === 'object' ? value as Record<string, unknown> : {};
    const ref = String(node.ref || '').trim();
    const parentRef = node.parent_ref === undefined || node.parent_ref === null || node.parent_ref === ''
      ? null
      : String(node.parent_ref).trim();
    const title = String(node.title || '').trim();
    const content = String(node.content || '').trim();
    const nodeType = String(node.node_type || 'condition').trim();
    const ruleId = node.rule_id === undefined || node.rule_id === null ? null : Number(node.rule_id);
    const sortOrder = Number.isInteger(Number(node.sort_order)) ? Math.max(0, Number(node.sort_order)) : index;
    if (!/^[\p{L}\p{N}_-]{1,50}$/u.test(ref)) throw new Error(`节点 #${index + 1} 的 ref 无效`);
    if (parentRef && !/^[\p{L}\p{N}_-]{1,50}$/u.test(parentRef)) throw new Error(`节点 ${ref} 的 parent_ref 无效`);
    if (!title || title.length > 120) throw new Error(`节点 ${ref} 的标题必须为 1-120 个字符`);
    if (content.length < 8 || content.length > 2000) throw new Error(`节点 ${ref} 必须填写 8-2000 个字符的具体说明`);
    if (!/^[\p{L}\p{N}_-]{1,40}$/u.test(nodeType) || nodeType === 'root') throw new Error(`节点 ${ref} 的 node_type 无效`);
    if (ruleId !== null && (!Number.isInteger(ruleId) || ruleId <= 0)) throw new Error(`节点 ${ref} 的 rule_id 无效`);
    return { ref, parentRef, title, content, nodeType, ruleId, sortOrder, depth: 0 };
  });

  const byRef = new Map<string, MindmapBatchNode>();
  for (const node of nodes) {
    if (byRef.has(node.ref)) throw new Error(`节点 ref 重复：${node.ref}`);
    byRef.set(node.ref, node);
  }
  const visiting = new Set<string>();
  const depthOf = (node: MindmapBatchNode): number => {
    if (node.depth) return node.depth;
    if (visiting.has(node.ref)) throw new Error(`节点层级存在循环：${node.ref}`);
    visiting.add(node.ref);
    if (!node.parentRef) node.depth = 1;
    else {
      const parent = byRef.get(node.parentRef);
      if (!parent) throw new Error(`节点 ${node.ref} 引用了不存在的 parent_ref：${node.parentRef}`);
      node.depth = depthOf(parent) + 1;
    }
    visiting.delete(node.ref);
    return node.depth;
  };
  for (const node of nodes) depthOf(node);
  return nodes;
}
