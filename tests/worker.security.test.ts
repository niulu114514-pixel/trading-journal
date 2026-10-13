import { beforeEach, describe, expect, it } from 'vitest'
import { applyD1Migrations, env, SELF } from 'cloudflare:test'
import { base64ToArrayBuffer, hashSessionToken } from '../src/index'

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {
    CONFIG_ENCRYPTION_KEY: string
    SETUP_TOKEN: string
    TEST_MIGRATIONS: {name:string;queries:string[]}[]
  }
}

async function json(response:Response){return response.json() as Promise<Record<string,any>>}

beforeEach(async()=>{
  await applyD1Migrations(env.DB,env.TEST_MIGRATIONS)
  await env.DB.batch([
    env.DB.prepare('DELETE FROM share_unlock_attempts'),
    env.DB.prepare('DELETE FROM share_links'),
    env.DB.prepare('DELETE FROM images'),
    env.DB.prepare('DELETE FROM image_folders'),
    env.DB.prepare('DELETE FROM sessions'),
    env.DB.prepare('DELETE FROM login_attempts'),
    env.DB.prepare('DELETE FROM users')
  ])
})

describe('Worker security boundaries',()=>{
  it('uses strict same-origin API headers over HTTPS',async()=>{
    const response=await SELF.fetch('https://example.com/api/auth/status')
    expect(response.status).toBe(200)
    expect(response.headers.get('strict-transport-security')).toContain('max-age=31536000')
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
    expect(response.headers.get('x-request-id')).toBeTruthy()
    expect(response.headers.get('x-d1-bookmark')).toBeTruthy()
  })

  it('falls back safely when a client sends an invalid D1 bookmark',async()=>{
    const response=await SELF.fetch('https://example.com/api/auth/status',{headers:{'X-D1-Bookmark':'not-a-valid-bookmark'}})
    expect(response.status).toBe(200)
    expect(response.headers.get('x-d1-bookmark')).toBeTruthy()
  })

  it('rejects oversized inline images before decoding base64',()=>{
    const oversized='A'.repeat(Math.ceil((10*1024*1024+1)*4/3))
    expect(()=>base64ToArrayBuffer(oversized)).toThrow('图片不能超过 10MB')
  })

  it('requires the deployment setup token before creating the owner',async()=>{
    const rejected=await SELF.fetch('https://example.com/api/auth/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'strong-passphrase',setup_token:'wrong'})})
    expect(rejected.status).toBe(403)
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM users').first<{count:number}>()).toMatchObject({count:0})

    const accepted=await SELF.fetch('https://example.com/api/auth/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'strong-passphrase',setup_token:'test-setup-token'})})
    expect(accepted.status).toBe(201)
    expect(accepted.headers.get('set-cookie')).toContain('session=')
    expect(accepted.headers.get('x-d1-bookmark')).toBeTruthy()
    const rawToken=accepted.headers.get('set-cookie')?.match(/session=([^;]+)/)?.[1]||''
    const stored=await env.DB.prepare('SELECT token FROM sessions LIMIT 1').first<{token:string}>()
    expect(rawToken).toMatch(/^[a-f0-9]{64}$/)
    expect(stored?.token).toBe(await hashSessionToken(rawToken))
    expect(stored?.token).not.toContain(rawToken)
  })

  it('accepts a legacy plaintext session once and upgrades it transparently',async()=>{
    const setup=await SELF.fetch('https://example.com/api/auth/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'strong-passphrase',setup_token:'test-setup-token'})})
    const cookie=setup.headers.get('set-cookie')?.split(';')[0]||''
    const rawToken=cookie.slice('session='.length)
    await env.DB.prepare('UPDATE sessions SET token=?').bind(rawToken).run()

    const response=await SELF.fetch('https://example.com/api/auth/me',{headers:{Cookie:cookie}})
    expect(response.status).toBe(200)
    const stored=await env.DB.prepare('SELECT token FROM sessions LIMIT 1').first<{token:string}>()
    expect(stored?.token).toBe(await hashSessionToken(rawToken))
  })

  it('rate limits repeated public share password failures',async()=>{
    const setup=await SELF.fetch('https://example.com/api/auth/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'strong-passphrase',setup_token:'test-setup-token'})})
    const cookie=setup.headers.get('set-cookie')?.split(';')[0]||''
    const folder=await SELF.fetch('https://example.com/api/image-folders',{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify({name:'受保护文件夹',color:'#3ec9c5'})})
    const folderId=Number((await json(folder)).id)

    const weak=await SELF.fetch('https://example.com/api/shares',{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify({target_type:'folder',target_id:folderId,password:'1234'})})
    expect(weak.status).toBe(400)

    const created=await SELF.fetch('https://example.com/api/shares',{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify({target_type:'folder',target_id:folderId,password:'correct-password'})})
    const token=String((await json(created)).token)
    for(let attempt=0;attempt<8;attempt++){
      const failed=await SELF.fetch(`https://example.com/api/public/shares/${token}/unlock`,{method:'POST',headers:{'Content-Type':'application/json','CF-Connecting-IP':'203.0.113.8'},body:JSON.stringify({password:'wrong-password'})})
      expect(failed.status).toBe(403)
    }
    const limited=await SELF.fetch(`https://example.com/api/public/shares/${token}/unlock`,{method:'POST',headers:{'Content-Type':'application/json','CF-Connecting-IP':'203.0.113.8'},body:JSON.stringify({password:'wrong-password'})})
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBe('900')
  })
})
