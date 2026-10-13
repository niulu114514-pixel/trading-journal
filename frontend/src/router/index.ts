import { createRouter, createWebHistory } from 'vue-router'
import { pinia } from '../stores'
import { useAuthStore } from '../stores/auth'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', name: 'login', component: () => import('../views/LoginView.vue'), meta: { public: true } },
    { path: '/share/:token', name: 'share', component: () => import('../views/ShareView.vue'), meta: { public: true } },
    {
      path: '/',
      component: () => import('../layouts/AppLayout.vue'),
      children: [
        { path: '', redirect: '/dashboard' },
        { path: 'dashboard', name: 'dashboard', component: () => import('../views/DashboardView.vue') },
        { path: 'journal', name: 'journal', component: () => import('../views/JournalView.vue') },
        { path: 'charts', name: 'charts', component: () => import('../views/ChartsView.vue') },
        { path: 'news', name: 'news', component: () => import('../views/NewsView.vue') },
        { path: 'images', name: 'images', component: () => import('../views/ImagesView.vue') },
        { path: 'systems', name: 'systems', component: () => import('../views/SystemsView.vue') },
        { path: 'rules', name: 'rules', component: () => import('../views/RulesView.vue') },
        { path: 'ai', name: 'ai', component: () => import('../views/AiView.vue') },
        { path: 'settings', name: 'settings', component: () => import('../views/SettingsView.vue') },
        { path: 'mcp', name: 'mcp', component: () => import('../views/McpView.vue') }
      ]
    },
    { path: '/:pathMatch(.*)*', redirect: '/dashboard' }
  ]
})

router.beforeEach(async (to) => {
  const auth = useAuthStore(pinia)
  if (!auth.checked) await auth.check()
  if (to.meta.public) return to.name === 'login' && auth.authenticated ? '/dashboard' : true
  return auth.authenticated ? true : { name: 'login', query: { redirect: to.fullPath } }
})

export default router
