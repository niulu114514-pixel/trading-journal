<script setup lang="ts">
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  createChart,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp
} from 'lightweight-charts'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { api } from '../services/api'

interface Candle { time:number;open:number;high:number;low:number;close:number }
interface KlineResponse { symbol:string;interval:string;candles:Candle[] }

const symbol=ref('XAU/USD'),interval=ref('1day'),range=ref(120),auto=ref(true),loading=ref(false),meta=ref(''),error=ref(''),chartHost=ref<HTMLElement|null>(null),latest=ref<Candle|null>(null),hovered=ref<Candle|null>(null),countdown=ref(60),emaVisible=ref(true),dataMode=ref('60 秒共享缓存')
const activeCandle=computed(()=>hovered.value||latest.value)
const change=computed(()=>activeCandle.value?activeCandle.value.close-activeCandle.value.open:0)
const symbolPresets=['XAU/USD','EUR/USD','GBP/USD','USD/JPY','BTC/USD']
const intervals=[['1min','1分'],['5min','5分'],['15min','15分'],['30min','30分'],['1h','1时'],['4h','4时'],['1day','日'],['1week','周'],['1month','月']]
let chart:IChartApi|null=null,candleSeries:ISeriesApi<'Candlestick'>|null=null,emaSeries:ISeriesApi<'Line'>|null=null,observer:ResizeObserver|null=null,timer:number|undefined,ticker:number|undefined,nextRefresh=0,requestId=0

function price(value:number|undefined){return value===undefined?'—':Number(value).toFixed(Math.abs(value)>=100?2:5)}
function cleanupChart(){observer?.disconnect();observer=null;chart?.remove();chart=null;candleSeries=null;emaSeries=null}
function ema(candles:Candle[],period=20){const result:{time:UTCTimestamp;value:number}[]=[];const factor=2/(period+1);let value=0;candles.forEach((item,index)=>{const close=Number(item.close);value=index===0?close:close*factor+value*(1-factor);if(index>=period-1)result.push({time:item.time as UTCTimestamp,value})});return result}

function ensureChart(){
  if(chart||!chartHost.value)return
  chart=createChart(chartHost.value,{width:chartHost.value.clientWidth,height:chartHost.value.clientHeight||560,layout:{background:{type:ColorType.Solid,color:'transparent'},textColor:'#7d899d'},grid:{vertLines:{color:'#17202d'},horzLines:{color:'#17202d'}},rightPriceScale:{borderColor:'#263144',scaleMargins:{top:.08,bottom:.08}},timeScale:{borderColor:'#263144',timeVisible:true,secondsVisible:false},crosshair:{mode:CrosshairMode.Normal,vertLine:{color:'#49627a'},horzLine:{color:'#49627a'}}})
  candleSeries=chart.addSeries(CandlestickSeries,{upColor:'#35c77a',downColor:'#ef6262',borderVisible:false,wickUpColor:'#35c77a',wickDownColor:'#ef6262',priceLineVisible:true})
  emaSeries=chart.addSeries(LineSeries,{color:'#e5bd4f',lineWidth:2,priceLineVisible:false,lastValueVisible:false,crosshairMarkerVisible:false,visible:emaVisible.value,title:'EMA 20'})
  chart.subscribeCrosshairMove(param=>{const value=candleSeries?param.seriesData.get(candleSeries) as any:null;hovered.value=value?{time:Number(param.time||0),open:Number(value.open),high:Number(value.high),low:Number(value.low),close:Number(value.close)}:null})
  observer=new ResizeObserver(entries=>{const rect=entries[0]?.contentRect;if(rect&&chart&&rect.width>0&&rect.height>0)chart.resize(rect.width,rect.height)})
  observer.observe(chartHost.value)
}

function render(candles:Candle[],preserveViewport=false){
  if(!chartHost.value)return
  ensureChart()
  const visibleRange=preserveViewport?chart?.timeScale().getVisibleLogicalRange():null
  latest.value=candles[candles.length-1]||null
  candleSeries?.setData(candles.map(v=>({time:v.time as UTCTimestamp,open:Number(v.open),high:Number(v.high),low:Number(v.low),close:Number(v.close)})))
  emaSeries?.setData(ema(candles))
  if(visibleRange)chart?.timeScale().setVisibleLogicalRange(visibleRange)
  else chart?.timeScale().fitContent()
}

