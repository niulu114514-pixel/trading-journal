import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api } from '../services/api'

interface AuthStatus { initialized: boolean; authenticated: boolean; username?: string | null; setup_token_required?: boolean }

export const useAuthStore = defineStore('auth', () => {
  const checked = ref(false)
  const initialized = ref(false)
  const authenticated = ref(false)
  const username = ref<string | null>(null)
  const setupTokenRequired = ref(false)

  async function check() {
    try {
      const status = await api.get<AuthStatus>('/auth/status')
      initialized.value = status.initialized
      authenticated.value = status.authenticated
      username.value = status.username || null
      setupTokenRequired.value = Boolean(status.setup_token_required)
    } finally {
      checked.value = true
    }
  }

  async function login(password: string) {
    const result = await api.post<{ success: boolean; error?: string }>('/auth/login', { password })
    if (!result.success) throw new Error(result.error || '登录失败')
    authenticated.value = true
    initialized.value = true
    username.value = 'admin'
  }

  async function setup(password: string, setupToken: string) {
    const result = await api.post<{ success: boolean; error?: string }>('/auth/setup', { password, setup_token: setupToken })
    if (!result.success) throw new Error(result.error || '初始化失败')
    initialized.value = true
    authenticated.value = true
    username.value = 'admin'
  }

  async function logout() {
    await api.post('/auth/logout')
    authenticated.value = false
    username.value = null
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('auth:expired', () => {
      authenticated.value = false
      username.value = null
    })
  }

  return { checked, initialized, authenticated, username, setupTokenRequired, check, login, setup, logout }
})
