<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useMessage } from 'naive-ui'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { api } from '../services/api'

interface NewsItem { source:string; title:string; link:string; publishedAt?:string; description?:string; kind?:'rss'|'web' }
interface NewsSource { id:string; name:string }
interface NewsSourceStatus { id:string; name:string; ok:boolean; cached:boolean; stale:boolean; item_count:number; error?:string }
const message=useMessage(),keyword=ref(''),deep=ref(false),timeRange=ref('day'),selectedSources=ref<string[]>([])
const items=ref<NewsItem[]>([]),sources=ref<NewsSource[]>([]),searchResults=ref<NewsItem[]>([])
const sourceStatus=ref<NewsSourceStatus[]>([]),searchWarning=ref(''),searchTerms=ref<string[]>([])
const loading=ref(false),analyzing=ref(false),analysis=ref(''),symbol=ref('XAU/USD'),interval=ref('1h')
const allItems=computed(()=>[...items.value,...searchResults.value].filter((item,index,array)=>array.findIndex(other=>(other.link&&other.link===item.link)||other.title===item.title)===index))
const rssCount=computed(()=>items.value.length),webCount=computed(()=>searchResults.value.length)
const failedSources=computed(()=>sourceStatus.value.filter(item=>!item.ok))
const sourceOptions=computed(()=>sources.value.map(item=>({label:item.name,value:item.id})))
const rangeOptions=[{label:'24 小时',value:'day'},{label:'一周',value:'week'},{label:'一月',value:'month'},{label:'一年',value:'year'}]
const intervalOptions=['15min','30min','1h','2h','4h','1day'].map(value=>({label:value,value}))
function markdown(value:string){return DOMPurify.sanitize(marked.parse(value||'',{breaks:true,gfm:true}) as string)}
function date(value?:string){if(!value)return '时间未知';const d=new Date(value);return Number.isNaN(d.getTime())?value:d.toLocaleString('zh-CN')}
function normalizeSearch(raw:any):NewsItem[]{
  const rows=Array.isArray(raw?.results)?raw.results:Array.isArray(raw)?raw:[]
  return rows.map((item:any)=>({kind:'web' as const,source:item.source||'网页搜索',title:item.title||'无标题',link:item.url||item.link||'',publishedAt:item.published_date||item.publishedAt,description:item.content||item.description||''})).filter((item:NewsItem)=>item.link||item.title)
}
async function load(){
  loading.value=true
  try{
    const q=new URLSearchParams({keyword:keyword.value,limit:'40',deep:deep.value?'1':'0',time_range:timeRange.value})
    if(selectedSources.value.length)q.set('sources',selectedSources.value.join(','))
    const result=await api.get<any>(`/news?${q}`)
    items.value=(result.items||[]).map((item:NewsItem)=>({...item,kind:'rss'}));sources.value=result.sources||sources.value;searchResults.value=normalizeSearch(result.search)
    sourceStatus.value=result.source_status||[];searchWarning.value=result.search_warning||'';searchTerms.value=result.search_terms||[]
    if(searchWarning.value)message.warning(`网页新闻搜索未完成：${searchWarning.value}`)
  }catch(error){message.error(error instanceof Error?error.message:'新闻获取失败')}finally{loading.value=false}
}
async function analyze(){
  if(!allItems.value.length)return message.warning('请先获取新闻')
  analyzing.value=true;analysis.value=''
  try{const result=await api.post<any>('/news/analyze',{items:allItems.value.slice(0,40),keyword:keyword.value,symbol:symbol.value,interval:interval.value});analysis.value=result.analysis||'未生成分析'}
  catch(error){message.error(error instanceof Error?error.message:'新闻分析失败')}finally{analyzing.value=false}
}
onMounted(load)
</script>

<template>
  <section class="page news-page">
    <header class="page-head"><div><h1>财经新闻</h1><p>RSS 聚合 · td-forex-mcp 网页搜索 · AI 联动行情分析</p></div><div class="page-actions"><n-button :loading="loading" @click="load">刷新新闻</n-button><n-button type="primary" :loading="analyzing" @click="analyze">AI 分析</n-button></div></header>
    <section class="panel news-filters"><n-input v-model:value="keyword" clearable placeholder="搜索关键词，例如：黄金、美联储、非农" @keydown.enter.prevent="load"/><n-select v-model:value="selectedSources" multiple clearable :options="sourceOptions" placeholder="全部 RSS 来源"/><n-select v-model:value="timeRange" :options="rangeOptions"/><n-switch v-model:value="deep"><template #checked>RSS + 网页搜索</template><template #unchecked>仅 RSS</template></n-switch><n-button type="primary" :loading="loading" @click="load">搜索</n-button></section>
    <div class="news-source-health" v-if="sourceStatus.length||searchWarning"><div class="news-source-tags"><n-tag v-for="source in sourceStatus" :key="source.id" size="small" :type="source.ok?'success':source.stale?'warning':'error'" :bordered="false">{{source.name}} · {{source.ok?(source.cached?'缓存':'正常'):source.stale?'备用缓存':'失败'}} · {{source.item_count}}</n-tag></div><p v-if="failedSources.length">{{failedSources.map(item=>`${item.name}：${item.error||'暂时不可用'}`).join('；')}}</p><p v-if="searchWarning">联网搜索：{{searchWarning}}</p></div>
    <div class="news-layout">
      <section class="panel news-list"><div class="panel-head"><div><h3>新闻列表</h3><span class="subtle">共 {{allItems.length}} 条 · RSS {{rssCount}} · 网页 {{webCount}}<template v-if="searchTerms.length"> · 检索词 {{searchTerms.join(' / ')}}</template></span></div></div><n-spin :show="loading"><div v-if="allItems.length" class="news-cards"><article v-for="item in allItems" :key="item.link||item.title"><div><n-tag size="small" :type="item.kind==='web'?'info':'default'" :bordered="false">{{item.kind==='web'?'网页':'RSS'}} · {{item.source}}</n-tag><time>{{date(item.publishedAt)}}</time></div><a :href="item.link" target="_blank" rel="noopener noreferrer">{{item.title}}</a><p v-if="item.description">{{item.description}}</p></article></div><div v-else class="empty-box"><strong>没有找到新闻</strong><span>可尝试中文或英文关键词，或开启“RSS + 网页搜索”</span></div></n-spin></section>
      <aside class="panel news-analysis"><div class="panel-head"><div><h3>AI 新闻研判</h3><span class="subtle">结合当前新闻与 K 线快照</span></div></div><div class="news-market"><n-input v-model:value="symbol" placeholder="XAU/USD"/><n-select v-model:value="interval" :options="intervalOptions"/><n-button type="primary" :loading="analyzing" @click="analyze">开始分析</n-button></div><n-spin :show="analyzing"><div v-if="analysis" class="ai-markdown" v-html="markdown(analysis)"/><div v-else class="empty-box compact"><strong>尚未分析</strong><span>AI 会区分新闻事实、市场推断和失效条件</span></div></n-spin></aside>
    </div>
  </section>
</template>
