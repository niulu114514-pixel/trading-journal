<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { useDialog, useMessage } from "naive-ui";
import { api } from "../services/api";
import type { Setting } from "../types";

interface ConfigEntry {
  config_key: string;
  config_value: string;
  description?: string;
}
interface BackupEntry {
  id: string;
  label: string;
  status: "running" | "completed" | "failed";
  table_count: number;
  row_count: number;
  object_count: number;
  reused_object_count: number;
  total_size: number;
  error?: string;
  verified_at?: string;
  created_at: string;
  completed_at?: string;
}

const message = useMessage();
const dialog = useDialog();
const loading = ref(false);
const saving = ref(false);
const settings = ref<Record<string, Setting[]>>({});
const active = ref("timeframe");
const showForm = ref(false);
const editId = ref<number | null>(null);
const imageStats = reactive({ total: 0, totalBytes: 0 });
const backups = ref<BackupEntry[]>([]);
const backupName = ref("");
const backupBusy = ref(false);
const aiModels = ref<{ label: string; value: string }[]>([]);
const cfModels = ref<{ label: string; value: string }[]>([]);
const loadingAiModels = ref(false);
const cfUsage = reactive({
  neurons: 0,
  effective_neurons: 0,
  local_neurons: 0,
  local_requests: 0,
  account_requests: null as number | null,
  neuron_limit: 9000,
  reset_at: "00:00 UTC",
  source: "local_fallback",
  warning: "",
});
const aiTesting = ref<"primary" | "cloudflare" | "">("");
const aiTestResult = ref<any>(null);
let backupPoll: number | undefined;
const maintenancePolls = new Set<number>();
const categories: Record<string, string> = {
  symbol: "交易品种",
  timeframe: "时间级别",
  pattern: "交易形态",
  trade_type: "交易类型",
  market_cycle: "市场周期",
  exit_type: "出场方式",
  rule_category: "规则分类",
  mindmap_category: "脑图分类",
  system_node_type: "脑图节点类型",
};
const sections = [
  { key: "business-heading", label: "业务设置", heading: true },
  ...Object.entries(categories).map(([key, label]) => ({
    key,
    label,
    heading: false,
  })),
  { key: "system-heading", label: "系统设置", heading: true },
  { key: "system", label: "系统配置", heading: false },
  { key: "storage", label: "图片存储", heading: false },
  { key: "backup", label: "数据备份", heading: false },
  { key: "account", label: "账户安全", heading: false },
];
const items = computed(() => settings.value[active.value] || []);
const symbolOptions = computed(() =>
  (settings.value.symbol || [])
    .filter((item) => Boolean(item.is_active))
    .map((item) => ({ label: item.label, value: item.value })),
);
const form = reactive({
  label: "",
  value: "",
  color: "#3ec9c5",
  sort_order: 0,
  is_active: true,
});
const config = reactive({
  app_name: "交易日志系统",
  default_symbol: "XAUUSD",
  mcp_enabled: true,
  market_data_url: "",
  market_data_key: "",
  ai_enabled: false,
  ai_base_url: "https://api.openai.com/v1",
  ai_api_format: "auto",
  ai_model: "",
  ai_api_key: "",
  ai_cf_fallback_enabled: true,
  ai_cf_fallback_model: "@cf/meta/llama-3.2-3b-instruct",
  ai_cf_daily_neuron_limit: 9000,
  ai_cf_account_id: "",
  ai_cf_api_token: "",
});
const aiFormatOptions = [
  { label: "自动识别（推荐）", value: "auto" },
  { label: "Responses API", value: "responses" },
  { label: "Chat Completions API", value: "chat_completions" },
];
const storage = reactive({
  image_storage: "r2",
  tg_bot_token: "",
  tg_chat_id: "",
});
const password = reactive({
  old_password: "",
  new_password: "",
  confirm_password: "",
});

