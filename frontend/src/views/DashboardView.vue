<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { api } from '../services/api'

interface Overview { total: number; total_return: number; wins: number; losses: number; breakevens: number; avg_rr: number; expectancy:number; gross_profit:number; gross_loss:number; best_trade:number; worst_trade:number; snapshot_trades:number }
interface SeriesItem { period: string; trades: number; wins: number; losses: number; total_return: number }
interface SymbolStat { symbol: string; trades: number; total_return: number; avg_rr: number }

const today = new Date()
const loading = ref(true)
const calendarLoading = ref(false)
const calendarMonth = ref(toMonthKey(today))
const overview = ref<Overview>({ total: 0, total_return: 0, wins: 0, losses: 0, breakevens: 0, avg_rr: 0,expectancy:0,gross_profit:0,gross_loss:0,best_trade:0,worst_trade:0,snapshot_trades:0 })
const series = ref<SeriesItem[]>([])
const symbols = ref<SymbolStat[]>([])
const weekdays = ['一', '二', '三', '四', '五', '六', '日']
let calendarRequest = 0

const winRate = computed(() => overview.value.total ? overview.value.wins / overview.value.total * 100 : 0)
const profitFactor = computed(() => overview.value.gross_loss ? overview.value.gross_profit / overview.value.gross_loss : overview.value.gross_profit ? Infinity : 0)
const bestSymbol = computed(() => [...symbols.value].sort((a,b)=>Number(b.total_return)-Number(a.total_return))[0])
const monthReturn = computed(() => series.value.reduce((sum,item)=>sum+Number(item.total_return||0),0))
const monthTrades = computed(() => series.value.reduce((sum,item)=>sum+Number(item.trades||0),0))
const maxDailyReturn = computed(() => Math.max(1, ...series.value.map(v => Math.abs(Number(v.total_return)))))
const calendarTitle = computed(() => {
  const [year, month] = calendarMonth.value.split('-').map(Number)
  return `${year}年${month}月`
})
const calendarDays = computed(() => {
  const [year, month] = calendarMonth.value.split('-').map(Number)
  const first = new Date(year, month - 1, 1)
  const offset = (first.getDay() + 6) % 7
  const daysInMonth = new Date(year, month, 0).getDate()
  const cellCount = Math.ceil((offset + daysInMonth) / 7) * 7
  const items = new Map(series.value.map(item => [item.period, item]))

  return Array.from({ length: cellCount }, (_, index) => {
    const date = new Date(year, month - 1, index - offset + 1)
    const key = toDateKey(date)
    const item = items.get(key)
    return {
      key,
      day: date.getDate(),
      inMonth: date.getMonth() === month - 1,
      isToday: key === toDateKey(today),
      item,
      intensity: item ? Math.max(.16, Math.abs(Number(item.total_return)) / maxDailyReturn.value * .72) : 0
    }
  })
})

function toMonthKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}
function toDateKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
function nextMonthKey(monthKey: string) {
  const [year, month] = monthKey.split('-').map(Number)
  return toMonthKey(new Date(year, month, 1))
}
function money(value: number | null | undefined) { const n = Number(value || 0); return `${n >= 0 ? '+' : ''}${n.toFixed(2)}` }
function changeMonth(offset: number) {
  const [year, month] = calendarMonth.value.split('-').map(Number)
  calendarMonth.value = toMonthKey(new Date(year, month - 1 + offset, 1))
}
function dayTitle(day: { key: string; item?: SeriesItem }) {
  return day.item ? `${day.key} · ${day.item.trades} 笔 · ${money(day.item.total_return)}` : `${day.key} · 无交易`
}
function dayStyle(day: { item?: SeriesItem; intensity: number }) {
  if (!day.item) return undefined
  const color = Number(day.item.total_return) > 0 ? '53, 199, 122' : Number(day.item.total_return) < 0 ? '239, 98, 98' : '124, 135, 155'
  return { background: `rgba(${color}, ${day.intensity})` }
}

async function loadCalendar() {
  const request = ++calendarRequest
  calendarLoading.value = true
  const from = `${calendarMonth.value}-01`
  try {
    const result = await api.get<{ series: SeriesItem[] }>(`/stats/series?granularity=day&from=${from}&to=${nextMonthKey(calendarMonth.value)}-01&limit=31`)
    if (request === calendarRequest) series.value = result.series
  } finally {
    if (request === calendarRequest) calendarLoading.value = false
  }
}
async function load() {
  loading.value = true
  try {
    const [o, sy] = await Promise.all([
      api.get<Overview>('/stats/overview'),
      api.get<SymbolStat[]>('/stats/symbols'),
      loadCalendar()
    ])
    overview.value = o
    symbols.value = sy
  } finally { loading.value = false }
}
watch(calendarMonth, loadCalendar)
onMounted(load)
</script>

