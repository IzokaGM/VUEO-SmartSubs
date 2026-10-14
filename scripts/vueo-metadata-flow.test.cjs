'use strict'
const {test}=require('node:test')
const assert=require('node:assert/strict')
const {createUserConfigToken,tokenFingerprint}=require('../src/user-config.js')

async function checkFlow(legacySource = false) {
 const {handleRequest}=await import('../src/cloudflare-worker.mjs')
 const {canonicalVueoTranslationSource}=await import('../src/vueo-upstream.mjs')
 const {decodeTranslationTokenData}=require('../src/token.js')
 const {CloudflareTranslationCache,makeCacheKey}=await import('../src/cf-cache.mjs')
 const entries=new Map(),secret='metadata-full-flow-test-only-secret',model='gemini-3.5-flash-lite'
 const config=createUserConfigToken('test-key',{secret,model}),owner=tokenFingerprint(config)
 const kv={async get(k,o){const v=entries.get(k);return v==null?null:o?.type==='json'?JSON.parse(v):v},async put(k,v){entries.set(k,v)},async delete(k){entries.delete(k)},async list({prefix}){return {keys:[...entries.keys()].filter(k=>k.startsWith(prefix)).map(name=>({name}))}}}
 const env={SMARTSUBS_SECRET:secret,SMARTSUBS_CACHE:kv,SMARTSUBS_DIAG_ADMIN_KEY:'test-admin',SMARTSUBS_DELIVERY:{idFromName:n=>n,get:()=>({fetch:async url=>String(url).endsWith('/diagnostics/state')?new Response(JSON.stringify({enabled:true,since:0})):new Response(null,{status:404})})}}
 const base=`https://worker.example/c/${config}`
 const text='WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHello\n'
 const listing=await handleRequest(new Request(base+'/subtitles',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({media:{type:'series',id:'tt7441658:2:1'},subtitles:[{id:'original-provider-sub-42',...(legacySource ? {} : {providerName:'AnimeDunya'}),lang:'eng',text}]})}),env)
 assert.equal(listing.status,200)
 const ai=(await listing.json()).subtitles.find(t=>t.id.startsWith('gemini-ai-'))
 const token=ai.url.match(/translated\/([^/]+)\.vtt$/)[1]
 const data=await canonicalVueoTranslationSource(decodeTranslationTokenData(token,secret),env,owner)
 await new CloudflareTranslationCache({kv}).set(makeCacheKey(data.url,model,'m8-v1',data.cacheId),text.replace('Hello','Helo'))
 const translated=await handleRequest(new Request(ai.url, legacySource ? {headers:{'X-Vueo-Provider-Name':'AnimeDunya','X-Vueo-Subtitle-Id':'original-provider-sub-42'}} : {}),env)
 assert.equal(translated.status,200)
 const event=[...entries.entries()].filter(([k])=>k.startsWith('diag:')).map(([,v])=>JSON.parse(v)).find(v=>v.event==='translation-request')
 assert.equal(event.providerSubtitleId,'original-provider-sub-42');assert.equal(event.providerName,'AnimeDunya')
 const page=await handleRequest(new Request(base+'/diagnose'),env)
 const html=await page.text()
 assert.ok(html.includes('Source original-provider-sub-42 · AnimeDunya'))
 assert.ok(!html.split('<h2>Overview')[0].split('<div class="hero-state">').pop().includes('Source '+data.sourceId+'</'))
 assert.match(html,/English source<\/div><div class="value">original-provider-sub-42<\/div><div class="sub">AnimeDunya<\/div>/)
}
test('app POST through cached GET persists provider metadata into Diagnose',()=>checkFlow())
test('selected GET metadata repairs missing legacy source name on cache hit',()=>checkFlow(true))
