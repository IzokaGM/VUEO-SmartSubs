'use strict'
const {test} = require('node:test')
const assert = require('node:assert/strict')
const {createUserConfigToken, tokenFingerprint} = require('../src/user-config.js')
const {createTranslationToken} = require('../src/token.js')
const text = 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHello\n'
const secret = 'content-cache-test-secret-not-production'
const media = {type:'series', id:'tt7441658:2:1'}
function environment() {
 const entries = new Map()
 return {SMARTSUBS_SECRET:secret, SMARTSUBS_CACHE:{
  async get(key, options) {const value=entries.get(key);return value == null ? null : options?.type==='json' ? JSON.parse(value) : value},
  async put(key,value) {entries.set(key,value)}, async delete(key){entries.delete(key)}
 }}
}
async function source(input, env, owner='owner', content=text) {
 const {prepareVueoSources,canonicalVueoTranslationSource}=await import('../src/vueo-upstream.mjs')
 const prepared=await prepareVueoSources({media,subtitles:[{id:'display',lang:'eng',...input}]},env,owner)
 const track=prepared.tracks[0]
 return canonicalVueoTranslationSource({url:track.url,sourceId:track.id,cacheId:track.id,media},env,owner,
  async()=>new Response(content))
}
test('signed URLs headers and upload transport converge on one content identity',async()=>{
 const env=environment()
 const first=await source({url:'https://subs.example/a?token=one',headers:{cookie:'a=1'}},env)
 const next=await source({url:'https://subs.example/b?token=two',headers:{cookie:'a=2'}},env)
 const uploaded=await source({text:'\uFEFF'+text.replace(/\n/g,'\r\n')},env)
 assert.equal(first.cacheId,next.cacheId);assert.equal(first.cacheId,uploaded.cacheId)
 const {vueoUpstreamOptions}=await import('../src/vueo-upstream.mjs')
 const response=await vueoUpstreamOptions(env,first.url,()=>{throw Error('must use frozen text')},'owner').fetchImpl(first.url)
 assert.equal(await response.text(),text)
})
test('timing and text differences remain separate cache entries',async()=>{
 const env=environment(), original=await source({text},env)
 assert.notEqual(original.cacheId,(await source({text:text.replace('01.000','02.000')},env)).cacheId)
 assert.notEqual(original.cacheId,(await source({text:text.replace('Hello','Different')},env)).cacheId)
})
test('canonical source cannot be read by a different owner',async()=>{
 const env=environment(), original=await source({text},env)
 const {canonicalVueoTranslationSource}=await import('../src/vueo-upstream.mjs')
 await assert.rejects(canonicalVueoTranslationSource(original,env,'other'),/does not belong/)
})
test('non-VUEO addon token is unchanged',async()=>{
 const {canonicalVueoTranslationSource}=await import('../src/vueo-upstream.mjs')
 const input={url:'https://opensubtitles.example/123',cacheId:'123'}
 assert.equal(await canonicalVueoTranslationSource(input,{},'owner'),input)
})
test('reopened signed URL serves persistent cache without Gemini or Queue',async()=>{
 const env=environment(), model='gemini-3.5-flash-lite'
 const config=createUserConfigToken('test-api-key',{secret,model}),owner=tokenFingerprint(config)
 const canonical=await source({text},env,owner)
 const {CloudflareTranslationCache,makeCacheKey}=await import('../src/cf-cache.mjs')
 const cachedVtt=text.replace('Hello','Helo')
 await new CloudflareTranslationCache({kv:env.SMARTSUBS_CACHE}).set(makeCacheKey(canonical.url,model,'m8-v1',canonical.cacheId),cachedVtt)
 const {prepareVueoSources}=await import('../src/vueo-upstream.mjs')
 const track=(await prepareVueoSources({media,subtitles:[{lang:'eng',url:'https://subs.example/new?token=changed'}]},env,owner)).tracks[0]
 const token=createTranslationToken(track.url,secret,track.id,media)
 const previous=global.fetch;let downloads=0
 global.fetch=async url=>{assert.equal(String(url),'https://subs.example/new?token=changed');downloads++;return new Response(text)}
 env.SMARTSUBS_TRANSLATION_QUEUE={send(){throw Error('cache hit must not enqueue')}}
 try {
  const {handleRequest}=await import('../src/cloudflare-worker.mjs')
  const response=await handleRequest(new Request(`https://worker.example/c/${config}/translated/${token}.vtt`),env)
  assert.equal(response.status,200);assert.equal(await response.text(),cachedVtt);assert.equal(downloads,1)
 } finally {global.fetch=previous}
})
test('Queue receives canonical token and uses the same cache key as the player',async()=>{
 const env=environment(), model='gemini-3.5-flash-lite'
 const config=createUserConfigToken('test-api-key',{secret,model}),owner=tokenFingerprint(config)
 const {prepareVueoSources,vueoUpstreamOptions}=await import('../src/vueo-upstream.mjs')
 const {decodeTranslationTokenData}=require('../src/token.js')
 const {CloudflareTranslationCache,makeCacheKey}=await import('../src/cf-cache.mjs')
 const track=(await prepareVueoSources({media,subtitles:[{lang:'eng',text}]},env,owner)).tracks[0]
 const token=createTranslationToken(track.url,secret,track.id,media)
 let queued=0
 env.SMARTSUBS_TRANSLATION_QUEUE={async send(body){
  queued++
  const data=decodeTranslationTokenData(body.translationToken,secret)
  assert.notEqual(data.sourceId,track.id)
  assert.equal(body.cacheKey,makeCacheKey(data.url,model,'m8-v1',data.cacheId))
  const frozen=await vueoUpstreamOptions(env,data.url,()=>{throw Error('no upstream download in Queue')},owner).fetchImpl(data.url)
  assert.equal(await frozen.text(),text)
  // Emulate completed Queue output before the player's first join poll.
  await new CloudflareTranslationCache({kv:env.SMARTSUBS_CACHE}).set(body.cacheKey,text.replace('Hello','Helo'))
 }}
 const {handleRequest}=await import('../src/cloudflare-worker.mjs')
 const response=await handleRequest(new Request(`https://worker.example/c/${config}/translated/${token}.vtt`),env)
 assert.equal(response.status,200);assert.equal(queued,1)
 assert.equal(await response.text(),text.replace('Hello','Helo'))
})
