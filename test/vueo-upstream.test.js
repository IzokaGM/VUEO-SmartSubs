'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { createUserConfigToken, decodeUserConfigToken, tokenFingerprint } = require('../src/user-config')
const { decodeTranslationTokenData } = require('../src/token')
const KEY = 'personal-gemini-test-key-123456789'
const TEXT = '1\n00:00:01,000 --> 00:00:02,000\nHow are you?\n'
function fixture() {
  const values = new Map(), sent = []
  const kv = { get: async key => values.get(key) ?? null, put: async (key,value) => values.set(key,value), list: async () => ({keys:[]}) }
  const env = { SMARTSUBS_SECRET: 'v2-existing-secret', SMARTSUBS_CACHE: kv, SMARTSUBS_TRANSLATION_QUEUE: { send: async value => sent.push(value) } }
  const token = createUserConfigToken(KEY, { secret: env.SMARTSUBS_SECRET, model:'gemini-test' })
  return { values, sent, env, token, base: `https://backend.example/c/${token}` }
}
const submit = (base, input) => new Request(base+'/subtitles', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(input) })

test('VUEO adapter keeps on-demand five-candidate selection and does not fetch OpenSubtitles or Gemini', async () => {
  const {handleRequest}=await import('../src/cloudflare-worker.mjs')
  const f=fixture(), original=global.fetch
  global.fetch=async()=>{throw new Error('Discovery must not fetch upstream or Gemini')}
  try {
    const res=await handleRequest(submit(f.base,{media:{type:'series',id:'tmdb:80539:1:1'},subtitles:Array.from({length:7},(_,i)=>({id:'en-'+i,lang:'en',text:TEXT+i}))}),f.env)
    assert.equal(res.status,200)
    const data=await res.json()
    assert.equal(data.subtitles.filter(x=>x.lang==='msa').length,5)
    assert.equal(data.subtitles.filter(x=>x.lang==='eng').length,5)
    assert.equal(data.autoPrefetch,false)
    assert.equal(f.sent.length,0)
    const stored=[...f.values.entries()].filter(([key])=>key.startsWith('vueo:source:'))
    assert.equal(stored.length,7)
    assert.ok(stored.every(([,value])=>!value.includes('How are you')))
    const raw=await handleRequest(new Request(data.subtitles.find(x=>x.lang==='eng').url),f.env)
    assert.equal(raw.status,200); assert.equal(await raw.text(),TEXT+'0')
    const foreign=createUserConfigToken('another-user-key-123456789',{secret:f.env.SMARTSUBS_SECRET})
    const denied=await handleRequest(new Request(data.subtitles.find(x=>x.lang==='eng').url.replace(f.token,foreign)),f.env)
    assert.equal(denied.status,422)
    const empty=await handleRequest(new Request(f.base+'/subtitles/series/tt123:1:1.json'),f.env)
    assert.deepEqual((await empty.json()).subtitles,[])
  } finally {global.fetch=original}
})

test('VUEO source uses the original Queue payload, profiles and cache delivery engine', async () => {
  const {handleRequest,enqueuePrefetchTranslation,processQueueMessage}=await import('../src/cloudflare-worker.mjs')
  const {cfGetOrTranslate}=await import('../src/cf-cache.mjs')
  const f=fixture()
  const data=await (await handleRequest(submit(f.base,{media:{type:'movie',id:'tmdb:10'},subtitles:[{lang:'en',text:TEXT}]}),f.env)).json()
  const auto=data.subtitles.find(x=>x.lang==='msa').url
  await enqueuePrefetchTranslation({autoUrl:auto,env:f.env,configToken:f.token,configId:tokenFingerprint(f.token),diagnosticFn:async()=>{},queueProfile:'user-selected-stable'})
  assert.equal(f.sent.length,1)
  assert.equal(f.sent[0].v,1)
  assert.equal(Object.hasOwn(f.sent[0],'apiKey'),false)
  let observed
  const original=global.fetch
  global.fetch=async(url,options)=>{
    assert.ok(String(url).startsWith('https://generativelanguage.googleapis.com/'))
    assert.equal(options.headers['x-goog-api-key'],KEY)
    return new Response(JSON.stringify({candidates:[{content:{parts:[{text:JSON.stringify({translations:['Apa khabar?']})}]}}]}),{headers:{'content-type':'application/json'}})
  }
  try {
    const result=await processQueueMessage(f.sent[0],f.env,{diagnosticFn:async()=>{},getOrTranslateFn:async options=>{observed=options;return cfGetOrTranslate(options)}})
    assert.ok(result)
    assert.equal(observed.translateOptions.concurrency,5)
    assert.equal(observed.translateContext.movieAdaptiveChunking,true)
    assert.equal(observed.translateContext.movieChunkItemsMin,160)
    assert.equal(observed.translateContext.movieChunkItemsMax,200)
    const translated=await handleRequest(new Request(auto),f.env)
    assert.equal(translated.status,200)
    const vtt=await translated.text()
    assert.match(vtt,/Apa khabar\?/); assert.match(vtt,/00:00:01.000 --> 00:00:02.000/)
  } finally {global.fetch=original}
})