function readableSize(bytes = 0) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}
async function load() {
  loading.value = true;
  try {
    const [all, entries, imageData, backupData] = await Promise.all([
      api.get<Record<string, Setting[]>>("/settings/all"),
      api.get<ConfigEntry[]>("/config"),
      api.get<any>("/images?page=1&limit=1"),
      api.get<BackupEntry[]>("/backups"),
    ]);
    settings.value = all;
    const values = Object.fromEntries(
      entries.map((item) => [item.config_key, item.config_value]),
    );
    config.app_name = values.app_name || "交易日志系统";
    config.default_symbol = values.default_symbol || "XAUUSD";
    config.mcp_enabled = values.mcp_enabled !== "false";
    config.market_data_url = values.market_data_url || "";
    config.market_data_key = values.market_data_key || "";
    config.ai_enabled = values.ai_enabled === "true";
    config.ai_base_url = values.ai_base_url || "https://api.openai.com/v1";
    config.ai_api_format = values.ai_api_format || "auto";
    config.ai_model = values.ai_model || "";
    config.ai_api_key = values.ai_api_key || "";
    config.ai_cf_fallback_enabled = values.ai_cf_fallback_enabled !== "false";
    config.ai_cf_fallback_model =
      values.ai_cf_fallback_model || "@cf/meta/llama-3.2-3b-instruct";
    config.ai_cf_daily_neuron_limit = Number(
      values.ai_cf_daily_neuron_limit || 9000,
    );
    config.ai_cf_account_id = values.ai_cf_account_id || "";
    config.ai_cf_api_token = values.ai_cf_api_token || "";
    storage.image_storage = values.image_storage || "r2";
    storage.tg_bot_token = values.tg_bot_token || "";
    storage.tg_chat_id = values.tg_chat_id || "";
    imageStats.total = imageData.total || 0;
    imageStats.totalBytes = imageData.total_bytes || 0;
    backups.value = backupData;
    void loadAiModels();
  } finally {
    loading.value = false;
  }
}
function open(item?: Setting) {
  editId.value = item?.id ?? null;
  Object.assign(
    form,
    item
      ? {
          label: item.label,
          value: item.value,
          color: item.color || "#3ec9c5",
          sort_order: item.sort_order,
          is_active: Boolean(item.is_active),
        }
      : {
          label: "",
          value: "",
          color: "#3ec9c5",
          sort_order: items.value.length,
          is_active: true,
        },
  );
  showForm.value = true;
}
async function save() {
  if (!form.label.trim() || !form.value.trim())
    return message.error("请填写名称和保存值");
  if (
    active.value === "system_node_type" &&
    !/^[\p{L}\p{N}_-]{1,40}$/u.test(form.value.trim())
  )
    return message.error(
      "节点类型保存值只能包含文字、数字、下划线或连字符，最多 40 个字符",
    );
  const payload = { category: active.value, ...form };
  if (editId.value) await api.put(`/settings/${editId.value}`, payload);
  else await api.post("/settings", payload);
  message.success("设置已保存");
  showForm.value = false;
  await load();
}
async function toggle(item: Setting, value: boolean) {
  await api.put(`/settings/${item.id}`, { is_active: value });
  item.is_active = value;
  message.success(value ? "选项已启用" : "选项已停用");
}
function editOnDoubleClick(event: MouseEvent, item: Setting) {
  if ((event.target as HTMLElement).closest('button,[role="switch"]')) return;
  open(item);
}
function remove(item: Setting) {
  dialog.warning({
    title: "删除选项",
    content: `确定删除“${item.label}”吗？`,
    positiveText: "删除",
    negativeText: "取消",
    async onPositiveClick() {
      try {
        await api.del(`/settings/${item.id}`);
        message.success("选项已删除");
        await load();
      } catch (error) {
        message.error(error instanceof Error ? error.message : "选项删除失败");
      }
    },
  });
}
async function loadAiModels() {
  loadingAiModels.value = true;
  try {
    const [data, usage] = await Promise.all([
      api.get<any>("/ai/models"),
      api.get<any>("/ai/cloudflare-usage"),
    ]);
    aiModels.value = (data.models || []).map((value: string) => ({
      label: value,
      value,
    }));
    cfModels.value = (data.cloudflare_models || []).map((item: any) => ({
      label: item.label || item.id,
      value: item.id,
    }));
    Object.assign(cfUsage, usage);
    if (data.warning)
      message.warning(`主模型列表获取失败，可继续手动输入：${data.warning}`);
    if (data.cloudflare_warning)
      message.warning(
        `Cloudflare 动态目录获取失败，已使用内置当前模型：${data.cloudflare_warning}`,
      );
  } catch (error) {
    message.warning(
      error instanceof Error
        ? error.message
        : "模型列表获取失败，可继续手动输入",
    );
  } finally {
    loadingAiModels.value = false;
  }
}
function configPayload() {
  return {
    app_name: config.app_name,
    default_symbol: config.default_symbol,
    mcp_enabled: String(config.mcp_enabled),
    market_data_url: config.market_data_url,
    market_data_key: config.market_data_key,
    ai_enabled: String(config.ai_enabled),
    ai_base_url: config.ai_base_url,
    ai_api_format: config.ai_api_format,
    ai_model: config.ai_model,
    ai_api_key: config.ai_api_key,
    ai_cf_fallback_enabled: String(config.ai_cf_fallback_enabled),
    ai_cf_fallback_model: config.ai_cf_fallback_model,
    ai_cf_daily_neuron_limit: String(config.ai_cf_daily_neuron_limit),
    ai_cf_account_id: config.ai_cf_account_id,
    ai_cf_api_token: config.ai_cf_api_token,
  };
}
async function saveConfig() {
  saving.value = true;
  try {
    await api.put("/config", configPayload());
    message.success("系统配置已保存");
    await load();
  } finally {
    saving.value = false;
  }
}
async function testAi(provider: "primary" | "cloudflare") {
  aiTesting.value = provider;
  aiTestResult.value = null;
  try {
    await api.put("/config", configPayload());
    const result = await api.post<any>("/ai/test", { provider });
    aiTestResult.value = result;
    message.success(
      `${provider === "primary" ? "主模型" : "Cloudflare 模型"}连接正常`,
    );
    await loadAiModels();
  } catch (error) {
    aiTestResult.value = {
      success: false,
      provider,
      error: error instanceof Error ? error.message : "测试失败",
    };
    message.error(aiTestResult.value.error);
  } finally {
    aiTesting.value = "";
  }
}
async function saveStorage(showSuccess = true) {
  saving.value = true;
  try {
    await api.put("/config", storage);
    if (showSuccess) message.success("存储配置已保存");
    await load();
  } finally {
    saving.value = false;
  }
}
async function testTelegram() {
  await saveStorage(false);
  const result = await api.post<any>("/tg/test", {});
  message.success(result.message || "Telegram 连接测试成功");
}
function monitorMaintenance(jobId: string, onComplete: (job: any) => void) {
  const timer = window.setInterval(async () => {
    try {
      const job = await api.get<any>(`/maintenance-jobs/${jobId}`);
      if (job.status === "completed") {
        clearInterval(timer);
        maintenancePolls.delete(timer);
        onComplete(job);
      } else if (job.status === "failed") {
        clearInterval(timer);
        maintenancePolls.delete(timer);
        message.error(job.error || "后台任务失败");
      }
    } catch {
      clearInterval(timer);
      maintenancePolls.delete(timer);
    }
  }, 2500);
  maintenancePolls.add(timer);
}
async function reconcile() {
  const result = await api.post<any>("/images/reconcile", {});
  message.info("存储对账已进入后台，可安全离开页面");
  if (result.job_id)
    monitorMaintenance(result.job_id, () => {
      message.success("存储对账完成");
      void load();
    });
}
async function changePassword() {
  if (password.new_password.length < 8) return message.error("新密码至少 8 位");
  if (password.new_password !== password.confirm_password)
    return message.error("两次输入的新密码不一致");
  saving.value = true;
  try {
    await api.post("/auth/change-password", {
      old_password: password.old_password,
      new_password: password.new_password,
    });
    Object.assign(password, {
      old_password: "",
      new_password: "",
      confirm_password: "",
    });
    message.success("密码已更新，其他登录会话已失效");
  } finally {
    saving.value = false;
  }
}
async function refreshBackups() {
  backups.value = await api.get<BackupEntry[]>("/backups");
}
async function createBackup() {
  backupBusy.value = true;
  try {
    await api.post<any>("/backups", { label: backupName.value });
    backupName.value = "";
    message.success("备份任务已进入后台，可离开此页面");
    await refreshBackups();
  } finally {
    backupBusy.value = false;
  }
}
async function verifyBackup(item: BackupEntry) {
  backupBusy.value = true;
  try {
    const result = await api.post<any>(`/backups/${item.id}/verify`, {});
    message.info("备份校验已进入后台，可安全离开页面");
    if (result.job_id)
      monitorMaintenance(result.job_id, (job) => {
        const summary = job.result || {};
        message.success(
          `校验通过：${summary.row_count || 0} 条记录、${summary.object_count || 0} 个文件`,
        );
        void refreshBackups();
      });
  } finally {
    backupBusy.value = false;
  }
}
function restoreBackup(item: BackupEntry) {
  dialog.warning({
    title: "恢复完整备份",
    content: `将用“${item.label}”覆盖当前数据库和全部图片。系统会先创建安全备份，并在 Cloudflare Workflow 中分阶段恢复；任务启动后当前会话会失效。`,
    positiveText: "启动恢复",
    negativeText: "取消",
    async onPositiveClick() {
      backupBusy.value = true;
      try {
        await api.post(`/backups/${item.id}/restore`, { confirm: "RESTORE" });
        message.success("恢复任务已进入后台，请稍后重新登录查看结果");
        window.setTimeout(() => window.location.assign("/login"), 1200);
      } catch (error) {
        message.error(error instanceof Error ? error.message : "备份恢复失败");
      } finally {
        backupBusy.value = false;
      }
    },
  });
}
function removeBackup(item: BackupEntry) {
  dialog.warning({
    title: "删除备份",
    content: `确定永久删除“${item.label}”及其中的全部图片副本吗？`,
    positiveText: "永久删除",
    negativeText: "取消",
    async onPositiveClick() {
      try {
        await api.del(`/backups/${item.id}`);
        message.success("备份已删除");
        await load();
      } catch (error) {
        message.error(error instanceof Error ? error.message : "备份删除失败");
      }
    },
  });
}
function backupStatus(item: BackupEntry) {
  return item.status === "completed"
    ? "可恢复"
    : item.status === "running"
      ? "备份中"
      : "失败";
}
onMounted(() => {
  void load();
  backupPoll = window.setInterval(() => {
    if (
      active.value === "backup" &&
      backups.value.some((item) => item.status === "running")
    )
      void refreshBackups();
  }, 3000);
});
onBeforeUnmount(() => {
  clearInterval(backupPoll);
  maintenancePolls.forEach((timer) => clearInterval(timer));
});
</script>