<template>
  <section class="page">
    <header class="page-head"><div><h1>数据看板</h1><p>交易绩效、盈亏日历与品种表现</p></div></header>
    <div v-if="loading" class="loading-center"><n-spin size="large" /></div>
    <template v-else>
      <div class="metric-grid">
        <div class="panel metric-card"><div class="metric-label">总交易</div><div class="metric-value">{{ overview.total || 0 }}</div></div>
        <div class="panel metric-card"><div class="metric-label">总盈亏</div><div class="metric-value" :class="overview.total_return>=0?'positive':'negative'">{{ money(overview.total_return) }}</div></div>
        <div class="panel metric-card"><div class="metric-label">胜率</div><div class="metric-value positive">{{ winRate.toFixed(1) }}%</div><div class="metric-note">胜 {{ overview.wins }} / 败 {{ overview.losses }} / 平 {{ overview.breakevens }}</div></div>
        <div class="panel metric-card"><div class="metric-label">平均风险/回报比</div><div class="metric-value">{{ overview.avg_rr ? Number(overview.avg_rr).toFixed(2) : '—' }}</div></div>
        <div class="panel metric-card"><div class="metric-label">单笔期望</div><div class="metric-value" :class="overview.expectancy>=0?'positive':'negative'">{{ money(overview.expectancy) }}</div><div class="metric-note">平均每笔交易结果</div></div>
        <div class="panel metric-card"><div class="metric-label">利润因子</div><div class="metric-value">{{profitFactor===Infinity?'∞':profitFactor.toFixed(2)}}</div><div class="metric-note">总盈利 ÷ 总亏损</div></div>
        <div class="panel metric-card"><div class="metric-label">系统版本锁定</div><div class="metric-value">{{overview.snapshot_trades||0}}</div><div class="metric-note">共 {{overview.total||0}} 笔历史交易</div></div>
      </div>
      <div class="dashboard-insights panel"><div><span>最佳单笔</span><strong class="positive">{{money(overview.best_trade)}}</strong></div><div><span>最差单笔</span><strong class="negative">{{money(overview.worst_trade)}}</strong></div><div><span>{{calendarTitle}}盈亏</span><strong :class="monthReturn>=0?'positive':'negative'">{{money(monthReturn)}}</strong><small>{{monthTrades}} 笔交易</small></div><div><span>表现最佳品种</span><strong>{{bestSymbol?.symbol||'—'}}</strong><small v-if="bestSymbol">{{money(bestSymbol.total_return)}}</small></div></div>
      <div class="content-grid">
        <div class="panel calendar-panel">
          <div class="panel-head calendar-head"><div><h3>盈亏日历</h3><span class="subtle">每日净盈亏与交易笔数</span></div><div class="calendar-nav"><n-button quaternary size="tiny" aria-label="上个月" @click="changeMonth(-1)">‹</n-button><button type="button" @click="calendarMonth=toMonthKey(today)">{{calendarTitle}}</button><n-button quaternary size="tiny" aria-label="下个月" @click="changeMonth(1)">›</n-button></div></div>
          <div class="panel-body calendar-body" :class="{loading:calendarLoading}">
            <div class="calendar-weekdays"><span v-for="weekday in weekdays" :key="weekday">{{weekday}}</span></div>
            <div class="calendar-grid">
              <div v-for="day in calendarDays" :key="day.key" class="calendar-day" :class="{muted:!day.inMonth,today:day.isToday,profit:Number(day.item?.total_return)>0,loss:Number(day.item?.total_return)<0,flat:day.item&&Number(day.item.total_return)===0}" :style="dayStyle(day)" :title="dayTitle(day)">
                <span>{{day.day}}</span><strong v-if="day.item">{{money(day.item.total_return)}}</strong><small v-if="day.item">{{day.item.trades}} 笔</small>
              </div>
            </div>
            <div class="calendar-legend"><span><i class="loss"></i>亏损</span><span><i class="empty"></i>无交易</span><span><i class="profit"></i>盈利</span></div>
          </div>
        </div>
        <div class="panel"><div class="panel-head"><h3>品种统计</h3><span class="subtle">按交易次数</span></div><div class="symbol-list">
          <div v-for="item in symbols" :key="item.symbol" class="symbol-row"><strong>{{ item.symbol }}</strong><span>{{ item.trades }} 笔</span><b :class="item.total_return>=0?'positive':'negative'">{{ money(item.total_return) }}</b><small>RR {{ item.avg_rr ? Number(item.avg_rr).toFixed(2) : '—' }}</small></div>
          <div v-if="!symbols.length" class="empty-box"><strong>暂无品种数据</strong></div>
        </div></div>
      </div>
    </template>
  </section>
</template>
