<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { api } from '../services/api'

type Period = 'day' | 'week' | 'month' | 'year'
interface Overview { total: number; total_return: number; wins: number; losses: number; breakevens: number; avg_rr: number; expectancy:number; gross_profit:number; gross_loss:number; best_trade:number; worst_trade:number; snapshot_trades:number }
interface SeriesItem { period: string; trades: number; wins: number; losses: number; total_return: number }
interface SymbolStat { symbol: string; trades: number; total_return: number; avg_rr: number }

const period = ref<Period>('month')
const loading = ref(true)
const overview = ref<Overview>({ total: 0, total_return: 0, wins: 0, losses: 0, breakevens: 0, avg_rr: 0,expectancy:0,gross_profit:0,gross_loss:0,best_trade:0,worst_trade:0,snapshot_trades:0 })
const series = ref<SeriesItem[]>([])
const symbols = ref<SymbolStat[]>([])
const labels: Record<Period, string> = { day: '日', week: '周', month: '月', year: '年' }
const limits: Record<Period, number> = { day: 30, week: 26, month: 24, year: 10 }
const winRate = computed(() => overview.value.total ? overview.value.wins / overview.value.total * 100 : 0)
const profitFactor = computed(() => overview.value.gross_loss ? overview.value.gross_profit / overview.value.gross_loss : overview.value.gross_profit ? Infinity : 0)
const bestSymbol = computed(() => [...symbols.value].sort((a,b)=>Number(b.total_return)-Number(a.total_return))[0])
const recentReturn = computed(() => series.value.slice(-3).reduce((sum,item)=>sum+Number(item.total_return||0),0))
const maxReturn = computed(() => Math.max(1, ...series.value.map(v => Math.abs(Number(v.total_return)))))

function money(value: number | null | undefined) { const n = Number(value || 0); return `${n >= 0 ? '+' : ''}${n.toFixed(2)}` }
function periodLabel(value: string) { return period.value === 'day' ? value.slice(5) : value }

async function load() {
  loading.value = true
  try {
    const [o, s, sy] = await Promise.all([
      api.get<Overview>('/stats/overview'),
      api.get<{ series: SeriesItem[] }>(`/stats/series?granularity=${period.value}&limit=${limits[period.value]}`),
      api.get<SymbolStat[]>('/stats/symbols')
    ])
    overview.value = o; series.value = [...s.series].reverse(); symbols.value = sy
  } finally { loading.value = false }
}
watch(period, load)
onMounted(load)
</script>

<template>
  <section class="page">
    <header class="page-head"><div><h1>数据看板</h1><p>交易绩效、盈亏走势与品种表现</p></div><n-button-group><n-button v-for="(label,key) in labels" :key="key" size="small" :type="period===key?'primary':'default'" @click="period=key">{{ label }}</n-button></n-button-group></header>
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
      <div class="dashboard-insights panel"><div><span>最佳单笔</span><strong class="positive">{{money(overview.best_trade)}}</strong></div><div><span>最差单笔</span><strong class="negative">{{money(overview.worst_trade)}}</strong></div><div><span>近期 {{labels[period]}}度</span><strong :class="recentReturn>=0?'positive':'negative'">{{money(recentReturn)}}</strong></div><div><span>表现最佳品种</span><strong>{{bestSymbol?.symbol||'—'}}</strong><small v-if="bestSymbol">{{money(bestSymbol.total_return)}}</small></div></div>
      <div class="content-grid">
        <div class="panel"><div class="panel-head"><h3>{{ labels[period] }}度盈亏走势</h3><span class="subtle">最近 {{ limits[period] }} 期</span></div><div class="panel-body">
          <div v-if="series.length" class="trend-bars">
            <div v-for="item in series" :key="item.period" class="trend-item" :title="`${item.period} · ${item.trades} 笔 · ${money(item.total_return)}`">
              <span>{{ money(item.total_return) }}</span><div class="trend-track"><i :class="item.total_return>=0?'up':'down'" :style="{height:`${Math.max(4,Math.abs(item.total_return)/maxReturn*100)}%`}"></i></div><b>{{ periodLabel(item.period) }}</b>
            </div>
          </div><div v-else class="empty-box"><strong>暂无走势</strong><p>记录交易后会在这里形成曲线</p></div>
        </div></div>
        <div class="panel"><div class="panel-head"><h3>品种统计</h3><span class="subtle">按交易次数</span></div><div class="symbol-list">
          <div v-for="item in symbols" :key="item.symbol" class="symbol-row"><strong>{{ item.symbol }}</strong><span>{{ item.trades }} 笔</span><b :class="item.total_return>=0?'positive':'negative'">{{ money(item.total_return) }}</b><small>RR {{ item.avg_rr ? Number(item.avg_rr).toFixed(2) : '—' }}</small></div>
          <div v-if="!symbols.length" class="empty-box"><strong>暂无品种数据</strong></div>
        </div></div>
      </div>
    </template>
  </section>
</template>
