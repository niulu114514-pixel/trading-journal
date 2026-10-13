import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

const testMigrations = await readD1Migrations('.')

export default defineConfig({
  plugins: [
    cloudflareTest({
      // 测试不加载远程 Workers AI/Workflow，避免等待连接或误耗神经元。
      wrangler: { configPath: './wrangler.test.jsonc' },
      miniflare: {
        bindings: {
          CONFIG_ENCRYPTION_KEY: 'test-config-encryption-key-with-32-bytes',
          SETUP_TOKEN: 'test-setup-token',
          TEST_MIGRATIONS: testMigrations
        }
      }
    })
  ]
})
