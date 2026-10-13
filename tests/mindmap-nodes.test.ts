import { describe, expect, it } from 'vitest';
import { parseMindmapBatchNodes } from '../src/services/mindmap-nodes';

describe('mind map node parsing', () => {
  it('accepts a content-appropriate node count without structural quotas', () => {
    const nodes = parseMindmapBatchNodes([
      {
        ref: 'entry',
        title: '入场确认',
        content: '等待当前周期收盘并确认结构仍然成立后再执行入场。',
        node_type: 'condition'
      }
    ]);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].depth).toBe(1);
  });

  it('allows useful deep structures and still rejects cycles', () => {
    const deep = Array.from({ length: 8 }, (_, index) => ({
      ref: `node_${index}`,
      parent_ref: index ? `node_${index - 1}` : null,
      title: `步骤 ${index + 1}`,
      content: `这是步骤 ${index + 1} 的具体判断依据、执行动作与异常处理说明。`,
      node_type: 'condition'
    }));
    expect(parseMindmapBatchNodes(deep).at(-1)?.depth).toBe(8);

    expect(() => parseMindmapBatchNodes([
      { ref: 'a', parent_ref: 'b', title: 'A', content: '节点 A 的具体执行说明和异常处理。', node_type: 'condition' },
      { ref: 'b', parent_ref: 'a', title: 'B', content: '节点 B 的具体执行说明和异常处理。', node_type: 'condition' }
    ])).toThrow('循环');
  });
});