async function load(silent=false,fresh=false){
  const id=++requestId
  if(!silent)loading.value=true
  error.value=''
  try{
    const freshQuery=fresh?'&fresh=1':''
    const data=await api.get<KlineResponse>(`/kline?symbol=${encodeURIComponent(symbol.value)}&interval=${interval.value}&outputsize=${range.value}${freshQuery}`)
    if(id!==requestId)return
    if(!data.candles?.length)throw new Error('未获取到 K 线数据')
    await nextTick()
    render(data.candles,silent)
    const newest=data.candles[data.candles.length-1]
    dataMode.value=fresh?'强制更新':'60 秒共享缓存'
    meta.value=`${data.symbol} · ${data.interval} · ${data.candles.length} 根 · 最新 ${new Date(newest.time*1000).toLocaleString('zh-CN',{hour12:false})}`
  }catch(e){error.value=e instanceof Error?e.message:'行情加载失败'}finally{if(id===requestId){loading.value=false;schedule()}}
}

function schedule(){clearTimeout(timer);if(auto.value){nextRefresh=Date.now()+60000;countdown.value=60;timer=window.setTimeout(()=>load(true),60000)}}
function fullscreen(){chartHost.value?.requestFullscreen?.()}
function selectSymbol(value:string){symbol.value=value;load(false,true)}
watch([interval,range],()=>load())
watch(auto,v=>v?load(true):clearTimeout(timer))
watch(emaVisible,v=>emaSeries?.applyOptions({visible:v}))
onMounted(()=>{load();ticker=window.setInterval(()=>{if(auto.value&&nextRefresh)countdown.value=Math.max(0,Math.ceil((nextRefresh-Date.now())/1000))},1000)})
onUnmounted(()=>{requestId++;clearTimeout(timer);clearInterval(ticker);cleanupChart()})
</script>

<template><section class="page"><header class="page-head"><div><h1>K线行情</h1><p>近实时 OHLC · 自由十字线 · 数据源 TD Forex MCP / Twelve Data</p></div><div class="page-actions"><n-switch v-model:value="auto"><template #checked>60 秒刷新</template><template #unchecked>已暂停</template></n-switch></div></header>
 <div class="panel chart-panel"><div class="chart-tools"><n-input v-model:value="symbol" placeholder="XAU/USD" style="width:160px" @keyup.enter="load(false,true)"/><n-button type="primary" :loading="loading" @click="load(false,true)">查询</n-button><n-button-group class="intervals"><n-button v-for="item in intervals" :key="item[0]" size="small" :type="interval===item[0]?'primary':'default'" @click="interval=item[0]">{{item[1]}}</n-button></n-button-group><n-select v-model:value="range" :options="[60,120,250,500].map(v=>({label:`${v} 根`,value:v}))" style="width:105px"/><n-button size="small" @click="fullscreen">全屏</n-button></div><div class="symbol-presets"><button v-for="item in symbolPresets" :key="item" :class="{active:symbol===item}" @click="selectSymbol(item)">{{item}}</button><label><n-switch v-model:value="emaVisible" size="small"/> EMA 20</label></div><div class="ohlc-strip"><span>O <b>{{price(activeCandle?.open)}}</b></span><span>H <b>{{price(activeCandle?.high)}}</b></span><span>L <b>{{price(activeCandle?.low)}}</b></span><span>C <b>{{price(activeCandle?.close)}}</b></span><span :class="change>=0?'positive':'negative'">{{change>=0?'+':''}}{{price(change)}}</span></div><div class="chart-meta"><span>{{meta||'等待行情'}}</span><span>{{dataMode}}<template v-if="auto"> · 下次刷新 {{countdown}}s</template></span></div><n-alert v-if="error" type="error" :bordered="false">{{error}}</n-alert><div ref="chartHost" class="chart-host"><n-spin v-if="loading&&!chart" class="chart-loading" size="large"/></div></div>
</section></template>
