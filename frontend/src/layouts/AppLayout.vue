<script setup lang="ts">
import { computed, h, onMounted, onUnmounted, ref } from 'vue'
import { NButton, NIcon, NMenu, useDialog } from 'naive-ui'
import { RouterView, useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth'

const router = useRouter()
const route = useRoute()
const auth = useAuthStore()
const dialog = useDialog()
const collapsed = ref(window.innerWidth < 900)

const glyph = (value: string) => () => h(NIcon, null, { default: () => h('span', { class: 'menu-glyph' }, value) })
const menuOptions = [
  { label: '数据看板', key: '/dashboard', icon: glyph('▦') },
  { label: '交易日志', key: '/journal', icon: glyph('◆') },
  { label: 'K线行情', key: '/charts', icon: glyph('⌁') },
  { label: '财经新闻', key: '/news', icon: glyph('◫') },
  { label: '图片图床', key: '/images', icon: glyph('▧') },
  { label: '脑图', key: '/systems', icon: glyph('⌘') },
  { label: '交易规则', key: '/rules', icon: glyph('▽') },
  { label: 'AI 助手', key: '/ai', icon: glyph('✧') },
  { type: 'divider', key: 'd1' },
  { label: '设置', key: '/settings', icon: glyph('✦') },
  { label: 'MCP 服务', key: '/mcp', icon: glyph('▤') }
]
const activeKey = computed(() => route.path)

function onResize() { if (window.innerWidth < 720) collapsed.value = true }
onMounted(() => window.addEventListener('resize', onResize, { passive: true }))
onUnmounted(() => window.removeEventListener('resize', onResize))

function logout() {
  dialog.warning({
    title: '退出登录', content: '确定退出当前会话吗？', positiveText: '退出', negativeText: '取消',
    async onPositiveClick() { await auth.logout(); await router.replace('/login') }
  })
}
</script>

<template>
  <div class="app-shell" :class="{ 'is-collapsed': collapsed }">
    <aside class="app-sidebar">
      <button class="brand" @click="collapsed = !collapsed">
        <span class="brand-mark"><i></i><i></i><i></i></span>
        <span class="brand-text">交易日志</span>
      </button>
      <n-menu :collapsed="collapsed" :collapsed-width="64" :collapsed-icon-size="20" :value="activeKey"
        :options="menuOptions" @update:value="(key) => router.push(String(key))" />
      <div class="sidebar-foot">
        <div class="session-state"><span></span><b>{{ auth.username || '已登录' }}</b></div>
        <n-button quaternary block @click="logout"><span class="logout-icon">↪</span><span class="logout-text">退出</span></n-button>
      </div>
    </aside>
    <main class="app-main">
      <router-view v-slot="{ Component }">
        <transition name="page" mode="out-in"><component :is="Component" /></transition>
      </router-view>
    </main>
  </div>
</template>
