<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useDialog, useMessage } from 'naive-ui'
import { api } from '../services/api'

type TargetType = 'image' | 'folder' | 'mindmap'
type ShareStatus = 'active' | 'expired' | 'revoked' | 'burned'
interface ShareLink { id:number;url:string;title:string;expires_at?:string|null;has_password:number|boolean;burn_after_read:number|boolean;burned_at?:string|null;access_count:number;created_at:string;status:ShareStatus }

const props=defineProps<{show:boolean;targetType:TargetType;targetId:number|null;targetTitle:string}>()
const emit=defineEmits<{(event:'update:show',value:boolean):void}>()
const message=useMessage(),dialog=useDialog(),loading=ref(false),creating=ref(false),links=ref<ShareLink[]>([])
const form=reactive({title:'',password:'',duration:'permanent',burn_after_read:false})
const durationOptions=[
  {label:'永久有效',value:'permanent'},
  {label:'1 小时',value:'1h'},
  {label:'1 天',value:'1d'},
  {label:'7 天',value:'7d'},
  {label:'30 天',value:'30d'}
]
const visible=computed({get:()=>props.show,set:value=>emit('update:show',value)})

function expiry(){
  const hours:Record<string,number>={"1h":1,"1d":24,"7d":168,"30d":720}
  return form.duration==='permanent'?null:new Date(Date.now()+(hours[form.duration]||24)*3600_000).toISOString()
}
function statusLabel(link:ShareLink){return link.status==='active'?'有效':link.status==='expired'?'已过期':link.status==='burned'?'已焚毁':'已停用'}
function statusType(link:ShareLink){return link.status==='active'?'success':link.status==='burned'?'warning':'default'}
function expiryLabel(value?:string|null){return value?new Date(`${value.replace(' ','T')}Z`).toLocaleString():'永久'}
async function load(){
  if(!props.targetId)return
  loading.value=true
  try{links.value=await api.get(`/shares?target_type=${props.targetType}&target_id=${props.targetId}`)}finally{loading.value=false}
}
async function copy(url:string){await navigator.clipboard.writeText(url);message.success('分享链接已复制')}
async function create(){
  if(!props.targetId)return
  if(form.password&&form.password.length<8)return message.error('分享密码至少 8 位')
  creating.value=true
  try{
    const result=await api.post<{url:string}>('/shares',{target_type:props.targetType,target_id:props.targetId,title:form.title.trim()||props.targetTitle,password:form.password||undefined,expires_at:expiry(),burn_after_read:form.burn_after_read})
    await copy(result.url)
    form.password=''
    form.burn_after_read=false
    await load()
  }catch(error){message.error(error instanceof Error?error.message:'创建分享失败')}finally{creating.value=false}
}
function revoke(link:ShareLink){dialog.warning({title:'停用分享',content:'停用后，已发送的链接会立即失效，但记录仍保留在历史分享中。',positiveText:'确认停用',negativeText:'保留',async onPositiveClick(){await api.post(`/shares/${link.id}/revoke`,{});message.success('分享已停用');await load()}})}
function removeLink(link:ShareLink){dialog.error({title:'永久删除分享链接',content:`确定删除“${link.title}”的分享记录吗？删除后无法恢复。`,positiveText:'永久删除',negativeText:'保留',async onPositiveClick(){await api.del(`/shares/${link.id}`);message.success('分享链接已永久删除');await load()}})}
watch(()=>props.show,show=>{if(show){form.title=props.targetTitle;form.password='';form.duration='permanent';form.burn_after_read=false;void load()}})
</script>

<template>
  <n-modal v-model:show="visible" preset="card" :title="`分享 · ${targetTitle}`" class="share-dialog">
    <n-alert type="info" :bordered="false">密码不会出现在链接中；可设置有效期，也可启用阅后即焚。停用会让链接失效，永久删除会清除历史记录。</n-alert>
    <n-form label-placement="top" class="share-create-form">
      <n-form-item label="分享标题"><n-input v-model:value="form.title" maxlength="120" /></n-form-item>
      <n-grid responsive="screen" cols="1 s:2" :x-gap="12">
        <n-form-item-gi label="有效期"><n-select v-model:value="form.duration" :options="durationOptions" /></n-form-item-gi>
        <n-form-item-gi label="访问密码（可选）"><n-input v-model:value="form.password" type="password" show-password-on="click" maxlength="128" placeholder="至少 8 位" /></n-form-item-gi>
      </n-grid>
      <div class="burn-option"><div><strong>阅后即焚</strong><small>首次成功打开后，链接立即对其他访问者失效；当前访问者可在 30 分钟内继续查看。</small></div><n-switch v-model:value="form.burn_after_read" /></div>
      <n-button type="primary" block :loading="creating" @click="create">一键创建并复制链接</n-button>
    </n-form>
    <n-divider>历史分享</n-divider>
    <n-spin :show="loading">
      <div v-if="links.length" class="share-link-list">
        <article v-for="link in links" :key="link.id" :class="link.status">
          <div><strong>{{link.title}}</strong><small>{{link.has_password?'密码保护 · ':''}}{{link.burn_after_read?'阅后即焚 · ':''}}{{expiryLabel(link.expires_at)}} · 已访问 {{link.access_count}} 次</small></div>
          <n-tag size="small" :type="statusType(link)">{{statusLabel(link)}}</n-tag>
          <n-button size="tiny" :disabled="link.status!=='active'" @click="copy(link.url)">复制</n-button>
          <n-button size="tiny" ghost :disabled="link.status!=='active'" @click="revoke(link)">停用</n-button>
          <n-button size="tiny" type="error" ghost @click="removeLink(link)">删除</n-button>
        </article>
      </div>
      <div v-else class="empty-box compact"><strong>暂无分享</strong><p>创建后链接会自动复制。</p></div>
    </n-spin>
  </n-modal>
</template>
