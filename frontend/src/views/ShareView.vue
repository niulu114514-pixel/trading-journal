<script setup lang="ts">
import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import { computed, nextTick, onMounted, ref } from 'vue'
import { MarkerType, VueFlow, type Edge, type Node, useVueFlow } from '@vue-flow/core'
import { Background } from '@vue-flow/background'
import { useRoute } from 'vue-router'

interface SharedImage {id:number;name:string;caption:string;category:string;tags:string;resource_url?:string|null;size:number;created_at:string;url:string}
interface SharedNode {id:number;parent_id:number|null;title:string;content?:string|null;node_type:string;sort_order:number;rule_title?:string|null;rule_category?:string|null}
interface SharePayload {title:string;target_type:'image'|'folder'|'mindmap';expires_at?:string|null;has_password:boolean;locked:boolean;content?:any;error?:string}

const route=useRoute(),token=String(route.params.token||''),loading=ref(true),unlocking=ref(false),password=ref(''),payload=ref<SharePayload|null>(null),error=ref('')
const flowNodes=ref<Node[]>([]),flowEdges=ref<Edge[]>([]),{fitView,zoomIn,zoomOut}=useVueFlow('shared-mindmap')
const images=computed<SharedImage[]>(()=>payload.value?.target_type==='image'?[payload.value.content?.image].filter(Boolean):payload.value?.content?.images||[])
function size(bytes=0){if(bytes<1024)return`${bytes} B`;if(bytes<1048576)return`${(bytes/1024).toFixed(1)} KB`;return`${(bytes/1048576).toFixed(1)} MB`}
function expiry(value?:string|null){return value?`有效至 ${new Date(`${value.replace(' ','T')}Z`).toLocaleString()}`:'永久有效'}
function nodeHeight(node:SharedNode){return 88+Math.ceil(String(node.title||'').length/17)*17+(node.content?Math.ceil(String(node.content).length/29)*15:0)+(node.rule_title?24:0)}
function buildMindmap(nodes:SharedNode[]){
  const map=new Map(nodes.map(node=>[node.id,{...node,children:[] as SharedNode[]}]))
  let root:any=null
  for(const node of map.values()){const parent=map.get(Number(node.parent_id));if(parent)parent.children.push(node);else if(!root)root=node}
  for(const node of map.values())node.children.sort((a:any,b:any)=>a.sort_order-b.sort_order||a.id-b.id)
  let cursor=0;const positions=new Map<number,{x:number;y:number}>(),edges:Edge[]=[]
  function visit(node:any,depth:number):number{const height=nodeHeight(node),children=node.children as SharedNode[];let center:number;if(!children.length){center=cursor+height/2;cursor+=height+30}else{const centers=children.map(child=>visit(child,depth+1));center=(centers[0]+centers[centers.length-1])/2;for(const child of children)edges.push({id:`e-${node.id}-${child.id}`,source:String(node.id),target:String(child.id),markerEnd:MarkerType.ArrowClosed,style:{stroke:'#2b6671',strokeWidth:1.5}})}positions.set(node.id,{x:depth*350,y:Math.max(0,center-height/2)});return center}
  if(root)visit(root,0)
  const nextNodes:Node[]=[]
  for(const [id,position] of positions)nextNodes.push({id:String(id),type:'share',position,data:map.get(id) as any,draggable:false,connectable:false})
  flowNodes.value=nextNodes
  flowEdges.value=edges
}
function fitReadable(){void fitView({padding:.12,duration:250,minZoom:.62,maxZoom:1})}
function fitAll(){void fitView({padding:.12,duration:250})}
async function load(){
  loading.value=true;error.value=''
  try{const response=await fetch(`/api/public/shares/${token}`,{credentials:'same-origin'});const data=await response.json() as SharePayload;if(response.status===401){payload.value=data;return}if(!response.ok)throw new Error(data.error||'分享加载失败');payload.value=data;document.title=`${data.title} · 分享`;if(data.target_type==='mindmap'){buildMindmap(data.content?.nodes||[]);await nextTick();window.setTimeout(fitReadable,80)}}
  catch(reason){error.value=reason instanceof Error?reason.message:'分享加载失败'}finally{loading.value=false}
}
async function unlock(){if(!password.value)return;unlocking.value=true;error.value='';try{const response=await fetch(`/api/public/shares/${token}/unlock`,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:password.value})});const data=await response.json();if(!response.ok)throw new Error(data.error||'密码验证失败');password.value='';await load()}catch(reason){error.value=reason instanceof Error?reason.message:'密码验证失败'}finally{unlocking.value=false}}
onMounted(load)
</script>

