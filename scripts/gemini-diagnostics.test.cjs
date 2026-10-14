'use strict'
const {test} = require('node:test')
const assert = require('node:assert/strict')
const {Script} = require('node:vm')
const {createHash} = require('node:crypto')
const {validateGeminiApiKey} = require('../src/configure.js')
const {geminiRequestContext, renderGeminiDiagnostics} = require('../src/gemini-diagnostics.js')
const key = 'test-key-only-not-a-real-secret-1234'
const reject = (status, apiStatus, message) => async () => new Response(JSON.stringify({error: {status:apiStatus, message}}),{status})

test('regional rejection keeps existing app code and adds specific reason', async () => {
 await assert.rejects(validateGeminiApiKey(key,{fetchImpl:reject(400,'FAILED_PRECONDITION','User location is not supported for the API use.')}), e => {
  assert.equal(e.code,'GEMINI_PRECONDITION_FAILED'); assert.equal(e.reason,'GEMINI_LOCATION_UNSUPPORTED')
  assert.equal(e.upstreamStatus,400); assert.match(e.message,/location/);return true
 })
})
test('other prerequisite failures are not mislabeled as regional', async () => {
 await assert.rejects(validateGeminiApiKey(key,{fetchImpl:reject(400,'FAILED_PRECONDITION','Enable billing for this project.')}),e => {
  assert.equal(e.reason,'GEMINI_PRECONDITION_FAILED');return true
 })
})
test('Google explanatory details redact credentials and URLs', async () => {
 await assert.rejects(validateGeminiApiKey(key,{fetchImpl:reject(400,'FAILED_PRECONDITION',`User location is not supported ${key} https://example.com/private`)}),e => {
  assert.ok(!e.detail.includes(key));assert.ok(!e.detail.includes('https://'));return true
 })
})
test('request context does not guess egress and validates incoming fields', () => {
 const req = new Request('https://example.com');Object.defineProperty(req,'cf',{value:{colo:'SIN',country:'MY'}})
 const result=geminiRequestContext(req)
 assert.equal(result.ingressColo,'SIN');assert.equal(result.clientCountry,'MY')
 assert.equal(result.googleObservedEgress,'unknown');assert.equal(result.placement,null)
 assert.equal(geminiRequestContext(new Request('https://example.com')).ingressColo,null)
})
test('diagnostic HTML escapes model injection and emitted JS parses', () => {
 const page=renderGeminiDiagnostics('</script><img src=x>')
 assert.ok(!page.script.includes('</script>'));new Script(page.script)
 assert.match(page.script,/input.value = ''/);assert.ok(!page.script.includes('localStorage'))
 assert.match(page.html,/two small Gemini/)
})
async function withWorkerFetch(response, run) {
 const previous=global.fetch;global.fetch=async()=>response.clone()
 try {const {handleRequest}=await import('../src/cloudflare-worker.mjs');await run(handleRequest)}
 finally {global.fetch=previous}
}
const env={SMARTSUBS_SECRET:'test-server-secret-at-least-32-chars',GEMINI_MODEL:'gemini-3.5-flash-lite'}
const post=path=>new Request('https://example.com'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({geminiApiKey:key})})
test('diagnostic route succeeds without issuing a session token',async()=>{
 await withWorkerFetch(new Response('{}',{status:200}),async handle=>{
  const response=await handle(post('/v1/gemini/diagnose'),env)
  assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store')
  const result=await response.json();assert.equal(result.ok,true);assert.ok(!('token' in result))
  assert.equal(result.requestContext.googleObservedEgress,'unknown')
 })
})
test('existing session route still creates a session after successful validation',async()=>{
 await withWorkerFetch(new Response('{}',{status:200}),async handle=>{
  const response=await handle(post('/v1/session'),env);assert.equal(response.status,201)
  const result=await response.json();assert.equal(typeof result.token,'string');assert.ok(result.token.length>0)
  assert.ok(result.expiresAt>Date.now())
 })
})
test('session failure forwards precise sanitized context without logging key',async()=>{
 const logs=[];const previous=console.warn;console.warn=value=>logs.push(String(value))
 try {
  await withWorkerFetch(new Response(JSON.stringify({error:{status:'FAILED_PRECONDITION',message:`User location is not supported for the API use. ${key}`}}),{status:400}),async handle=>{
   const response=await handle(post('/v1/session'),env);assert.equal(response.status,422)
   const body=await response.json();assert.equal(body.errorReason,'GEMINI_LOCATION_UNSUPPORTED')
   assert.equal(body.requestContext.googleObservedEgress,'unknown')
   assert.ok(!JSON.stringify(body).includes(key))
  })
  assert.equal(logs.length,1);assert.ok(!logs.join('').includes(key))
 } finally {console.warn=previous}
})
test('diagnostic route uses existing rate limit',async()=>{
 const {handleRequest}=await import('../src/cloudflare-worker.mjs')
 const response=await handleRequest(post('/v1/gemini/diagnose'),{...env,SMARTSUBS_SUBTITLE_LIMITER:{limit:async()=>({success:false})}})
 assert.equal(response.status,429)
})
test('page CSP allows only its exact script and intended Gemini connection',async()=>{
 const {handleRequest}=await import('../src/cloudflare-worker.mjs')
 const response=await handleRequest(new Request('https://example.com/diagnose/gemini'),env)
 assert.equal(response.status,200)
 const html=await response.text();const script=html.match(/<script>([\s\S]*)<\/script>/)[1]
 const hash=createHash('sha256').update(script).digest('base64')
 assert.ok(response.headers.get('content-security-policy').includes(`script-src 'sha256-${hash}'`))
 assert.match(response.headers.get('content-security-policy'),/connect-src 'self' https:\/\/generativelanguage.googleapis.com/)
 assert.equal(response.headers.get('cache-control'),'no-store')
})
