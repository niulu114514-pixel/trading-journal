<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useDialog, useMessage } from 'naive-ui'
import { api, streamEvents } from '../services/api'
import { marked } from 'marked'
import DOMPurify from 'dompurify'

interface ActionItem { tool:string; arguments:Record<string,unknown> }
interface AnalysisItem { tool:string; arguments:Record<string,unknown>; status:'completed'|'failed'; summary:string; sources?:Array<{title:string;url:string;source:string}> }
interface ChatMessage { id?:number; role:'user'|'assistant'; content:string; actions?:ActionItem[]; analysis?:AnalysisItem[]; provider?:string; model?:string; usage?:any; action_batch_id?:number|null; action_status?:'active'|'rolled_back'|null }
interface Conversation { id:number; title:string; preview?:string; message_count:number; updated_at:string }
interface ConfigEntry { config_key:string; config_value:string }

const message=useMessage()
const dialog=useDialog()
const conversations=ref<Conversation[]>([])
const currentId=ref<number|null>(null)
const currentTitle=ref('新对话')
const messages=ref<ChatMessage[]>([])
const prompt=ref('')
const loading=ref(false)
const activeAbort=ref<AbortController|null>(null)
const streamStatus=ref('')
const historyLoading=ref(false)
const execute=ref(false)
const webSearch=ref(true)
const enabled=ref(false)
const configured=ref(false)
const chatBody=ref<HTMLElement|null>(null)
const showRename=ref(false)
const renameValue=ref('')
const suggestions=[
  '分析我最近 30 笔交易，找出最影响胜率和盈亏的执行问题',
  '检查当前所有启用规则，帮我整理重复、冲突和缺失的部分',
  '读取我的脑图，给出可以精简和补强的节点建议',
  '检查时间级别、交易形态和规则分类配置是否合理'
]
const canSend=computed(()=>Boolean(prompt.value.trim())&&!loading.value&&enabled.value&&configured.value)

function scrollEnd(){nextTick(()=>chatBody.value?.scrollTo({top:chatBody.value.scrollHeight,behavior:'smooth'}))}
function useSuggestion(value:string){prompt.value=value}
function actionLabel(tool:string){return ({create_rule:'创建规则',update_rule:'更新规则',create_trade:'添加交易',update_trade_review:'更新复盘',create_setting:'添加配置',update_setting:'更新配置',create_mindmap:'创建脑图',update_mindmap:'更新脑图',add_mindmap_node:'添加脑图节点',update_mindmap_node:'精修脑图节点'} as Record<string,string>)[tool]||tool}
function readableTime(value:string){const date=new Date(value.replace(' ','T')+'Z');return Number.isNaN(date.getTime())?value:date.toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})}

function renderMarkdown(value:string){return DOMPurify.sanitize(marked.parse(value||'',{breaks:true,gfm:true}) as string)}
function traceLabel(tool:string){return ({get_dashboard_context:'读取数据看板',list_trades:'读取交易日志',list_rules:'读取交易规则',list_mindmaps:'读取脑图列表',get_mindmap:'读取脑图详情',list_settings:'读取系统设置',get_market_candles:'读取 K 线行情',search_market_news:'搜索财经新闻',search_web:'联网搜索网页'} as Record<string,string>)[tool]||actionLabel(tool)}

async function loadConversations(selectFirst=false){
  historyLoading.value=true
  try{
    conversations.value=await api.get<Conversation[]>('/ai/conversations')
    if(selectFirst&&!currentId.value&&conversations.value.length)await openConversation(conversations.value[0].id)
  }finally{historyLoading.value=false}
}
async function openConversation(id:number){
  if(loading.value)return
  const result=await api.get<any>(`/ai/conversations/${id}`)
  currentId.value=id
  currentTitle.value=result.conversation.title
  messages.value=result.messages||[]
  scrollEnd()
}
function newConversation(){currentId.value=null;currentTitle.value='新对话';messages.value=[];prompt.value='';scrollEnd()}
function openRename(){if(!currentId.value)return;renameValue.value=currentTitle.value;showRename.value=true}
async function renameConversation(){
  if(!currentId.value||!renameValue.value.trim())return message.error('请输入对话名称')
  await api.put(`/ai/conversations/${currentId.value}`,{title:renameValue.value.trim()})
  currentTitle.value=renameValue.value.trim();showRename.value=false;await loadConversations();message.success('对话已重命名')
}
function removeConversation(){
  if(!currentId.value)return newConversation()
  const id=currentId.value
  dialog.warning({title:'删除历史对话',content:'确定删除这段对话吗？已经执行的数据修改不会因此回撤。',positiveText:'删除',negativeText:'取消',async onPositiveClick(){try{await api.del(`/ai/conversations/${id}`);newConversation();await loadConversations(true);message.success('历史对话已删除')}catch(error){message.error(error instanceof Error?error.message:'对话删除失败')}}})
}
function rollback(item:ChatMessage){
  if(!item.action_batch_id||item.action_status==='rolled_back')return
  dialog.warning({title:'回撤 AI 修改',content:'将按相反顺序回退这一条回复中由 AI 执行的全部修改。之后手动编辑过的相关数据也可能被覆盖，请确认后继续。',positiveText:'确认回撤',negativeText:'取消',async onPositiveClick(){try{await api.post(`/ai/action-batches/${item.action_batch_id}/rollback`,{});item.action_status='rolled_back';message.success('这组 AI 修改已回撤');await loadConversations()}catch(error){message.error(error instanceof Error?error.message:'AI 修改回撤失败')}}})
}