<template>
  <main class="public-share-page">
    <header class="public-share-brand"><span>◫</span><strong>交易日志分享</strong></header>
    <n-spin :show="loading">
      <section v-if="error" class="share-state-card"><div class="share-state-icon">!</div><h1>无法访问</h1><p>{{error}}</p></section>
      <section v-else-if="payload?.locked" class="share-state-card">
        <div class="share-state-icon">🔒</div><h1>{{payload.title}}</h1><p>此分享受密码保护 · {{expiry(payload.expires_at)}}</p>
        <n-input v-model:value="password" type="password" show-password-on="click" placeholder="输入分享密码" @keyup.enter="unlock" />
        <n-button type="primary" block :loading="unlocking" @click="unlock">验证并查看</n-button>
      </section>
      <template v-else-if="payload?.content">
        <header class="shared-content-head"><div><span>{{payload.target_type==='mindmap'?'脑图':payload.target_type==='folder'?'图片文件夹':'图片'}}</span><h1>{{payload.title}}</h1><p>{{expiry(payload.expires_at)}} · 只读分享</p></div></header>
        <section v-if="payload.target_type==='image'||payload.target_type==='folder'" class="shared-gallery">
          <div v-if="payload.target_type==='folder'" class="shared-folder-summary"><span class="folder-symbol">▰</span><div><strong>{{payload.content.folder.name}}</strong><small>{{images.length}} 张图片</small></div></div>
          <div v-if="images.length" class="shared-image-grid">
            <article v-for="image in images" :key="image.id"><a :href="image.url" target="_blank"><img :src="image.url" loading="lazy" /></a><div><strong>{{image.name}}</strong><small>{{size(image.size)}} · {{image.created_at?.slice(0,10)}}</small><p v-if="image.caption">{{image.caption}}</p><small v-if="image.tags"># {{image.tags}}</small><a v-if="image.resource_url" :href="image.resource_url" target="_blank" rel="noopener">关联资料 ↗</a></div></article>
          </div>
          <div v-else class="share-state-card compact"><h2>文件夹为空</h2><p>分享者还没有放入图片。</p></div>
        </section>
        <section v-else class="shared-mindmap">
          <div class="shared-mindmap-meta"><div><b>{{payload.content.system.category}}</b><span>{{payload.content.nodes.length}} 个节点</span><span>{{payload.content.system.markets||'通用市场'}}</span><span>{{payload.content.system.timeframes||'通用周期'}}</span></div><p v-if="payload.content.system.description">{{payload.content.system.description}}</p><a v-if="payload.content.system.resource_url" :href="payload.content.system.resource_url" target="_blank" rel="noopener">查看关联视频 / 网盘资料 ↗</a></div>
          <div class="shared-flow"><VueFlow id="shared-mindmap" v-model:nodes="flowNodes" v-model:edges="flowEdges" :min-zoom="0.08" :max-zoom="1.8" :nodes-draggable="false" :nodes-connectable="false" :zoom-on-double-click="false"><Background pattern-color="#1c2735" :gap="22" /><template #node-share="slotProps"><article class="shared-flow-node" :class="`node-${slotProps.data.node_type}`"><small>{{slotProps.data.node_type}}</small><h3>{{slotProps.data.title}}</h3><p v-if="slotProps.data.content">{{slotProps.data.content}}</p><div v-if="slotProps.data.rule_title">规则 · {{slotProps.data.rule_title}}</div></article></template></VueFlow><div class="shared-flow-controls"><button title="放大" @click="zoomIn({duration:180})">＋</button><button title="缩小" @click="zoomOut({duration:180})">−</button><button title="保持文字清晰" @click="fitReadable">清晰</button><button title="查看整张脑图" @click="fitAll">全图</button></div><div class="flow-public-hint">拖动空白处平移 · 滚轮或双指缩放</div></div>
        </section>
      </template>
    </n-spin>
  </main>
</template>

<style scoped>
.shared-flow-controls{top:10px;bottom:auto}
@media(max-width:720px){.shared-flow-controls{top:8px;right:8px}.flow-public-hint{bottom:8px}}
</style>