<template>
  <section class="page">
    <header class="page-head">
      <div>
        <h1>自定义设置</h1>
        <p>统一维护表单选项、行情连接、图片存储与账户安全</p>
      </div>
      <n-button v-if="categories[active]" type="primary" @click="open()"
        >新增选项</n-button
      >
    </header>
    <div class="settings-shell panel">
      <aside class="settings-nav">
        <template v-for="section in sections" :key="section.key"
          ><strong v-if="section.heading" class="settings-nav-heading">{{
            section.label
          }}</strong
          ><button
            v-else
            :class="{ active: section.key === active }"
            @click="active = section.key"
          >
            <span>{{ section.label }}</span
            ><b v-if="categories[section.key]">{{
              (settings[section.key] || []).length
            }}</b>
          </button></template
        >
      </aside>
      <div class="settings-content">
        <n-spin :show="loading">
          <template v-if="categories[active]"
            ><div class="panel-head">
              <h3>{{ categories[active] }}</h3>
              <span class="subtle"
                >双击任意选项可修改；开关可快速启用或停用</span
              >
            </div>
            <div class="settings-items">
              <div
                v-for="item in items"
                :key="item.id"
                class="setting-item editable-setting"
                title="双击编辑"
                @dblclick="editOnDoubleClick($event, item)"
              >
                <i :style="{ background: item.color || '#3ec9c5' }"></i>
                <div>
                  <strong>{{ item.label }}</strong
                  ><small>{{ item.value }}</small>
                </div>
                <n-switch
                  :value="Boolean(item.is_active)"
                  size="small"
                  @update:value="toggle(item, $event)"
                  ><template #checked>启用</template
                  ><template #unchecked>停用</template></n-switch
                ><n-button size="tiny" @click="open(item)">编辑</n-button
                ><n-button size="tiny" type="error" ghost @click="remove(item)"
                  >删除</n-button
                >
              </div>
              <div v-if="!items.length" class="empty-box">
                <strong>暂无选项</strong>
              </div>
            </div></template
          >

          <div v-else-if="active === 'system'" class="settings-form">
            <div class="panel-head">
              <div>
                <h3>系统配置</h3>
                <span class="subtle"
                  >行情、MCP 与 AI 的敏感密钥只会以掩码形式返回网页</span
                >
              </div>
            </div>
            <n-form label-placement="top"
              ><n-grid responsive="screen" :x-gap="14" :cols="'1 s:2'"
                ><n-form-item-gi label="应用名称"
                  ><n-input v-model:value="config.app_name" /></n-form-item-gi
                ><n-form-item-gi label="默认交易品种"
                  ><n-select
                    v-model:value="config.default_symbol"
                    filterable
                    :options="symbolOptions"
                    placeholder="请先在交易品种中添加" /></n-form-item-gi
                ><n-form-item-gi label="启用 MCP"
                  ><n-switch
                    v-model:value="
                      config.mcp_enabled
                    " /></n-form-item-gi></n-grid
              ><n-alert type="info" :bordered="false"
                >MCP 端点固定为 /api/mcp，关闭后所有 MCP
                请求会立即停止服务。</n-alert
              ><n-divider>td-forex-mcp 行情连接</n-divider
              ><n-form-item label="行情服务 URL"
                ><n-input
                  v-model:value="config.market_data_url"
                  placeholder="https://fx.example.workers.dev" /></n-form-item
              ><n-form-item label="行情访问密钥"
                ><n-input
                  v-model:value="config.market_data_key"
                  type="password"
                  show-password-on="click"
                  placeholder="留空表示未配置" /></n-form-item
              ><n-alert type="info" :bordered="false"
                >K 线页通过服务端调用
                td-forex-mcp，密钥不会下发到浏览器；页面会定时刷新，并标注数据更新时间。</n-alert
              ><n-divider>站内 AI 工作台</n-divider
              ><n-grid responsive="screen" :x-gap="14" :cols="'1 s:2'"
                ><n-form-item-gi label="启用 AI"
                  ><n-switch
                    v-model:value="config.ai_enabled" /></n-form-item-gi
                ><n-form-item-gi label="API 格式"
                  ><n-select
                    v-model:value="config.ai_api_format"
                    :options="aiFormatOptions" /></n-form-item-gi></n-grid
              ><n-form-item label="AI API 地址（基础地址或完整端点）"
                ><n-input
                  v-model:value="config.ai_base_url"
                  placeholder="https://api.example.com/v1 或 .../chat/completions" /></n-form-item
              ><n-form-item label="AI API 密钥"
                ><n-input
                  v-model:value="config.ai_api_key"
                  type="password"
                  show-password-on="click"
                  placeholder="配置后仅由 Worker 服务端使用" /></n-form-item
              ><n-form-item label="主模型"
                ><n-input-group
                  ><n-select
                    v-model:value="config.ai_model"
                    filterable
                    tag
                    :options="aiModels"
                    :loading="loadingAiModels"
                    placeholder="自动获取或手动输入模型 ID"
                  /><n-button :loading="loadingAiModels" @click="loadAiModels"
                    >获取模型</n-button
                  ><n-button
                    :loading="aiTesting === 'primary'"
                    @click="testAi('primary')"
                    >测试主模型</n-button
                  ></n-input-group
                ></n-form-item
              ><n-divider>Cloudflare 备用保护</n-divider
              ><n-form-item label="启用 Cloudflare 备用模型"
                ><n-switch
                  v-model:value="config.ai_cf_fallback_enabled" /></n-form-item
              ><template v-if="config.ai_cf_fallback_enabled"
                ><n-form-item label="Cloudflare Workers AI 模型"
                  ><n-select
                    v-model:value="config.ai_cf_fallback_model"
                    filterable
                    tag
                    :options="cfModels"
                    placeholder="@cf/meta/llama-3.2-3b-instruct"
                  /><n-button
                    style="margin-top: 8px"
                    :loading="aiTesting === 'cloudflare'"
                    @click="testAi('cloudflare')"
                    >测试 Cloudflare 模型</n-button
                  ></n-form-item
                ><n-grid responsive="screen" :x-gap="14" :cols="'1 s:2'"
                  ><n-form-item-gi label="Cloudflare Account ID（可选）"
                    ><n-input
                      v-model:value="config.ai_cf_account_id"
                      placeholder="用于动态读取当前账户可用模型" /></n-form-item-gi
                  ><n-form-item-gi label="Workers AI Read Token（可选）"
                    ><n-input
                      v-model:value="config.ai_cf_api_token"
                      type="password"
                      show-password-on="click"
                      placeholder="只需 Workers AI Read 权限" /></n-form-item-gi></n-grid
                ><n-grid responsive="screen" :x-gap="14" :cols="1"
                  ><n-form-item-gi label="UTC 每日神经元保护阈值"
                    ><n-input-number
                      v-model:value="config.ai_cf_daily_neuron_limit"
                      :min="1"
                      :max="10000"
                      :step="100" /></n-form-item-gi></n-grid
                ><n-alert :type="cfUsage.source === 'cloudflare_account' ? 'info' : 'warning'" :bordered="false"
                  >{{ cfUsage.source === "cloudflare_account" ? "Cloudflare 账户今日真实用量" : "本系统今日本地记录" }}：
                  {{ Number(cfUsage.neurons).toFixed(2) }} /
                  {{ cfUsage.neuron_limit }} neurons。仅按神经元保护，不限制调用次数和 Token；00:00 UTC 重置。
                  <template v-if="cfUsage.source === 'cloudflare_account'">账户统计包含全部 Worker、REST API 与控制台调用；本系统已记录 {{ Number(cfUsage.local_neurons).toFixed(2) }} neurons。</template>
                  <template v-else>账户统计暂不可用，将按本地记录保护。{{ cfUsage.warning }}</template></n-alert
                ></template
              ><n-alert type="info" :bordered="false"
                >自动识别 /responses 或
                /chat/completions；主模型超时或报错时才切换备用模型。脑图精修由后台任务执行，不占住页面请求。</n-alert
              ><n-alert type="warning" :bordered="false"
                >AI
                分析会把当前对话和必要的交易数据发送给你配置的模型服务。执行写操作还需要在
                AI 页面单独开启授权。</n-alert
              >
              <n-alert
                v-if="aiTestResult"
                :type="aiTestResult.success ? 'success' : 'error'"
                :bordered="false"
                >{{ aiTestResult.success ? "连接测试成功" : "连接测试失败" }} ·
                {{ aiTestResult.model || aiTestResult.provider }} ·
                {{ aiTestResult.latency_ms || 0 }} ms
                <template v-if="aiTestResult.usage?.total_tokens">
                  · {{ aiTestResult.usage.total_tokens }} tokens</template
                ><template v-if="aiTestResult.usage?.neurons !== undefined">
                  · {{ Number(aiTestResult.usage.neurons).toFixed(2) }} neurons</template
                ><template v-if="aiTestResult.error"> · {{ aiTestResult.error }}</template>
              </n-alert>
              <div class="modal-actions">
                <n-button type="primary" :loading="saving" @click="saveConfig"
                  >保存系统配置</n-button
                >
              </div></n-form
            >
          </div>

          <div v-else-if="active === 'storage'" class="settings-form">
            <div class="panel-head">
              <div>
                <h3>图片存储</h3>
                <span class="subtle"
                  >{{ imageStats.total }} 张 ·
                  {{ readableSize(imageStats.totalBytes) }}</span
                >
              </div>
              <n-button size="small" @click="reconcile">同步存储状态</n-button>
            </div>
            <n-form label-placement="top"
              ><n-form-item label="存储策略"
                ><n-radio-group v-model:value="storage.image_storage"
                  ><n-space
                    ><n-radio value="r2">Cloudflare R2</n-radio
                    ><n-radio value="tg">Telegram</n-radio
                    ><n-radio value="both">R2 + Telegram</n-radio></n-space
                  ></n-radio-group
                ></n-form-item
              ><n-alert type="warning" :bordered="false"
                >R2
                是网页查看与公开链接的主存储。若在桶内手动删图，请点击“同步存储状态”清除失效记录与数量。</n-alert
              ><n-divider>Telegram 备份</n-divider
              ><n-form-item label="Bot Token"
                ><n-input
                  v-model:value="storage.tg_bot_token"
                  type="password"
                  show-password-on="click"
                  placeholder="未配置" /></n-form-item
              ><n-form-item label="Chat ID"
                ><n-input
                  v-model:value="storage.tg_chat_id"
                  placeholder="频道、群组或用户 ID"
              /></n-form-item>
              <div class="modal-actions">
                <n-button @click="testTelegram">保存并测试 Telegram</n-button
                ><n-button
                  type="primary"
                  :loading="saving"
                  @click="saveStorage()"
                  >保存存储配置</n-button
                >
              </div></n-form
            >
          </div>

          <div
            v-else-if="active === 'backup'"
            class="settings-form backup-settings"
          >
            <div class="panel-head">
              <div>
                <h3>完整数据备份</h3>
                <span class="subtle"
                  >Cloudflare Workflow 后台执行 · 每日 02:00 自动备份 ·
                  默认保留最近 7 份</span
                >
              </div>
            </div>
            <div class="backup-create">
              <n-input
                v-model:value="backupName"
                maxlength="80"
                placeholder="备份名称（可选）"
              /><n-button
                type="primary"
                :loading="backupBusy"
                @click="createBackup"
                >立即完整备份</n-button
              >
            </div>
            <n-alert type="info" :bordered="false"
              >敏感配置使用 AES-GCM
              加密；未变化图片按内容指纹复用。任务进入后台后可以安全离开页面，恢复前会先校验清单和全部对象。</n-alert
            >
            <div class="backup-list">
              <article v-for="item in backups" :key="item.id">
                <div>
                  <strong>{{ item.label }}</strong
                  ><span
                    >{{ item.created_at }} · {{ item.row_count }} 条记录 ·
                    {{ item.object_count }} 个文件<span
                      v-if="item.reused_object_count"
                      >（复用 {{ item.reused_object_count }}）</span
                    >
                    · {{ readableSize(item.total_size) }}</span
                  ><small v-if="item.verified_at"
                    >完整性已校验 · {{ item.verified_at }}</small
                  ><small v-if="item.error">{{ item.error }}</small>
                </div>
                <n-tag
                  :type="
                    item.status === 'completed'
                      ? 'success'
                      : item.status === 'running'
                        ? 'warning'
                        : 'error'
                  "
                  size="small"
                  >{{ backupStatus(item) }}</n-tag
                ><n-button
                  size="tiny"
                  :disabled="item.status !== 'completed' || backupBusy"
                  @click="verifyBackup(item)"
                  >校验</n-button
                ><n-button
                  size="tiny"
                  :disabled="item.status !== 'completed' || backupBusy"
                  @click="restoreBackup(item)"
                  >恢复</n-button
                ><n-button
                  size="tiny"
                  type="error"
                  ghost
                  :disabled="item.status === 'running'"
                  @click="removeBackup(item)"
                  >删除</n-button
                >
              </article>
              <div v-if="!backups.length" class="empty-box">
                <strong>还没有完整备份</strong
                ><span>建议在批量修改规则、脑图或交易前创建一份</span>
              </div>
            </div>
          </div>

          <div v-else class="settings-form">
            <div class="panel-head">
              <div>
                <h3>账户安全</h3>
                <span class="subtle"
                  >修改后保留当前会话，其他设备将退出登录</span
                >
              </div>
            </div>
            <n-form label-placement="top"
              ><n-form-item label="当前密码"
                ><n-input
                  v-model:value="password.old_password"
                  type="password"
                  show-password-on="click" /></n-form-item
              ><n-form-item label="新密码"
                ><n-input
                  v-model:value="password.new_password"
                  type="password"
                  show-password-on="click"
                  placeholder="至少 8 位" /></n-form-item
              ><n-form-item label="确认新密码"
                ><n-input
                  v-model:value="password.confirm_password"
                  type="password"
                  show-password-on="click"
              /></n-form-item>
              <div class="modal-actions">
                <n-button
                  type="primary"
                  :loading="saving"
                  @click="changePassword"
                  >更新密码</n-button
                >
              </div></n-form
            >
          </div>
        </n-spin>
      </div>
    </div>
    <n-modal
      v-model:show="showForm"
      preset="card"
      :title="editId ? '编辑选项' : '新增选项'"
      class="form-modal"
      ><n-form label-placement="top"
        ><n-form-item label="显示名称"
          ><n-input v-model:value="form.label" /></n-form-item
        ><n-form-item label="保存值"
          ><n-input v-model:value="form.value" /></n-form-item
        ><n-grid :cols="2" :x-gap="12"
          ><n-form-item-gi label="颜色"
            ><n-color-picker
              v-model:value="form.color"
              :show-alpha="false" /></n-form-item-gi
          ><n-form-item-gi label="排序"
            ><n-input-number
              v-model:value="form.sort_order" /></n-form-item-gi></n-grid
        ><n-form-item label="状态"
          ><n-switch v-model:value="form.is_active"
        /></n-form-item>
        <div class="modal-actions">
          <n-button @click="showForm = false">取消</n-button
          ><n-button type="primary" @click="save">保存</n-button>
        </div></n-form
      ></n-modal
    >
  </section>
</template>