function stopGeneration(){activeAbort.value?.abort();streamStatus.value='正在停止生成'}

async function send(){
  const content=prompt.value.trim()
  if(!content||!canSend.value)return
  messages.value.push({role:'user',content})
  const assistant:ChatMessage={role:'assistant',content:'',analysis:[]}
  messages.value.push(assistant)
  prompt.value='';scrollEnd();loading.value=true;streamStatus.value='正在连接模型'
  const aborter=new AbortController();activeAbort.value=aborter
  try{
    let result:any=null,streamError=''
    await streamEvents('/ai/chat/stream',{conversation_id:currentId.value,message:content,execute:execute.value,web_search:webSearch.value},(event,data)=>{
      if(event==='status')streamStatus.value=data.label||'正在分析'
      else if(event==='trace'){assistant.analysis?.push(data);streamStatus.value=traceLabel(data.tool)}
      else if(event==='meta'){currentId.value=data.conversation_id;assistant.provider=data.provider;assistant.model=data.model;assistant.usage=data.usage}
      else if(event==='reset'){assistant.content='';streamStatus.value='主模型中断，正在切换备用模型'}
      else if(event==='delta'){assistant.content+=String(data.delta||'');streamStatus.value='正在生成回答';scrollEnd()}
      else if(event==='done')result=data
      else if(event==='error')streamError=data.error||'AI 请求失败'
    },aborter.signal)
    if(streamError)throw new Error(streamError)
    if(!result)throw new Error('流式响应未正常结束')
    if(result.fallback_used)message.warning('主模型不可用，本次已自动切换到 Cloudflare 备用模型')
    currentId.value=result.conversation_id
    Object.assign(assistant,{id:result.message_id,content:result.message||assistant.content||'已完成',actions:(result.actions||[]).map((item:any)=>({tool:item.tool,arguments:item.arguments||{}})),analysis:result.analysis||assistant.analysis,provider:result.provider,model:result.model,usage:result.usage,action_batch_id:result.action_batch_id,action_status:result.action_batch_id?'active':null})
    await loadConversations()
    const active=conversations.value.find(item=>item.id===currentId.value)
    if(active)currentTitle.value=active.title
    scrollEnd()
  }catch(error){
    messages.value=messages.value.filter(item=>item!==assistant)
    if(error instanceof DOMException&&error.name==='AbortError')message.info('已停止生成')
    else message.error(error instanceof Error?error.message:'AI 请求失败')
    if(currentId.value)await openConversation(currentId.value)
    else{await loadConversations();if(conversations.value.length)await openConversation(conversations.value[0].id)}
  }finally{activeAbort.value=null;loading.value=false;streamStatus.value=''}
}

onMounted(async()=>{
  const entries=await api.get<ConfigEntry[]>('/config')
  const config=Object.fromEntries(entries.map(item=>[item.config_key,item.config_value]))
  enabled.value=config.ai_enabled==='true'
  configured.value=Boolean((config.ai_model&&config.ai_api_key)||config.ai_cf_fallback_enabled!=='false')
  await loadConversations(true)
})
watch(execute,value=>{if(value)message.warning('已开启本轮写入授权，每组修改都可以从对应回复中回撤')})
</script>

