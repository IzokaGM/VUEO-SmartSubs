'use strict'
const {test}=require('node:test')
const assert=require('node:assert/strict')
const {sanitiseEvent}=require('../src/diagnostics.js')

test('source display metadata survives diagnostics and is escaped in the overview',async()=>{
 const {renderConfiguredDiagnosePage}=await import('../src/cloudflare-worker.mjs')
 const event=sanitiseEvent({ts:2,event:'translation-request',status:'player',sourceId:'internal-hash',providerSubtitleId:'original-42',providerName:'Anime<Provider>'})
 assert.equal(event.providerSubtitleId,'original-42')
 const html=renderConfiguredDiagnosePage('owner',[{ts:1,event:'subtitle-result',subtitleCount:2},event])
 assert.match(html,/<h1>VUEO x SmartSubs<\/h1>/)
 assert.match(html,/English source<\/div><div class="value">original-42<\/div><div class="sub">Anime&lt;Provider&gt;<\/div>/)
 assert.ok(!html.includes('SmartSubsV2 Diagnose'))
})
test('legacy logs do not invent provider metadata or display hash in English source card',async()=>{
 const {renderConfiguredDiagnosePage}=await import('../src/cloudflare-worker.mjs')
 const html=renderConfiguredDiagnosePage('owner',[{ts:1,event:'subtitle-result'},{ts:2,event:'translation-request',status:'player',sourceId:'internal-hash'}])
 assert.match(html,/English source<\/div><div class="value">Not available<\/div><div class="sub">Provider not available<\/div>/)
})
test('provider metadata survives source resolution without changing content identity',async()=>{
 const {prepareVueoSources,canonicalVueoTranslationSource}=await import('../src/vueo-upstream.mjs')
 const entries=new Map(),env={SMARTSUBS_SECRET:'test-only-source-metadata-secret',SMARTSUBS_CACHE:{async put(k,v){entries.set(k,v)},async get(k){return entries.get(k)}}}
 const media={type:'series',id:'tt7441658:2:1'}
 const subtitle={id:'original-42',lang:'eng',providerName:'AnimeDunya',text:'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHello\n'}
 async function resolve(input){
  const t=(await prepareVueoSources({media,subtitles:[input]},env,'owner')).tracks[0]
  return {raw:t.id,canonical:await canonicalVueoTranslationSource({url:t.url,media},env,'owner')}
 }
 const first=await resolve(subtitle),second=await resolve({...subtitle,providerName:'Renamed Provider'})
 assert.equal(first.raw,second.raw)
 assert.equal(first.canonical.cacheId,second.canonical.cacheId)
 assert.equal(first.canonical.providerSubtitleId,'original-42')
 assert.equal(first.canonical.providerName,'AnimeDunya')
})

test('event summaries use provider metadata for matching sources and keep internal ids in Raw',async()=>{
 const {renderConfiguredDiagnosePage}=await import('../src/cloudflare-worker.mjs')
 const html=renderConfiguredDiagnosePage('owner',[
  {ts:1,event:'translation-request',sourceId:'internal-one',providerName:'Hi<Anime>',providerSubtitleId:'stream-en-42'},
  {ts:2,event:'translation-delivered',sourceId:'internal-one',cache:'HIT',totalMs:957},
  {ts:3,event:'queue-enqueued',sourceId:'unrelated-hash'}
 ])
 assert.ok(!html.includes('OpenSubtitles source'))
 assert.match(html,/Hi&lt;Anime&gt; · stream-en-42 · Cache HIT · 957 ms/)
 assert.match(html,/class="event-summary">Subtitle source<\/div>/)
 assert.ok(!/class="event-summary">[^<]*(internal-one|unrelated-hash)/.test(html))
 assert.match(html,/<b>sourceId<\/b>=internal-one/)
})
