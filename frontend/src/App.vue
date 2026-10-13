<script setup lang="ts">
import { darkTheme, NConfigProvider, NDialogProvider, NLoadingBarProvider, NMessageProvider, NNotificationProvider, zhCN, dateZhCN } from 'naive-ui'

const themeOverrides = {
  common: {
    primaryColor: '#3ec9c5',
    primaryColorHover: '#69d9d5',
    primaryColorPressed: '#2baaa7',
    primaryColorSuppl: '#3ec9c5',
    bodyColor: '#090d14',
    cardColor: '#101620',
    modalColor: '#101620',
    popoverColor: '#141b27',
    inputColor: '#0c1119',
    borderColor: '#202a3a',
    textColorBase: '#e5eaf3',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
    borderRadius: '8px'
  }
}
</script>

<template>
  <n-config-provider :theme="darkTheme" :theme-overrides="themeOverrides" :locale="zhCN" :date-locale="dateZhCN">
    <n-loading-bar-provider>
      <n-dialog-provider>
        <n-notification-provider>
          <n-message-provider placement="top-right">
            <router-view />
          </n-message-provider>
        </n-notification-provider>
      </n-dialog-provider>
    </n-loading-bar-provider>
  </n-config-provider>
</template>