<template>
  <section class="page ai-page">
    <header class="page-head"><div><h1>AI 复盘助手</h1><p>历史对话跨设备保存；授权写入后，每条回复都能独立回撤</p></div><div class="page-actions"><n-button type="primary" @click="newConversation">新对话</n-button></div></header>
    <n-alert v-if="!enabled||!configured" type="warning" :bordered="false" class="ai-config-alert">请先到“设置 → 系统设置 → 系统配置”启用 AI，并配置主模型或 Cloudflare 备用模型。历史对话仍可查看。</n-alert>
    <div class="ai-layout">
      <aside class="panel ai-history">
        <div class="panel-head"><h3>历史对话</h3><n-button size="tiny" @click="newConversation">＋</n-button></div>
        <n-spin :show="historyLoading">
          <div class="ai-history-list">
            <button v-for="item in conversations" :key="item.id" :class="{active:item.id===currentId}" @click="openConversation(item.id)"><strong>{{item.title}}</strong><span>{{item.preview||'暂无消息'}}</span><small>{{item.message_count}} 条 · {{readableTime(item.updated_at)}}</small></button>
            <div v-if="!conversations.length" class="empty-box"><strong>还没有历史对话</strong><span>发送第一条消息后会自动保存</span></div>
          </div>
        </n-spin>
      </aside>
      <div class="panel ai-chat">
        <div class="ai-chat-head"><div><strong>{{currentTitle}}</strong><small>最多读取最近 20 条消息作为上下文</small></div><div><n-switch v-model:value="webSearch"><template #checked>智能联网</template><template #unchecked>关闭联网</template></n-switch><n-switch v-model:value="execute"><template #checked>允许修改</template><template #unchecked>只读分析</template></n-switch><n-button v-if="currentId" size="tiny" @click="openRename">重命名</n-button><n-button v-if="currentId" size="tiny" type="error" ghost @click="removeConversation">删除</n-button></div></div>
        <div ref="chatBody" class="ai-messages">
          <div v-if="!messages.length" class="ai-welcome"><span>AI</span><strong>从一次真实复盘开始</strong><p>默认只读取和分析。打开“允许修改”后，AI 可以整理规则、脑图、配置和交易，每组写入都能回撤。</p><div class="ai-quick-grid"><button v-for="item in suggestions" :key="item" @click="useSuggestion(item)">{{item}}</button></div></div>
          <article v-for="item in messages" :key="item.id||`${item.role}-${item.content}`" :class="['ai-message',item.role]">
            <b>{{item.role==='user'?'你':'AI'}}</b><div>
              <div v-if="item.role==='assistant'" class="ai-markdown" v-html="renderMarkdown(item.content)"/><p v-else>{{item.content}}</p>
              <details v-if="item.analysis?.length" class="ai-analysis"><summary>分析过程 · {{item.analysis.length}} 步</summary><ol><li v-for="(trace,i) in item.analysis" :key="i" :class="trace.status"><span>{{traceLabel(trace.tool)}}</span><small>{{trace.status==='completed'?'已完成':trace.summary}}</small><div v-if="trace.sources?.length" class="ai-source-list"><a v-for="source in trace.sources" :key="source.url" :href="source.url" target="_blank" rel="noopener noreferrer"><b>{{source.source}}</b>{{source.title}} ↗</a></div></li></ol></details>
              <small v-if="item.provider" class="ai-provider">{{item.provider==='cloudflare'?'Cloudflare Workers AI':'主模型'}} · {{item.model}}<template v-if="item.usage?.total_tokens"> · {{item.usage.total_tokens}} tokens</template><template v-if="item.usage?.neurons!==undefined"> · {{Number(item.usage.neurons).toFixed(2)}} neurons</template></small>
              <div v-if="item.actions?.length" class="ai-actions"><span v-for="(action,i) in item.actions" :key="i" :class="{reverted:item.action_status==='rolled_back'}">{{item.action_status==='rolled_back'?'↶':'✓'}} {{actionLabel(action.tool)}}</span><n-button v-if="item.action_batch_id&&item.action_status!=='rolled_back'" size="tiny" type="warning" ghost @click="rollback(item)">回撤这组修改</n-button><b v-else-if="item.action_status==='rolled_back'">已回撤</b></div>
            </div>
          </article>
          <div v-if="loading" class="ai-thinking"><i/><i/><i/><span>{{streamStatus||'正在读取数据并分析'}}</span></div>
        </div>
        <div class="ai-composer"><n-input v-model:value="prompt" type="textarea" :autosize="{minRows:2,maxRows:7}" placeholder="例如：分析我最近的亏损交易，把反复出现的问题整理成规则草案" :disabled="!enabled||!configured" @keydown.enter.exact.prevent="send"/><div><span>{{execute?'本轮允许写入并记录回撤点':'只读分析模式'}} · Enter 发送，Shift+Enter 换行</span><n-button :type="loading?'error':'primary'" :disabled="!loading&&!canSend" @click="loading?stopGeneration():send()">{{loading?'停止':'发送'}}</n-button></div></div>
      </div>
    </div>
    <n-modal v-model:show="showRename" preset="card" title="重命名对话" class="form-modal"><n-form-item label="对话名称"><n-input v-model:value="renameValue" maxlength="80" @keydown.enter.prevent="renameConversation"/></n-form-item><div class="modal-actions"><n-button @click="showRename=false">取消</n-button><n-button type="primary" @click="renameConversation">保存</n-button></div></n-modal>
  </section>
</template>
