import { describe, expect, it } from 'vitest';
import { chooseAiJobFailureMessage, cloudflareNeurons, consumeAiEventStream, isRetryableAiJobError, normalizeAiMindmapNodes, normalizeAiUsage, normalizeMindmapNodeType, orderMindmapNodesParentFirst, resolveAiEndpoint, resolveAiModelsEndpoint } from '../src/index';
import { DEFAULT_MINDMAP_REFINEMENT_INSTRUCTIONS } from '../src/services/mindmap-nodes';

describe('AI provider endpoint resolution', () => {
  it('keeps a complete Chat Completions endpoint unchanged', () => {
    expect(resolveAiEndpoint('https://api.siliconflow.cn/v1/chat/completions')).toEqual({
      endpoint: 'https://api.siliconflow.cn/v1/chat/completions',
      protocol: 'chat_completions'
    });
  });

  it('detects a complete Responses endpoint', () => {
    expect(resolveAiEndpoint('https://api.openai.com/v1/responses')).toEqual({
      endpoint: 'https://api.openai.com/v1/responses',
      protocol: 'responses'
    });
  });

  it('appends the explicitly selected protocol to a base URL', () => {
    expect(resolveAiEndpoint('https://api.example.com/v1/', 'chat_completions')).toEqual({
      endpoint: 'https://api.example.com/v1/chat/completions',
      protocol: 'chat_completions'
    });
  });

  it('can override a complete endpoint when the selected format differs', () => {
    expect(resolveAiEndpoint('https://api.example.com/v1/chat/completions', 'responses')).toEqual({
      endpoint: 'https://api.example.com/v1/responses',
      protocol: 'responses'
    });
  });

  it('derives the provider model-list endpoint from a complete chat endpoint', () => {
    expect(resolveAiModelsEndpoint('https://api.siliconflow.cn/v1/chat/completions')).toBe('https://api.siliconflow.cn/v1/models');
  });
});

describe('mind map snapshot ordering',()=>{
  it('places every parent before its children even when the snapshot array is unordered',()=>{
    const ordered=orderMindmapNodesParentFirst([
      {id:3,parent_id:2,title:'child'},
      {id:1,parent_id:null,title:'root'},
      {id:2,parent_id:1,title:'parent'}
    ]);
    expect(ordered.map(node=>node.id)).toEqual([1,2,3]);
  });

  it('rejects circular parent relationships',()=>{
    expect(()=>orderMindmapNodesParentFirst([{id:1,parent_id:2},{id:2,parent_id:1}])).toThrow('循环父子关系');
  });
});

describe('Workers AI metering',()=>{
  it('normalizes provider token fields and calculates neurons from the selected model rate',()=>{
    const usage=normalizeAiUsage({prompt_tokens:41,completion_tokens:3,total_tokens:44});
    expect(usage).toEqual({input_tokens:41,output_tokens:3,total_tokens:44});
    expect(cloudflareNeurons('@cf/meta/llama-3.2-3b-instruct',usage!)).toBeCloseTo(0.28105,5);
  });
});

describe('AI mind map output normalization',()=>{
  it('repairs a short model-generated node explanation without weakening input validation',()=>{
    const [node]=normalizeAiMindmapNodes([{ref:'12',title:'等待确认',content:'确认'}]) as Array<Record<string,string>>;
    expect(node.content.length).toBeGreaterThanOrEqual(8);
    expect(node.content).toContain('判断依据');
  });

  it('caps unexpectedly long model output and provides a detailed default refinement prompt',()=>{
    const [node]=normalizeAiMindmapNodes([{ref:'long',title:'过长',content:'a'.repeat(2100)}]) as Array<Record<string,string>>;
    expect(node.content).toHaveLength(2000);
    expect(DEFAULT_MINDMAP_REFINEMENT_INSTRUCTIONS).toContain('8 个、最多 2000 个字符');
  });

  it('replaces copied placeholders and labels with active node type values',()=>{
    const options=[{value:'setup',label:'市场环境'},{value:'condition',label:'判断条件'},{value:'entry',label:'入场'},{value:'risk',label:'风控'}];
    const nodes=normalizeAiMindmapNodes([
      {title:'方向确认入场',content:'满足方向过滤后执行入场动作。',node_type:'可用类型值'},
      {title:'风险控制',content:'设置止损和最大仓位。',node_type:'风控'}
    ],options) as Array<Record<string,string>>;
    expect(nodes.map(node=>node.node_type)).toEqual(['entry','risk']);
    expect(normalizeMindmapNodeType('判断条件','任意标题','任意内容',options)).toBe('condition');
  });
});

describe('AI streaming and background job reliability',()=>{
  it('streams chat-completion deltas and reconstructs tool calls',async()=>{
    const source=[
      'data: {"choices":[{"delta":{"content":"实时"}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"list_","arguments":"{\\"limit\\":"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"trades","arguments":"10}"}}]}}],"usage":{"prompt_tokens":8,"completion_tokens":3,"total_tokens":11}}\n\n',
      'data: [DONE]\n\n'
    ];
    const stream=new ReadableStream<Uint8Array>({start(controller){for(const item of source)controller.enqueue(new TextEncoder().encode(item));controller.close();}});
    const deltas:string[]=[];
    const result=await consumeAiEventStream(stream,'chat_completions',delta=>deltas.push(delta));
    expect(deltas).toEqual(['实时']);
    expect(result.choices[0].message.tool_calls[0]).toMatchObject({id:'call_1',function:{name:'list_trades',arguments:'{"limit":10}'}});
    expect(result.usage.total_tokens).toBe(11);
  });

  it('streams Responses API text and keeps the completed response',async()=>{
    const source=[
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"逐"}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"字"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"output_text":"逐字","output":[],"usage":{"input_tokens":2,"output_tokens":2,"total_tokens":4}}}\n\n'
    ];
    const stream=new ReadableStream<Uint8Array>({start(controller){for(const item of source)controller.enqueue(new TextEncoder().encode(item));controller.close();}});
    const deltas:string[]=[];
    const result=await consumeAiEventStream(stream,'responses',delta=>deltas.push(delta));
    expect(deltas.join('')).toBe('逐字');
    expect(result.output_text).toBe('逐字');
    expect(result.usage.total_tokens).toBe(4);
  });

  it('preserves a useful provider error when Workflows returns a generic failure',()=>{
    expect(chooseAiJobFailureMessage('主模型请求超时（180 秒）','Attempt failed due to internal workflows error')).toBe('主模型请求超时（180 秒）');
    expect(chooseAiJobFailureMessage(null,'上游响应 401')).toBe('上游响应 401');
    expect(isRetryableAiJobError('请求超时（180 秒）')).toBe(true);
    expect(isRetryableAiJobError('没有可用的脑图节点类型')).toBe(false);
  });
});
