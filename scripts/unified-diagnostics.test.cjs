const {test}=require('node:test')
const assert=require('node:assert/strict')
const {createUserConfigToken}=require('../src/user-config.js')
test('same API key shares timeline and controls; other key stays isolated',async()=>{
 const {handleRequest}=await import('../src/cloudflare-worker.mjs')
 const secret='unified-diagnostic-test-only',entries=new Map(),states=new Map()
 const kv={async get(k,o){const v=entries.get(k);return v==null?null:o?.type==='json'?JSON.parse(v):v},async put(k,v){entries.set(k,v)},async delete(k){entries.delete(k)},async list({prefix}){return {keys:[...entries.keys()].filter(k=>k.startsWith(prefix)).map(name=>({name}))}}}
 const env={SMARTSUBS_SECRET:secret,SMARTSUBS_CACHE:kv,SMARTSUBS_DIAG_ADMIN_KEY:'test-admin',SMARTSUBS_DELIVERY:{idFromName:n=>n,get:id=>({fetch:async(url,opts)=>{
  const state=states.get(id)||{enabled:true,since:0}
  if(opts?.method==='POST'){
   if(String(url).endsWith('/clear'))state.since=Date.now()+1
   else Object.assign(state,JSON.parse(opts.body))
   states.set(id,state)
  }
  return new Response(JSON.stringify(state))
 }})}}
 const a=createUserConfigToken('same-key',{secret}),b=createUserConfigToken('same-key',{secret}),c=createUserConfigToken('different-key',{secret})
 const base=t=>`https://worker.example/c/${t}`
 const request=async(t,device)=>handleRequest(new Request(base(t)+'/subtitles',{method:'POST',headers:{'content-type':'application/json','X-Vueo-Platform':device},body:JSON.stringify({media:{type:'series',id:'tt12345:1:1'},subtitles:[{id:'source',lang:'eng',text:'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello\n'}]})}),env)
 assert.equal((await request(a,'TV')).status,200);assert.equal((await request(b,'Mobile')).status,200)
 const pa=await (await handleRequest(new Request(base(a)+'/diagnose'),env)).text()
 const pb=await (await handleRequest(new Request(base(b)+'/diagnose'),env)).text()
 assert.match(pa,/TV/);assert.match(pa,/Mobile/);assert.match(pb,/TV/);assert.match(pb,/Mobile/)
 const pc=await (await handleRequest(new Request(base(c)+'/diagnose'),env)).text()
 assert.ok(!pc.includes('"device":"TV"'))
 const events=[...entries].filter(([k])=>k.startsWith('diag:')).map(([,v])=>JSON.parse(v))
 assert.ok(events.some(e=>e.device==='TV'));assert.ok(events.some(e=>e.device==='Mobile'))
 const prefix=new Set([...entries.keys()].filter(k=>k.startsWith('diag:')).map(k=>k.split(':')[2]));assert.equal(prefix.size,1)
 const off=await handleRequest(new Request(base(a)+'/diagnose/toggle',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'action=off'}),env)
 assert.equal(off.status,303)
 const before=entries.size;await request(b,'Mobile');assert.equal(entries.size,before)
})
