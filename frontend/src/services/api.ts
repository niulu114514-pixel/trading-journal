export class ApiError extends Error {
  constructor(message: string, public status: number, public data?: unknown) {
    super(message)
  }
}

const D1_BOOKMARK_KEY='trading-journal:d1-bookmark'
let memoryBookmark=''

function readD1Bookmark():string{
  if(memoryBookmark)return memoryBookmark
  try{memoryBookmark=sessionStorage.getItem(D1_BOOKMARK_KEY)||''}catch{/* 禁用存储时仅保存在内存。 */}
  return memoryBookmark
}

function saveD1Bookmark(value:unknown){
  const bookmark=String(value||'').trim()
  if(!bookmark||bookmark.length>2048)return
  memoryBookmark=bookmark
  try{sessionStorage.setItem(D1_BOOKMARK_KEY,bookmark)}catch{/* 禁用存储时仅保存在内存。 */}
}

function attachD1Bookmark(headers:Headers){const bookmark=readD1Bookmark();if(bookmark)headers.set('X-D1-Bookmark',bookmark)}
function captureD1Bookmark(response:Response){saveD1Bookmark(response.headers.get('X-D1-Bookmark'))}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  if (init.body && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json')
  attachD1Bookmark(headers)
  const response = await fetch(`/api${path}`, { ...init, headers })
  captureD1Bookmark(response)
  const contentType = response.headers.get('content-type') || ''
  const data = contentType.includes('application/json') ? await response.json() : await response.text()
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new CustomEvent('auth:expired'))
    throw new ApiError(data?.error || data?.message || `请求失败 (${response.status})`, response.status, data)
  }
  return data as T
}

export async function streamEvents(path:string,data:unknown,onEvent:(event:string,data:any)=>void,signal?:AbortSignal):Promise<void>{
  const headers=new Headers({'Content-Type':'application/json','Accept':'text/event-stream'})
  attachD1Bookmark(headers)
  const response=await fetch(`/api${path}`,{method:'POST',headers,body:JSON.stringify(data),signal})
  captureD1Bookmark(response)
  if(!response.ok){
    const payload=await response.json().catch(()=>({}))
    if(response.status===401)window.dispatchEvent(new CustomEvent('auth:expired'))
    throw new ApiError(payload?.error||payload?.message||`请求失败 (${response.status})`,response.status,payload)
  }
  if(!response.body)throw new ApiError('浏览器不支持流式响应',500)
  const reader=response.body.getReader(),decoder=new TextDecoder()
  let buffer=''
  while(true){
    const {done,value}=await reader.read()
    if(done)break
    buffer+=decoder.decode(value,{stream:true})
    const blocks=buffer.split(/\r?\n\r?\n/);buffer=blocks.pop()||''
    for(const block of blocks){
      let event='message',payload=''
      for(const line of block.split(/\r?\n/)){
        if(line.startsWith('event:'))event=line.slice(6).trim()
        else if(line.startsWith('data:'))payload+=line.slice(5).trim()
      }
      if(payload){
        try{const parsed=JSON.parse(payload);if(event==='bookmark')saveD1Bookmark(parsed?.bookmark);onEvent(event,parsed)}
        catch{onEvent(event,payload)}
      }
    }
  }
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, data?: unknown) => request<T>(path, { method: 'POST', body: data === undefined ? undefined : JSON.stringify(data) }),
  put: <T>(path: string, data?: unknown) => request<T>(path, { method: 'PUT', body: data === undefined ? undefined : JSON.stringify(data) }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
  upload: <T>(path: string, form: FormData) => request<T>(path, { method: 'POST', body: form })
}