test('JSON key entry creates the existing V2 encrypted config token with no session registry', async () => {
  const {handleRequest}=await import('../src/cloudflare-worker.mjs')
  const f=fixture(), original=global.fetch
  global.fetch=async(url,options)=>{
    assert.ok(String(url).includes(':generateContent'));assert.equal(options.headers['x-goog-api-key'],KEY)
    return new Response('{}',{status:200})
  }
  try {
    for(const path of ['/configure','/v1/session']) {
      const res=await handleRequest(new Request('https://backend.example'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({geminiApiKey:KEY})}),f.env)
      assert.equal(res.status,201)
      const data=await res.json()
      assert.equal(decodeUserConfigToken(data.token,{secret:f.env.SMARTSUBS_SECRET}).apiKey,KEY)
      assert.equal(data.token.includes(KEY),false)
      assert.equal(f.values.size,0)
    }
    const missing=await handleRequest(new Request('https://backend.example/v1/session',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}),{})
    assert.equal(missing.status,503)
  } finally {global.fetch=original}
})

test('provider URL headers stay encrypted and cross-origin redirects strip cookie/auth', async () => {
  const {prepareVueoSources,vueoUpstreamOptions}=await import('../src/vueo-upstream.mjs')
  const f=fixture()
  const prepared=await prepareVueoSources({media:{type:'series',id:'tmdb:80539:1:1'},subtitles:[{lang:'en',url:'https://provider.example/file',headers:{Cookie:'private-cookie',Authorization:'private-auth',Referer:'https://provider.example/'}}]},f.env,'owner')
  assert.ok([...f.values.values()].every(x=>!x.includes('private-cookie')&&!x.includes('private-auth')))
  const calls=[]
  const response=await vueoUpstreamOptions(f.env,prepared.tracks[0].url,async(url,options)=>{
    calls.push(options.headers)
    return calls.length===1?new Response(null,{status:302,headers:{location:'https://cdn.example/file'}}):new Response(TEXT)
  }).fetchImpl(prepared.tracks[0].url)
  assert.equal(await response.text(),TEXT)
  assert.equal(calls[0].cookie,'private-cookie');assert.equal(calls[1].cookie,undefined);assert.equal(calls[1].authorization,undefined)
  await assert.rejects(()=>prepareVueoSources({media:{type:'movie',id:'1'},subtitles:[{lang:'en',url:'https://127.0.0.1/file'}]},f.env,'owner'))
})

test('invalid payloads are rejected before source storage; infrastructure matches V2 bindings and limits',async()=>{
  const {prepareVueoSources}=await import('../src/vueo-upstream.mjs')
  const f=fixture()
  await assert.rejects(()=>prepareVueoSources({media:{type:'movie',id:'1'},subtitles:[{lang:'en',text:TEXT},{lang:'en',text:''}]},f.env,'owner'))
  assert.equal(f.values.size,0)
  const duplicateSources = await prepareVueoSources({media:{type:'movie',id:'1'},subtitles:[{id:'provider-a',lang:'en',text:TEXT},{id:'provider-b',lang:'en',text:TEXT}]},f.env,'owner')
  assert.equal(duplicateSources.tracks[0].url,duplicateSources.tracks[1].url)
  const cfg=JSON.parse(fs.readFileSync('wrangler.jsonc','utf8'))
  assert.equal(cfg.main,'src/cloudflare-worker.mjs')
  assert.equal(cfg.durable_objects.bindings[0].class_name,'TranslationDeliveryRelay')
  assert.equal(cfg.queues.producers[0].binding,'SMARTSUBS_TRANSLATION_QUEUE')
  assert.deepEqual(cfg.ratelimits.map(x=>x.simple.limit),[120,6])
  assert.equal(cfg.vars.QUEUE_USER_SELECTED_CONCURRENCY,'5')
  assert.equal(fs.existsSync('src/vueo-job-store.mjs'),false)
  assert.equal(fs.existsSync('scripts/provision.mjs'),false)
})
