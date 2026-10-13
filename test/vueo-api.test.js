'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const crypto = require('node:crypto')
const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHello.\n'
const translated = 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nApa khabar?\n'
const keyA = 'test-user-A-gemini-key-1234567890'
const keyB = 'test-user-B-gemini-key-1234567890'
async function fixture() {
  const worker = await import('../src/vueo-worker.mjs')
  const { VueoSmartSubsJob } = await import('../src/vueo-job-store.mjs')
  const values = new Map(), queue = [], stores = new Map()
  const config = JSON.parse(fs.readFileSync('wrangler.jsonc','utf8'))
  const env = { ...config.vars, VUEO_SMARTSUBS_SECRET: 'test-backend-encryption-secret-0123456789', VUEO_UPSTREAM_HOSTS: 'subtitles.example.com,cdn.example.com' }
  env.SMARTSUBS_CACHE = {
    async get(id, options) { const v = values.get(id); return v == null ? null : options?.type === 'json' ? JSON.parse(v) : v },
    async put(id,value) { values.set(id,value) }, async delete(id) { values.delete(id) }
  }
  env.VUEO_TRANSLATION_QUEUE = { async send(body) { queue.push(body) } }
  env.VUEO_JOBS = {
    idFromName(name) { return name },
    get(id) {
      if (!stores.has(id)) {
        const data = new Map(); let locked = Promise.resolve()
        const state = {
          storage: { async get(k) { return structuredClone(data.get(k)) }, async put(k,v) { data.set(k,structuredClone(v)) }, async setAlarm() {}, async deleteAll() { data.clear() } },
          blockConcurrencyWhile(fn) { const pending = locked.then(fn); locked = pending.catch(() => {}); return pending }
        }
        stores.set(id,{ data, object: new VueoSmartSubsJob(state,env) })
      }
      return { fetch(url, init) { return stores.get(id).object.fetch(new Request(url,init)) } }
    }
  }
  const fetchOK = async () => Response.json({ candidates: [{ content: { parts: [{ text: 'OK' }] } }] })
  async function req(path, method='GET', body, token, options={}) {
    return worker.handleVueoRequest(new Request(`https://vueo.example${path}`, { method, headers: { ...(body ? {'content-type':'application/json'} : {}), ...(token ? {authorization:`Bearer ${token}`} : {}) }, ...(body ? {body:JSON.stringify(body)} : {}) }), env, { fetchImpl: fetchOK, ...options })
  }
  async function login(key=keyA) { const res=await req('/v1/session','POST',{geminiApiKey:key}); assert.equal(res.status,201); return (await res.json()).token }
  async function submit(token, source={text:vtt}, extra={}) { return req('/v1/jobs','POST',{sourceLanguage:'en',targetLanguage:'ms',media:{type:'series',id:'80539:1:1'},source,...extra},token) }
  async function consume(body=queue[0], options={}, attempts=1) {
    const outcome={}; await worker.consumeVueoMessage({body,attempts,ack(){outcome.ack=true},retry(value){outcome.retry=value}},env,{translateFn:async()=>translated,...options}); return outcome
  }
  return {env,values,queue,stores,req,login,submit,consume,worker}
}

