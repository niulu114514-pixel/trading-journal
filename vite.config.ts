import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import Components from 'unplugin-vue-components/vite'
import { NaiveUiResolver } from 'unplugin-vue-components/resolvers'

export default defineConfig({
  root: 'frontend',
  plugins: [
    vue(),
    Components({
      dts: 'src/components.d.ts',
      resolvers: [NaiveUiResolver()]
    })
  ],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    modulePreload: { polyfill: false },
    sourcemap: false,
    target: 'es2022',
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('@vue-flow')) return 'vue-flow'
          if (id.includes('lightweight-charts')) return 'charts'
          if (id.includes('node_modules/vue') || id.includes('node_modules/pinia')) return 'vue-core'
        }
      }
    }
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8788',
      '/i': 'http://127.0.0.1:8788'
    }
  }
})
