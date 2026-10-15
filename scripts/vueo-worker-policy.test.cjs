'use strict'
const {test}=require('node:test')
const assert=require('node:assert/strict')
const {createHash}=require('node:crypto')
const {buildAutoSubtitles,buildAutoSubtitle}=require('../src/subtitles.js')
const {decodeTranslationTokenData}=require('../src/token.js')
const media={type:'series',id:'tt12345:1:2'}
const text='WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHello\n'
function env(){ const data=new Map();return {SMARTSUBS_SECRET:'test-worker-source-contract-secret',SMARTSUBS_CACHE:{async get(k){return data.get(k)},async put(k,v){data.set(k,v)}}} }
function track(id,extra={}) {return {id,lang:'en',providerId:'plugin:repo:vidlink',providerName:'VidLink',url:`https://subs.example/${id}.vtt`,...extra}}
test('worker owns English selection, plugin priority, duplicates, addon switch and five limit',async()=>{
 const {selectVueoSources}=await import('../src/vueo-upstream.mjs')
 const addon=track('addon',{providerId:'opensubtitles',providerName:'OpenSubtitles v3'})
 const plugins=Array.from({length:6},(_,i)=>track(`p${i}`))
 const invalid=[track('malay',{lang:'ms'}),track('gemini-ai-old'),track('own',{providerId:'vueo-smartsubs-ai'}),track('ass',{url:'https://subs.example/a.ass'}),track('private',{url:'https://127.0.0.1/a.vtt'}),track('query-ass',{url:'https://subs.example/download?format=ass'})]
 const duplicate=track('dup',{url:plugins[0].url})
 assert.deepEqual(selectVueoSources({subtitles:[addon,...invalid,plugins[0],duplicate,...plugins.slice(1)]}),plugins.slice(0,5))
 assert.deepEqual(selectVueoSources({includeAddonSources:true,subtitles:[addon,plugins[0],track('duplicate-addon',{providerId:'addon',url:plugins[0].url})]}),[plugins[0],addon])
})
test('each returned AI track maps to its own filtered source independent of input position',async()=>{
 const {prepareVueoSources,canonicalVueoTranslationSource}=await import('../src/vueo-upstream.mjs')
 const store=env()
 const addon=track('addon:3:9877112',{providerId:'opensubtitles',providerName:'OpenSubtitles v3',text:text.replace('Hello','Hello from addon')});delete addon.url
 const plugin=track('repo:4:5806555684246378904',{text});delete plugin.url
 const prepared=await prepareVueoSources({media,includeAddonSources:true,subtitles:[addon,track('wrong',{lang:'ms'}),plugin]},store,'owner')
 // Distinct sources retain their labels after plugin-first ordering.
 const ai=buildAutoSubtitles(prepared.tracks,{publicBaseUrl:'https://worker.example/c/config',tokenSecret:'test-secret',media})
 assert.equal(ai[0].displayId,'VidLink - 5806555684246378904')
 assert.equal(ai[1].displayId,'OpenSubtitles v3 - 9877112')
 assert.equal(ai[0].sourceId,plugin.id)
 assert.equal(ai[1].sourceId,addon.id)
 for(let i=0;i<ai.length;i++){
  assert.equal(ai[i].providerName,'VUEO x SmartSubs');assert.equal(ai[i].name,'Malay AI');assert.equal(ai[i].mimeType,'text/vtt')
  const token=ai[i].url.match(/translated\/([^/]+)\.vtt$/)[1]
  const canonical=await canonicalVueoTranslationSource(decodeTranslationTokenData(token,'test-secret'),store,'owner')
  assert.equal(canonical.providerSubtitleId,ai[i].sourceId)
 }
})
test('metadata changes preserve legacy source hash and translation content cache',async()=>{
 const {prepareVueoSources,canonicalVueoTranslationSource}=await import('../src/vueo-upstream.mjs')
 const store=env(),source={lang:'eng',id:'repo:4:42',providerName:'VidLink',text}
 const expected=createHash('sha256').update(JSON.stringify({configId:'owner',media,source:{lang:'eng',text}})).digest('hex')
 const first=(await prepareVueoSources({media,subtitles:[source]},store,'owner')).tracks[0]
 assert.equal(first.id,expected)
 const canonical=await canonicalVueoTranslationSource({url:first.url,media},store,'owner')
 const second=(await prepareVueoSources({media,subtitles:[{...source,providerName:'Renamed',displayId:'visible-42'}]},store,'owner')).tracks[0]
 assert.equal(second.id,expected)
 assert.equal((await canonicalVueoTranslationSource({url:second.url,media},store,'owner')).cacheId,canonical.cacheId)
 assert.equal(second.sourceDisplayId,'visible-42')
})
test('legacy addon response also carries a ready display label without changing internal ID',()=>{
 const ai=buildAutoSubtitle({id:'9877112',lang:'eng',url:'https://subs.example/9877112.vtt'},{publicBaseUrl:'https://worker.example',tokenSecret:'test-secret'})
 assert.equal(ai.id,'gemini-ai-9877112');assert.equal(ai.displayId,'OpenSubtitles v3 - 9877112')
})
