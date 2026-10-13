<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useDialog, useMessage } from 'naive-ui'
import { api } from '../services/api'

interface Token {id:number;name:string;permissions:'read'|'write'|'admin';token_mask:string;created_at:string;last_used_at?:string}
interface Tool {name:string;desc:string;write?:boolean}
const message=useMessage(),dialog=useDialog(),tokens=ref<Token[]>([]),loading=ref(false),showCreate=ref(false),showToken=ref(false),newToken=ref(''),query=ref(''),activeGroup=ref('全部'),form=reactive({name:'',permissions:'read'})
const endpoint=computed(()=>`${location.origin}/api/mcp`)
const groups:{name:string;icon:string;tools:Tool[]}[]=[
 {name:'交易',icon:'↗',tools:[['list_trades','筛选和分页查询交易'],['get_trade','读取单笔交易详情'],['add_trade','新增交易',1],['update_trade','修改交易',1],['delete_trade','删除交易',1]].map(([name,desc,w])=>({name:String(name),desc:String(desc),write:Boolean(w)}))},
 {name:'统计',icon:'▥',tools:[{name:'get_stats',desc:'胜率、收益和盈亏统计'},{name:'get_trend',desc:'按日/周/月/年查看趋势'}]},
 {name:'规则',icon:'✓',tools:[['list_rules','查询规则'],['get_rule','读取规则详情'],['add_rule','新增规则',1],['update_rule','修改规则',1],['delete_rule','删除规则',1]].map(([name,desc,w])=>({name:String(name),desc:String(desc),write:Boolean(w)}))},
 {name:'脑图',icon:'⌘',tools:[['list_systems','列出脑图'],['get_system','读取节点、原始提示词与完整度'],['create_detailed_mindmap','按内容创建详细多层脑图',1],['expand_mindmap','批量追加多层节点',1],['refine_mindmap','结合原始提示词与当前整图重构精修',1],['list_mindmap_versions','列出整图版本'],['save_mindmap_version','保存当前整图版本',1],['restore_mindmap_version','回撤到指定整图版本',1],['duplicate_mindmap','复制脑图',1],['save_mindmap_template','保存为模板',1],['list_mindmap_templates','列出模板'],['create_mindmap_from_template','从模板创建脑图',1],['add_system','创建空白或简易骨架',1],['update_system','修改脑图元数据',1],['delete_system','删除脑图',1],['add_system_node','新增单个节点',1],['update_system_node','修改单个节点',1],['delete_system_node','删除节点及子节点',1]].map(([name,desc,w])=>({name:String(name),desc:String(desc),write:Boolean(w)}))},
 {name:'设置与行情',icon:'⚙',tools:[['list_settings','读取时间级别等自定义设置'],['add_setting','新增设置选项',1],['update_setting','修改设置选项',1],['delete_setting','删除设置选项',1],['get_market_candles','读取 OHLC K 线数据']].map(([name,desc,w])=>({name:String(name),desc:String(desc),write:Boolean(w)}))},
 {name:'图片',icon:'▧',tools:[['upload_chart_image','上传图片并生成公开链接',1],['set_trade_chart','关联交易图片',1],['list_images','搜索图片名称、分类、标签和备注'],['get_image','读取图片信息和在线链接'],['update_image','修改图片名称、分类、标签和备注',1],['delete_image','永久删除图片',1],['reconcile_images','对账 R2 并清理失效记录',1]].map(([name,desc,w])=>({name:String(name),desc:String(desc),write:Boolean(w)}))}
]
const groupNames=computed(()=>['全部',...groups.map(v=>v.name)])
const visibleGroups=computed(()=>groups.filter(g=>activeGroup.value==='全部'||g.name===activeGroup.value).map(g=>({...g,tools:g.tools.filter(t=>!query.value||`${t.name} ${t.desc}`.toLowerCase().includes(query.value.toLowerCase()))})).filter(g=>g.tools.length))
const totalTools=computed(()=>groups.reduce((n,g)=>n+g.tools.length,0))
const writeCount=computed(()=>groups.flatMap(g=>g.tools).filter(t=>t.write).length)
async function load(){loading.value=true;try{tokens.value=await api.get('/mcp/tokens')}finally{loading.value=false}}
async function create(){if(!form.name.trim())return message.error('请输入密钥名称');const result=await api.post<{token:string}>('/mcp/tokens',form);newToken.value=result.token;showCreate.value=false;showToken.value=true;form.name='';await load()}
function remove(token:Token){dialog.warning({title:'删除 MCP 密钥',content:`删除“${token.name}”后，使用它的客户端会立即失去访问权限。`,positiveText:'删除',negativeText:'取消',async onPositiveClick(){try{await api.del(`/mcp/tokens/${token.id}`);message.success('密钥已删除');await load()}catch(error){message.error(error instanceof Error?error.message:'密钥删除失败')}}})}
async function copy(value:string){await navigator.clipboard.writeText(value);message.success('已复制')}
onMounted(load)
</script>
<template><section class="page"><header class="page-head"><div><h1>MCP 服务</h1><p>让 AI 安全读取行情、管理交易系统并完成日志复盘</p></div><n-button type="primary" @click="showCreate=true">创建访问密钥</n-button></header>
 <div class="mcp-hero panel"><div><span class="service-dot"></span><div><strong>Trading Journal MCP</strong><small>JSON-RPC 2.0 · Streamable HTTP · Bearer Auth</small></div></div><code>{{endpoint}}</code><n-button size="small" @click="copy(endpoint)">复制端点</n-button></div>
 <div class="mcp-metrics"><div class="panel"><span>可用工具</span><strong>{{totalTools}}</strong></div><div class="panel"><span>只读工具</span><strong>{{totalTools-writeCount}}</strong></div><div class="panel"><span>写入工具</span><strong>{{writeCount}}</strong></div><div class="panel"><span>有效密钥</span><strong>{{tokens.length}}</strong></div></div>
 <div class="mcp-grid"><div class="panel"><div class="panel-head"><h3>访问密钥</h3><n-tag size="small">按权限隔离</n-tag></div><n-spin :show="loading"><div class="token-list"><div v-for="token in tokens" :key="token.id" class="token-row"><div><strong>{{token.name}}</strong><code>{{token.token_mask}}</code><small>创建于 {{token.created_at?.slice(0,10)}}</small></div><n-tag size="small" :type="token.permissions==='admin'?'warning':token.permissions==='write'?'success':'default'">{{token.permissions}}</n-tag><n-button size="tiny" type="error" ghost @click="remove(token)">删除</n-button></div><div v-if="!tokens.length" class="empty-box compact"><strong>暂无密钥</strong></div></div></n-spin></div>
 <div class="panel service-info"><div class="panel-head"><h3>接入说明</h3><n-tag type="success" size="small">运行中</n-tag></div><dl><dt>认证请求头</dt><dd><code>Authorization: Bearer mcp_xxx</code></dd><dt>密钥保存</dt><dd>完整密钥只在创建时显示一次，之后无法找回</dd><dt>权限模型</dt><dd>read 只读 · write 读写 · admin 管理</dd><dt>K 线能力</dt><dd>get_market_candles 返回 OHLC，可供 MCP 客户端分析和绘图</dd></dl></div></div>
 <div class="panel tools-panel"><div class="tools-head"><div><h3>可用工具</h3><span>{{visibleGroups.reduce((n,g)=>n+g.tools.length,0)}} / {{totalTools}}</span></div><n-input v-model:value="query" clearable placeholder="搜索工具或能力" style="max-width:300px"/></div><div class="tool-tabs"><button v-for="name in groupNames" :key="name" :class="{active:activeGroup===name}" @click="activeGroup=name">{{name}}</button></div><div class="tool-catalog"><section v-for="group in visibleGroups" :key="group.name"><header><i>{{group.icon}}</i><div><h4>{{group.name}}</h4><span>{{group.tools.length}} 个工具</span></div></header><div><article v-for="tool in group.tools" :key="tool.name"><div><code>{{tool.name}}</code><p>{{tool.desc}}</p></div><n-tag size="tiny" :type="tool.write?'warning':'success'" :bordered="false">{{tool.write?'写入':'只读'}}</n-tag></article></div></section></div><div v-if="!visibleGroups.length" class="empty-box compact"><strong>没有匹配的工具</strong></div></div>
 <div class="panel mcp-guide"><div class="panel-head"><h3>客户端配置示例</h3><n-button text type="primary" @click="copy(JSON.stringify({mcpServers:{'trading-journal':{type:'streamable-http',url:endpoint,headers:{Authorization:'Bearer mcp_xxx'}}}},null,2))">复制配置</n-button></div><pre>{
  "mcpServers": {
    "trading-journal": {
      "type": "streamable-http",
      "url": "{{endpoint}}",
      "headers": { "Authorization": "Bearer mcp_xxx" }
    }
  }
}</pre></div>
 <n-modal v-model:show="showCreate" preset="card" title="创建 MCP 访问密钥" class="form-modal"><n-form label-placement="top"><n-form-item label="名称"><n-input v-model:value="form.name" placeholder="例如：Claude Desktop"/></n-form-item><n-form-item label="权限"><n-select v-model:value="form.permissions" :options="[{label:'只读 read',value:'read'},{label:'读写 write',value:'write'},{label:'管理 admin',value:'admin'}]"/></n-form-item><div class="modal-actions"><n-button @click="showCreate=false">取消</n-button><n-button type="primary" @click="create">创建</n-button></div></n-form></n-modal>
 <n-modal v-model:show="showToken" preset="card" title="密钥创建成功" class="form-modal"><n-alert type="warning" :show-icon="false">请立即复制并安全保存。关闭后无法再次查看完整密钥。</n-alert><div class="new-token"><code>{{newToken}}</code><n-button type="primary" @click="copy(newToken)">复制密钥</n-button></div></n-modal>
</section></template>
