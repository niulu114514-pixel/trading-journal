<script setup lang="ts">
import { computed, h, onMounted, reactive, ref, watch } from 'vue'
import { NButton, NPopover, NSpace, NTag, useDialog, useMessage, type DataTableColumns } from 'naive-ui'
import { api, ApiError } from '../services/api'
import { useSettingsStore } from '../stores/settings'
import type { Trade } from '../types'

interface DailyChart {id:number;trade_date:string;image_id:number;image_url:string;created_at:string;updated_at:string}
function localDateKey(date:Date){const year=date.getFullYear(),month=String(date.getMonth()+1).padStart(2,'0'),day=String(date.getDate()).padStart(2,'0');return `${year}-${month}-${day}`}
const todayKey=localDateKey(new Date()),yesterday=new Date();yesterday.setDate(yesterday.getDate()-1)
const message=useMessage(),dialog=useDialog(),settings=useSettingsStore();const loading=ref(false),saving=ref(false),trades=ref<Trade[]>([]),total=ref(0),page=ref(1),showForm=ref(false),showDetail=ref(false),editingId=ref<number|null>(null),detail=ref<Trade|null>(null)
const dailyChartDate=ref(localDateKey(yesterday)),dailyChart=ref<DailyChart|null>(null),loadingDailyChart=ref(false),uploadingDailyChart=ref(false)
const filters=reactive({symbol:null as string|null,result:'',direction:'',timeframe:null as string|null,trading_system_id:null as number|null})
const form=reactive<any>({symbol:null,lots:1,entry_price:null,exit_price:null,direction:'多',entry_time:todayKey,timeframe:[] as string[],trading_system_id:null,trade_type:null,market_cycle:null,patterns:[],trade_logic:'',exit_type:null,return_amount:null,risk_reward_ratio:null,review:''})
const options=(key:string)=>computed(()=>(settings.groups[key]||[]).filter(v=>v.is_active).map(v=>({label:v.label,value:v.value})))
const symbols=options('symbol'),timeframes=options('timeframe'),tradeTypes=options('trade_type'),cycles=options('market_cycle'),patterns=options('pattern'),exitTypes=options('exit_type')
const formSymbols=computed(()=>{
  const result=[...symbols.value]
  const current=String(form.symbol||'').trim()
  if(current&&!result.some(item=>item.value===current))result.unshift({label:`${current}（历史品种）`,value:current})
  return result
})
const systemOptions=computed(()=>settings.systems.filter(v=>v.status!=='archived'&&v.category==='交易系统').map(v=>({label:`${v.name} · ${v.status==='active'?'执行中':'草稿'}`,value:v.id})))
const pageReturn=computed(()=>trades.value.reduce((sum,item)=>sum+Number(item.return_amount||0),0))
const pageWinRate=computed(()=>trades.value.length?trades.value.filter(v=>v.result==='胜').length/trades.value.length*100:0)
function money(v:number|null|undefined){if(v===null||v===undefined)return '—';return `${v>=0?'+':''}${Number(v).toFixed(2)}`}
function splitTimeframes(value:unknown){return [...new Set(String(value??'').split(/[,，]/).map(v=>v.trim()).filter(Boolean))]}
function displayTimeframes(value:unknown){return splitTimeframes(value).join(' / ')||'—'}
function formatRatio(value:number|null|undefined){if(value===null||value===undefined||!Number.isFinite(Number(value)))return '—';return Number(value).toLocaleString('zh-CN',{maximumFractionDigits:4})}
function formatPrice(value:number|null|undefined){if(value===null||value===undefined||!Number.isFinite(Number(value)))return '—';return Number(value).toLocaleString('zh-CN',{maximumFractionDigits:8})}
async function load(){loading.value=true;try{const q=new URLSearchParams({page:String(page.value),limit:'30'});if(filters.symbol)q.set('symbol',filters.symbol);if(filters.result)q.set('result',filters.result);if(filters.direction)q.set('direction',filters.direction);if(filters.timeframe)q.set('timeframe',filters.timeframe);if(filters.trading_system_id)q.set('trading_system_id',String(filters.trading_system_id));const data=await api.get<{trades:Trade[];total:number}>(`/trades?${q}`);trades.value=data.trades;total.value=data.total}finally{loading.value=false}}
async function open(trade?:Trade){await settings.load(true);const source=trade?await api.get<Trade>(`/trades/${trade.id}`):null;editingId.value=source?.id||null;Object.assign(form,source?{...source,timeframe:splitTimeframes(source.timeframe),patterns:source.patterns?source.patterns.split(',').map(v=>v.trim()):[],trading_system_id:source.trading_system_id||null}:{symbol:symbols.value[0]?.value||null,lots:1,entry_price:null,exit_price:null,direction:'多',entry_time:todayKey,timeframe:timeframes.value[0]?.value?[timeframes.value[0].value]:[],trading_system_id:null,trade_type:null,market_cycle:null,patterns:[],trade_logic:'',exit_type:null,return_amount:null,risk_reward_ratio:null,review:''});showForm.value=true}
function optionalText(value:unknown){const text=String(value??'').trim();return text||null}
async function save(){
  if(!String(form.symbol||'').trim())return message.error('请填写交易品种')
  if(!form.entry_time)return message.error('请选择开仓日期')
  if(!Number(form.lots)||Number(form.lots)<=0)return message.error('手数必须大于 0')
  if(!Array.isArray(form.timeframe)||!form.timeframe.length)return message.error('请至少选择一个时间级别')
  const returnAmount=form.return_amount===null||form.return_amount===''?null:Number(form.return_amount)
  const riskRewardRatio=form.risk_reward_ratio===null||form.risk_reward_ratio===''?null:Number(form.risk_reward_ratio)
  const numberOrNull=(value:unknown)=>value===null||value===''||value===undefined?null:Number(value)
  const prices=[numberOrNull(form.entry_price),numberOrNull(form.exit_price)]
  if(prices.some(value=>value!==null&&(!Number.isFinite(value)||value<0)))return message.error('开仓和平仓价格必须是大于或等于 0 的数字')
  const payload={
    symbol:String(form.symbol).trim(),code:optionalText(form.code),entry_time:String(form.entry_time),lots:Number(form.lots),entry_price:prices[0],exit_price:prices[1],direction:form.direction,timeframe:form.timeframe,
    trading_system_id:form.trading_system_id??null,trade_type:optionalText(form.trade_type),market_cycle:optionalText(form.market_cycle),patterns:Array.isArray(form.patterns)&&form.patterns.length?form.patterns.join(','):null,
    trade_logic:optionalText(form.trade_logic),exit_type:optionalText(form.exit_type),return_amount:returnAmount,risk_reward_ratio:riskRewardRatio,
    result:returnAmount===null?null:returnAmount>0?'胜':returnAmount<0?'败':'平',review:optionalText(form.review)
  }
  saving.value=true
  try{
    if(editingId.value)await api.put(`/trades/${editingId.value}`,payload);else await api.post('/trades',payload)
    message.success(editingId.value?'交易已更新':'交易已添加');showForm.value=false;await load()
  }catch(error){
    const detail=error instanceof ApiError&&(error.data as any)?.issues?.[0]
    message.error(detail?`${error.message}：${detail.path} ${detail.msg}`:error instanceof Error?error.message:'保存交易失败')
  }finally{saving.value=false}
}
async function viewTrade(row:Trade){try{detail.value=await api.get<Trade>(`/trades/${row.id}`);showDetail.value=true}catch(error){message.error(error instanceof Error?error.message:'交易详情加载失败')}}
function tradeRowProps(row:Trade){return{class:'editable-row',title:'双击编辑交易',onDblclick:(event:MouseEvent)=>{if((event.target as HTMLElement).closest('button,a'))return;open(row)}}}
function remove(row:Trade){dialog.warning({title:'删除交易',content:`确定删除 ${row.symbol} 的这笔交易吗？`,positiveText:'删除',negativeText:'取消',async onPositiveClick(){try{await api.del(`/trades/${row.id}`);message.success('交易已删除');await load()}catch(error){message.error(error instanceof Error?error.message:'交易删除失败')}}})}
async function loadDailyChart(){loadingDailyChart.value=true;try{const data=await api.get<{chart:DailyChart|null}>(`/daily-charts/${dailyChartDate.value}`);dailyChart.value=data.chart}finally{loadingDailyChart.value=false}}
async function uploadDailyChart(event:Event){const input=event.target as HTMLInputElement,file=input.files?.[0];if(!file)return;if(file.size>10*1024*1024){message.error('图片不能超过 10MB');input.value='';return}uploadingDailyChart.value=true;try{const body=new FormData();body.append('file',file);body.append('caption',`${dailyChartDate.value} 全天K线走势`);body.append('display_name',`${dailyChartDate.value} 全天K线走势`);body.append('tags',`日K线,${dailyChartDate.value}`);const result=await api.upload<{id:number}>('/upload',body);await api.put(`/daily-charts/${dailyChartDate.value}`,{image_id:result.id});await Promise.all([loadDailyChart(),load()]);message.success(`${dailyChartDate.value} 的全天K线已关联到当日全部交易`)}catch(error){message.error(error instanceof Error?error.message:'全天K线上传失败')}finally{uploadingDailyChart.value=false;input.value=''}}
function removeDailyChart(){dialog.warning({title:'移除每日K线',content:`移除 ${dailyChartDate.value} 的K线关联吗？图片仍会保留在图床中。`,positiveText:'移除关联',negativeText:'取消',async onPositiveClick(){try{await api.del(`/daily-charts/${dailyChartDate.value}`);await Promise.all([loadDailyChart(),load()]);message.success('日期关联已移除')}catch(error){message.error(error instanceof Error?error.message:'移除失败')}}})}
function chartForTrade(trade:Trade){return trade.daily_chart_image||null}
function reviewCell(row:Trade){const review=String(row.review||'').trim();if(!review)return '—';return h(NPopover,{trigger:'hover',placement:'top-start',showArrow:false,style:{maxWidth:'min(420px, calc(100vw - 32px))'}},{trigger:()=>h('span',{class:'review-cell'},review),default:()=>h('div',{class:'review-popover'},review)})}
const columns:DataTableColumns<Trade>=[
 {title:'时间',key:'entry_time',width:105,render:r=>r.entry_time?.slice(0,10)},
 {title:'品种',key:'symbol',width:105,render:r=>h('strong',r.symbol)},
 {title:'方向',key:'direction',width:65,render:r=>h(NTag,{size:'small',type:r.direction==='多'?'success':'error',bordered:false},{default:()=>r.direction})},
 {title:'周期',key:'timeframe',width:110,ellipsis:{tooltip:true},render:r=>displayTimeframes(r.timeframe)},{title:'交易系统',key:'trading_system_name',minWidth:170,ellipsis:{tooltip:true},render:r=>h('span',{},[r.trading_system_name||'—',r.strategy_snapshot_locked?h(NTag,{size:'tiny',type:'info',style:{marginLeft:'5px'}},{default:()=> '已锁定'}):null])},
 {title:'复盘反馈',key:'review',minWidth:180,render:reviewCell},
 {title:'日K线',key:'daily_chart_image',width:82,render:r=>h(NTag,{size:'small',type:r.daily_chart_image?'success':'default',bordered:false},{default:()=>r.daily_chart_image?'已上传':'待上传'})},
 {title:'风险/回报比',key:'risk_reward_ratio',width:110,render:r=>formatRatio(r.risk_reward_ratio)},
 {title:'回报',key:'return_amount',width:95,render:r=>h('b',{class:r.return_amount!==null&&Number(r.return_amount)>=0?'positive':'negative'},money(r.return_amount))},
 {title:'结果',key:'result',width:70,render:r=>h(NTag,{size:'small',type:r.result==='胜'?'success':r.result==='败'?'error':'default'},{default:()=>r.result||'—'})},
 {title:'操作',key:'actions',width:168,fixed:'right',render:r=>h(NSpace,{size:5},()=>[h(NButton,{size:'tiny',onClick:()=>viewTrade(r)},{default:()=> '查看'}),h(NButton,{size:'tiny',onClick:()=>open(r)},{default:()=> '编辑'}),h(NButton,{size:'tiny',type:'error',ghost:true,onClick:()=>remove(r)},{default:()=> '删除'})])}
]
watch(()=>[filters.symbol,filters.result,filters.direction,filters.timeframe,filters.trading_system_id],()=>{page.value=1;load()});watch(page,load);watch(dailyChartDate,loadDailyChart);onMounted(()=>Promise.all([settings.load(true),load(),loadDailyChart()]))
</script>
<template><section class="page"><header class="page-head"><div><h1>交易日志</h1><p>记录交易、执行系统与复盘反馈</p></div><n-button type="primary" @click="open()">新增交易</n-button></header>
 <div class="journal-page-summary"><span>当前页 {{trades.length}} 笔</span><b :class="pageReturn>=0?'positive':'negative'">{{money(pageReturn)}}</b><span>胜率 {{pageWinRate.toFixed(1)}}%</span><small>双击交易可直接编辑</small></div>
 <div class="panel daily-chart-manager"><div class="daily-chart-copy"><strong>每日K线复盘</strong><span>每天只上传一张全天走势，自动关联该日期的全部交易；可以在次日补传。</span></div><div class="daily-chart-controls"><input v-model="dailyChartDate" class="native-input" type="date" :max="todayKey"/><n-tag :type="dailyChart?'success':'default'" :bordered="false">{{loadingDailyChart?'读取中':dailyChart?'已上传':'待上传'}}</n-tag><label class="daily-chart-upload"><input type="file" accept="image/png,image/jpeg,image/gif,image/webp" @change="uploadDailyChart"/><n-button tag="span" type="primary" secondary :loading="uploadingDailyChart">{{dailyChart?'替换当日K线':'上传当日K线'}}</n-button></label><n-button v-if="dailyChart" text type="error" @click="removeDailyChart">移除关联</n-button></div><div v-if="dailyChart" class="daily-chart-preview"><n-image :src="dailyChart.image_url" :preview-src="dailyChart.image_url" object-fit="cover" :img-props="{alt:`${dailyChartDate} 全天K线走势`}"/><div><strong>{{dailyChartDate}} 全天走势</strong><span>同一天的每笔交易都会显示这张图</span></div></div></div>
 <div class="panel table-panel"><div class="table-tools"><div><strong>交易记录</strong><span>{{total}} 笔</span></div><n-space><n-select v-model:value="filters.symbol" clearable filterable :options="symbols" placeholder="全部品种" style="width:140px"/><n-select v-model:value="filters.result" :options="[{label:'全部结果',value:''},{label:'胜',value:'胜'},{label:'败',value:'败'},{label:'平',value:'平'}]" style="width:105px"/><n-select v-model:value="filters.direction" :options="[{label:'全部方向',value:''},{label:'多',value:'多'},{label:'空',value:'空'}]" style="width:105px"/><n-select v-model:value="filters.timeframe" clearable :options="timeframes" placeholder="全部周期" style="width:110px"/><n-select v-model:value="filters.trading_system_id" clearable :options="systemOptions" placeholder="全部系统" style="width:150px"/></n-space></div><n-data-table :columns="columns" :data="trades" :loading="loading" :bordered="false" :scroll-x="1260" :row-props="tradeRowProps"/><div class="table-pagination"><n-pagination v-model:page="page" :page-count="Math.max(1,Math.ceil(total/30))"/></div></div>
 <n-modal v-model:show="showForm" preset="card" :title="editingId?'编辑交易':'新增交易'" class="trade-modal"><n-form label-placement="top"><n-grid responsive="screen" cols="1 s:2" :x-gap="12">
  <n-form-item-gi label="品种代码"><n-select v-model:value="form.symbol" filterable :options="formSymbols" placeholder="请在设置中添加交易品种"/></n-form-item-gi><n-form-item-gi label="开仓日期"><input v-model="form.entry_time" class="native-input" type="date"/></n-form-item-gi>
  <n-form-item-gi label="方向"><n-select v-model:value="form.direction" :options="[{label:'多',value:'多'},{label:'空',value:'空'}]"/></n-form-item-gi><n-form-item-gi label="手数"><n-input-number v-model:value="form.lots" :min="0.01" :step="0.01" style="width:100%"/></n-form-item-gi>
  <n-form-item-gi label="开仓价格"><n-input-number v-model:value="form.entry_price" clearable :min="0" :step="0.00001" placeholder="直接填写开仓价" style="width:100%"/></n-form-item-gi><n-form-item-gi label="平仓价格"><n-input-number v-model:value="form.exit_price" clearable :min="0" :step="0.00001" placeholder="直接填写平仓价" style="width:100%"/></n-form-item-gi>
  <n-form-item-gi label="时间级别（多选）"><n-select v-model:value="form.timeframe" multiple filterable :max-tag-count="'responsive'" :options="timeframes" placeholder="至少选择一个时间级别"/></n-form-item-gi><n-form-item-gi label="执行的交易系统"><n-select v-model:value="form.trading_system_id" clearable :options="systemOptions" placeholder="未关联"/></n-form-item-gi>
  <n-form-item-gi label="交易类型"><n-select v-model:value="form.trade_type" clearable :options="tradeTypes"/></n-form-item-gi><n-form-item-gi label="市场周期"><n-select v-model:value="form.market_cycle" clearable :options="cycles"/></n-form-item-gi>
  <n-form-item-gi label="出场方式"><n-select v-model:value="form.exit_type" clearable :options="exitTypes"/></n-form-item-gi><n-form-item-gi label="形态（多选）"><n-select v-model:value="form.patterns" multiple filterable :options="patterns"/></n-form-item-gi>
  <n-form-item-gi label="回报"><n-input-number v-model:value="form.return_amount" clearable style="width:100%"/></n-form-item-gi><n-form-item-gi label="风险/回报比"><n-input-number v-model:value="form.risk_reward_ratio" clearable :min="0" :step="0.01" placeholder="例如 0.71" style="width:100%"/></n-form-item-gi>
 </n-grid><n-alert class="trade-result-preview" :type="form.return_amount===null||form.return_amount===''?'default':Number(form.return_amount)>=0?'success':'error'" :bordered="false">{{form.return_amount===null||form.return_amount===''?'待定':Number(form.return_amount)>0?'胜':Number(form.return_amount)<0?'败':'平'}} · 回报 {{money(form.return_amount)}}</n-alert><n-form-item label="交易逻辑"><n-input v-model:value="form.trade_logic" type="textarea" :rows="3"/></n-form-item><n-alert type="info" :bordered="false" class="daily-chart-form-tip">K线图改为按日期统一管理。保存交易后，可在日志顶部为该日期上传一张全天走势。</n-alert><n-form-item label="复盘反馈"><n-input v-model:value="form.review" type="textarea" :rows="3"/></n-form-item><div class="modal-actions"><n-button @click="showForm=false">取消</n-button><n-button type="primary" :loading="saving" @click="save">保存</n-button></div></n-form></n-modal>
 <n-modal v-model:show="showDetail" preset="card" title="交易详情" class="form-modal"><div v-if="detail" class="trade-detail"><div><span>品种</span><strong>{{detail.symbol}} · {{detail.direction}}</strong></div><div><span>日期</span><strong>{{detail.entry_time?.slice(0,10)}}</strong></div><div><span>开仓价格</span><strong>{{formatPrice(detail.entry_price)}}</strong></div><div><span>平仓价格</span><strong>{{formatPrice(detail.exit_price)}}</strong></div><div><span>时间级别</span><strong>{{displayTimeframes(detail.timeframe)}}</strong></div><div><span>风险/回报比</span><strong>{{formatRatio(detail.risk_reward_ratio)}}</strong></div><div><span>交易系统</span><strong>{{detail.trading_system_name||'未关联'}} <n-tag v-if="detail.strategy_snapshot_locked" size="tiny" type="info">历史版本已锁定</n-tag></strong></div><div><span>结果</span><strong :class="Number(detail.return_amount)>=0?'positive':'negative'">{{money(detail.return_amount)}}</strong></div><div class="wide"><span>交易逻辑</span><p>{{detail.trade_logic||'—'}}</p></div><div class="wide"><span>复盘反馈</span><p>{{detail.review||'—'}}</p></div><div v-if="chartForTrade(detail)" class="detail-image"><n-image :src="chartForTrade(detail)!" :preview-src="chartForTrade(detail)!" width="100%" object-fit="contain" show-toolbar-tooltip :img-props="{alt:`${detail.entry_time?.slice(0,10)} 全天K线走势`}"/><span class="detail-image-hint">{{detail.daily_chart_image?'当日全部交易共用 · ':''}}点击图片放大查看</span></div></div></n-modal>
</section></template>
