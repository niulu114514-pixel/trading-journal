<script setup lang="ts">
import { computed, h, onMounted, reactive, ref } from 'vue'
import { NButton, NSpace, NTag, useDialog, useMessage, type DataTableColumns } from 'naive-ui'
import { api } from '../services/api'
import type { Rule, Setting } from '../types'

const message = useMessage(); const dialog = useDialog()
const loading = ref(false); const rules = ref<Rule[]>([]); const category = ref(''); const showForm = ref(false); const editingId = ref<number | null>(null)
const defaultCategories = ['入场规则','出场规则','资金管理','心态纪律','复盘总结']
const categories = ref([...defaultCategories])
const form = reactive({ title:'', category:'入场规则', content:'', tags:'', priority:0, is_active:true })
const filtered = computed(() => category.value ? rules.value.filter(r => r.category === category.value) : rules.value)

async function load() { loading.value=true; try { rules.value=await api.get<Rule[]>('/rules'); const custom=await api.get<Setting[]>('/settings?category=rule_category'); categories.value=[...new Set([...defaultCategories,...custom.filter(v=>Boolean(v.is_active)).map(v=>v.value)])] } finally { loading.value=false } }
function open(rule?:Rule){ editingId.value=rule?.id||null; Object.assign(form,rule?{title:rule.title,category:rule.category,content:rule.content,tags:rule.tags||'',priority:rule.priority,is_active:Boolean(rule.is_active)}:{title:'',category:categories.value[0],content:'',tags:'',priority:0,is_active:true}); showForm.value=true }
async function save(){ if(!form.title.trim()||!form.content.trim())return message.error('请填写标题和内容'); const payload={...form,tags:form.tags||null}; if(editingId.value)await api.put(`/rules/${editingId.value}`,payload);else await api.post('/rules',payload); message.success(editingId.value?'规则已更新':'规则已添加');showForm.value=false;await load() }
function remove(rule:Rule){dialog.warning({title:'删除规则',content:`确定删除“${rule.title}”吗？引用它的系统节点将保留但解除引用。`,positiveText:'删除',negativeText:'取消',async onPositiveClick(){try{await api.del(`/rules/${rule.id}`);message.success('规则已删除');await load()}catch(error){message.error(error instanceof Error?error.message:'规则删除失败')}}})}
function ruleRowProps(row:Rule){return{class:'editable-row',title:'双击编辑规则',onDblclick:(event:MouseEvent)=>{if((event.target as HTMLElement).closest('button'))return;open(row)}}}
const columns:DataTableColumns<Rule>=[
  {title:'规则',key:'title',minWidth:220,render:r=>h('div',{class:'rule-title-cell'},[h('strong',r.title),h('small',r.content)])},
  {title:'分类',key:'category',width:110,render:r=>h(NTag,{size:'small',bordered:false},{default:()=>r.category})},
  {title:'标签',key:'tags',minWidth:150,render:r=>h(NSpace,{size:4},()=>String(r.tags||'').split(',').filter(Boolean).slice(0,3).map(t=>h(NTag,{size:'tiny'},{default:()=>t.trim()})))},
  {title:'优先级',key:'priority',width:75},{title:'状态',key:'is_active',width:80,render:r=>h(NTag,{type:r.is_active?'success':'default',size:'small'},{default:()=>r.is_active?'启用':'停用'})},
  {title:'操作',key:'actions',width:140,render:r=>h(NSpace,{size:6},()=>[h(NButton,{size:'tiny',onClick:()=>open(r)},{default:()=> '编辑'}),h(NButton,{size:'tiny',type:'error',ghost:true,onClick:()=>remove(r)},{default:()=> '删除'})])}
]
onMounted(load)
</script>
<template><section class="page"><header class="page-head"><div><h1>交易规则</h1><p>规则是可复用约束，交易系统通过节点选择引用</p></div><n-button type="primary" @click="open()">新增规则</n-button></header>
  <div class="rule-filter"><n-button size="small" :type="!category?'primary':'default'" @click="category=''">全部</n-button><n-button v-for="item in categories" :key="item" size="small" :type="category===item?'primary':'default'" @click="category=item">{{item}}</n-button></div>
  <div class="panel table-panel"><n-data-table :columns="columns" :data="filtered" :loading="loading" :bordered="false" :single-line="false" :scroll-x="850" :row-props="ruleRowProps" /></div>
  <n-modal v-model:show="showForm" preset="card" :title="editingId?'编辑规则':'新增规则'" class="form-modal"><n-form label-placement="top"><n-form-item label="规则标题"><n-input v-model:value="form.title" placeholder="如：EMA20 趋势确认" /></n-form-item><n-form-item label="分类"><n-select v-model:value="form.category" :options="categories.map(v=>({label:v,value:v}))" /></n-form-item><n-form-item label="规则内容"><n-input v-model:value="form.content" type="textarea" :rows="5" /></n-form-item><n-form-item label="标签"><n-input v-model:value="form.tags" placeholder="趋势, EMA, 做多" /></n-form-item><n-grid :cols="2" :x-gap="12"><n-form-item-gi label="优先级"><n-input-number v-model:value="form.priority" /></n-form-item-gi><n-form-item-gi label="状态"><n-switch v-model:value="form.is_active"><template #checked>启用</template><template #unchecked>停用</template></n-switch></n-form-item-gi></n-grid><div class="modal-actions"><n-button @click="showForm=false">取消</n-button><n-button type="primary" @click="save">保存</n-button></div></n-form></n-modal>
</section></template>
