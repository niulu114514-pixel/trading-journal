<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useMessage } from 'naive-ui'
import { useAuthStore } from '../stores/auth'

const auth = useAuthStore()
const router = useRouter()
const route = useRoute()
const message = useMessage()
const password = ref('')
const confirmPassword = ref('')
const setupToken = ref('')
const loading = ref(false)
const isSetup = computed(() => !auth.initialized)

async function submit() {
  if (!password.value) return message.error('请输入密码')
  if (isSetup.value && password.value.length < 8) return message.error('管理员密码至少 8 位')
  if (isSetup.value && password.value !== confirmPassword.value) return message.error('两次密码不一致')
  if (isSetup.value && !setupToken.value.trim()) return message.error('请输入一次性初始化密钥')
  loading.value = true
  try {
    if (isSetup.value) await auth.setup(password.value, setupToken.value.trim())
    else await auth.login(password.value)
    message.success(isSetup.value ? '系统初始化完成' : '欢迎回来')
    await router.replace(String(route.query.redirect || '/dashboard'))
  } catch (error) {
    message.error(error instanceof Error ? error.message : '操作失败')
  } finally { loading.value = false }
}
</script>

<template>
  <div class="login-page">
    <div class="login-glow"></div>
    <n-card class="login-card" :bordered="false">
      <div class="login-brand"><span class="brand-mark"><i></i><i></i><i></i></span><div><h1>交易日志系统</h1><p>私人交易复盘与系统执行平台</p></div></div>
      <n-alert v-if="isSetup" type="info" :show-icon="false">首次使用需要管理员密码和部署时配置的一次性初始化密钥</n-alert>
      <n-form @submit.prevent="submit" size="large" :show-label="true">
        <n-form-item label="访问密码"><n-input v-model:value="password" type="password" show-password-on="mousedown" :placeholder="isSetup ? '至少 8 位' : '请输入访问密码'" @keyup.enter="submit" /></n-form-item>
        <n-form-item v-if="isSetup" label="确认密码"><n-input v-model:value="confirmPassword" type="password" show-password-on="mousedown" placeholder="再次输入密码" @keyup.enter="submit" /></n-form-item>
        <n-form-item v-if="isSetup" label="一次性初始化密钥"><n-input v-model:value="setupToken" type="password" show-password-on="mousedown" placeholder="部署时设置的 SETUP_TOKEN" @keyup.enter="submit" /></n-form-item>
        <n-button type="primary" block size="large" :loading="loading" attr-type="submit">{{ isSetup ? '初始化系统' : '进入系统' }}</n-button>
      </n-form>
      <div class="login-foot">D1 数据持久化 · HttpOnly 会话保护</div>
    </n-card>
  </div>
</template>
