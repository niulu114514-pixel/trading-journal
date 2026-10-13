import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api } from '../services/api'
import type { Setting, TradingSystemSummary } from '../types'

export const useSettingsStore = defineStore('settings', () => {
  const groups = ref<Record<string, Setting[]>>({})
  const systems = ref<TradingSystemSummary[]>([])
  const loaded = ref(false)

  async function load(force = false) {
    if (loaded.value && !force) return
    const [settings, systemList] = await Promise.all([
      api.get<Record<string, Setting[]>>('/settings/all'),
      api.get<TradingSystemSummary[]>('/systems')
    ])
    groups.value = settings
    systems.value = systemList
    loaded.value = true
  }

  return { groups, systems, loaded, load }
})
