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
});
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
    storage.image_storage = values.image_storage || "r2";
    storage.tg_bot_token = values.tg_bot_token || "";
    storage.tg_chat_id = values.tg_chat_id || "";
    imageStats.total = imageData.total || 0;
    imageStats.totalBytes = imageData.total_bytes || 0;
    backups.value = backupData;
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
function configPayload() {
  return {
    app_name: config.app_name,
    default_symbol: config.default_symbol,
    mcp_enabled: String(config.mcp_enabled),
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
        <p>统一维护表单选项、图片存储、备份与账户安全</p>
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
                <span class="subtle">基础显示与 MCP 服务开关</span>
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
              ><div class="modal-actions">
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