test('VUEO upload → queue → authenticated status → signed VTT; key and headers are encrypted', async () => {
  const f=await fixture(),token=await f.login()
  const submitted=await f.submit(token); assert.equal(submitted.status,202)
  const job=await submitted.json(); assert.equal(job.status,'queued'); assert.equal(f.queue.length,1)
  assert(!JSON.stringify(f.queue).includes(keyA))
  assert(!JSON.stringify([...f.stores.get(job.jobId).data.values()]).includes(keyA))
  assert(!JSON.stringify([...f.stores.get(job.jobId).data.values()]).includes('Hello.'))
  let seenKey
  assert.equal((await f.consume(f.queue[0],{translateFn:async(url,opts)=>{seenKey=opts.apiKey;return translated}})).ack,true)
  assert.equal(seenKey,keyA)
  const ready=await (await f.req(`/v1/jobs/${job.jobId}`,'GET',null,token)).json()
  assert.equal(ready.status,'ready'); assert.equal(ready.language,'ms'); assert.equal(ready.pollAfterMs,0)
  const result=await f.req(new URL(ready.resultUrl).pathname+new URL(ready.resultUrl).search)
  assert.equal(result.status,200); assert.equal(await result.text(),translated)
  assert.equal(result.headers.get('content-type'),'text/vtt; charset=utf-8')
  assert(!ready.resultUrl.includes(keyA))
  assert(!f.stores.get(job.jobId).data.get('job').sealedInput)
})
test('different users cannot read each other jobs and never share key/cache identity', async () => {
  const f=await fixture(),a=await f.login(keyA),b=await f.login(keyB)
  const jA=await (await f.submit(a)).json(),jB=await (await f.submit(b)).json()
  assert.notEqual(jA.jobId,jB.jobId)
  assert.equal((await f.req(`/v1/jobs/${jA.jobId}`,'GET',null,b)).status,403)
  const used=[]
  for(const body of f.queue) await f.consume(body,{translateFn:async(_,opts)=>{used.push(opts.apiKey);return translated}})
  assert.deepEqual(used,[keyA,keyB])
})
test('simultaneous duplicate submissions enqueue once, and completed job reuses result', async () => {
  const f=await fixture(),token=await f.login()
  const results=await Promise.all(Array.from({length:5},()=>f.submit(token)))
  const jobs=await Promise.all(results.map(r=>r.json()))
  assert.equal(new Set(jobs.map(j=>j.jobId)).size,1); assert.equal(f.queue.length,1)
  await f.consume()
  const cached=await f.submit(token);assert.equal(cached.status,200); assert.equal((await cached.json()).status,'ready');assert.equal(f.queue.length,1)
})
test('failed queue enqueue is explicit and a new submit can recover',async()=>{
  const f=await fixture(),token=await f.login();const send=f.env.VUEO_TRANSLATION_QUEUE.send
  f.env.VUEO_TRANSLATION_QUEUE.send=async()=>{throw new Error('private upstream data')}
  const first=await f.submit(token);assert.equal(first.status,503);assert.equal((await first.json()).error.code,'QUEUE_UNAVAILABLE')
  f.env.VUEO_TRANSLATION_QUEUE.send=send
  const retry=await f.submit(token);assert.equal(retry.status,202);assert.equal(f.queue.length,1)
})
test('Gemini 429 produces bounded retry, then returns a result with the same user key',async()=>{
  const f=await fixture(),token=await f.login(),job=await (await f.submit(token)).json()
  const first=await f.consume(f.queue[0],{translateFn:async()=>{throw new Error('Gemini HTTP 429')}})
  assert.equal(first.retry.delaySeconds,30)
  assert.equal((await (await f.req(`/v1/jobs/${job.jobId}`,'GET',null,token)).json()).status,'queued')
  assert.equal((await f.consume(f.queue[0],{},2)).ack,true)
  assert.equal((await (await f.req(`/v1/jobs/${job.jobId}`,'GET',null,token)).json()).status,'ready')
})
test('invalid cues/denied Gemini key stop without retry or raw-error leakage',async()=>{
  const f=await fixture(),token=await f.login(),job=await (await f.submit(token)).json()
  const outcome=await f.consume(f.queue[0],{translateFn:async()=>{throw new Error(`Gemini HTTP 403 sensitive=${keyA}`)}})
  assert.equal(outcome.ack,true);assert(!outcome.retry)
  const failed=await (await f.req(`/v1/jobs/${job.jobId}`,'GET',null,token)).json()
  assert.equal(failed.status,'failed');assert.equal(failed.error.code,'GEMINI_HTTP_403');assert(!JSON.stringify(failed).includes(keyA))
})
test('tampered/expired session and result tickets are rejected; old addon routes are unavailable',async()=>{
  const f=await fixture(),token=await f.login()
  assert.equal((await f.submit(token.slice(0,-1)+'!')).status,401)
  const security=await import('../src/vueo-security.mjs')
  const expired=security.seal({kind:'session',apiKey:keyA,user:'a'.repeat(64),exp:1},f.env)
  assert.equal((await f.submit(expired)).status,401)
  assert.equal((await f.req('/v1/jobs/'+'a'.repeat(64)+'/result.vtt?ticket=123.invalid')).status,401)
  assert.equal((await f.req('/manifest.json')).status,404)
})
test('source language, empty/large text, source shape and header rules are enforced',async()=>{
  const f=await fixture(),token=await f.login()
  assert.equal((await f.submit(token,{text:vtt},{sourceLanguage:'ja'})).status,400)
  assert.equal((await f.submit(token,{text:vtt,url:'https://subtitles.example.com/a'})).status,400)
  assert.equal((await f.submit(token,{text:''})).status,413)
  assert.equal((await f.submit(token,{text:'a'.repeat(1024*1024+1)})).status,413)
  assert.equal((await f.submit(token,{url:'https://subtitles.example.com/a',headers:{Host:'private'}})).status,400)
  assert.equal((await f.submit(token,{url:'https://subtitles.example.com/a',headers:{Cookie:'a\r\nb'}})).status,400)
})
test('rate limit returns 429 before creating a queued job',async()=>{
  const f=await fixture(),token=await f.login();f.env.SMARTSUBS_GENERATE_LIMITER={async limit(){return {success:false}}}
  assert.equal((await f.submit(token)).status,429);assert.equal(f.queue.length,0)
})
test('source URL/redirect validation and per-source auth headers apply before download',async()=>{
  const {normalizeSource,fetchSource}=await import('../src/vueo-security.mjs')
  const f=await fixture()
  for(const url of ['http://subtitles.example.com/a','https://127.0.0.1/a','https://localhost/a','https://[::1]/a','https://not-approved.example.com/a','https://subtitles.example.com:8443/a'])assert.throws(()=>normalizeSource({url},f.env))
  const requests=[]
  const source=normalizeSource({url:'https://subtitles.example.com/a',headers:{Authorization:'private-token',Cookie:'session=secret',Referer:'https://subtitles.example.com/'}},f.env)
  const text=await fetchSource(source,f.env,async(url,init)=>{
    requests.push({url,headers:init.headers})
    return requests.length===1?new Response(null,{status:302,headers:{location:'https://cdn.example.com/b'}}):new Response(vtt)
  })
  assert.equal(text,vtt);assert.equal(requests[0].headers.authorization,'private-token');assert(!requests[1].headers.authorization);assert(!requests[1].headers.cookie)
  await assert.rejects(()=>fetchSource(source,f.env,async()=>new Response(null,{status:302,headers:{location:'https://127.0.0.1/a'}})))
})
test('large streamed source and excessive/failed redirects are rejected without translation',async()=>{
  const {fetchSource}=await import('../src/vueo-security.mjs');const f=await fixture(),source={url:'https://subtitles.example.com/a',headers:{}}
  await assert.rejects(()=>fetchSource(source,f.env,async()=>new Response('x'.repeat(1024*1024+1))))
  await assert.rejects(()=>fetchSource(source,f.env,async()=>new Response(null,{status:302,headers:{location:'/b'}})))
  await assert.rejects(()=>fetchSource(source,f.env,async()=>new Response('denied',{status:403})),/HTTP 403/)
})
test('ASS adapter preserves timestamps, commas and multiline dialogue; original translator is byte-identical',async()=>{
  const {prepareSourceText}=await import('../src/vueo-source.mjs')
  const ass='[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.23,0:00:03.45,Default,,0,0,0,,Hello, friend.\\NNext line.'
  const result=prepareSourceText(ass)
  assert.match(result,/00:00:01.230 --> 00:00:03.450/);assert.match(result,/Hello, friend.\nNext line./)
  assert.equal(prepareSourceText(vtt),vtt)
  const baseline=JSON.parse(fs.readFileSync('ENGINE_BASELINE.json','utf8'))
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync('src/translator.js')).digest('hex'),baseline.translatorSha256)
})
test('real retained translator completes through mocked Gemini, preserving timing and Malay VTT output',async()=>{
  const f=await fixture(),token=await f.login(),job=await (await f.submit(token)).json()
  const captured=[]
  const outcome=await f.consume(f.queue[0],{translateFn:undefined,fetchImpl:async(url,init)=>{
    assert.match(String(url),/generativelanguage.googleapis.com/)
    captured.push(init.headers['x-goog-api-key'])
    return Response.json({candidates:[{content:{parts:[{text:JSON.stringify({translations:['Apa khabar?']})}]},finishReason:'STOP'}]})
  }})
  assert.equal(outcome.ack,true);assert.deepEqual(captured,[keyA])
  const ready=await (await f.req(`/v1/jobs/${job.jobId}`,'GET',null,token)).json()
  assert.equal(ready.status,'ready')
  const res=await f.req(new URL(ready.resultUrl).pathname+new URL(ready.resultUrl).search)
  const text=await res.text();assert.match(text,/00:00:01.000 --> 00:00:03.000/);assert.match(text,/Apa khabar\?/)
})
