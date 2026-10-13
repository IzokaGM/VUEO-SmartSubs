import { queueTranslationOptions, queueTranslationProfile, movieAdaptiveTargetChunks, movieAdaptiveChunkItemsMin, movieAdaptiveChunkItemsMax } from './cloudflare-worker.mjs'
import { CloudflareTranslationCache, cfGetOrTranslate, makeCacheKey } from './cf-cache.mjs'
import configure from './configure.js'
import { prepareSourceText } from './vueo-source.mjs'
import { ApiError, MAX_SOURCE_BYTES, readJson, normalizeSource, fetchSource, session, secret, seal, unseal, hash, userId, resultTicket, checkTicket } from './vueo-security.mjs'
export { VueoSmartSubsJob } from './vueo-job-store.mjs'
export const BUILD_ID = 'vueo-smartsubs-1.0.0'
const memory = new WeakMap()
const cacheVersion = env => String(env.SMARTSUBS_CACHE_VERSION || 'vueo-v1')
const model = env => String(env.GEMINI_MODEL || 'gemini-3.5-flash-lite')
function cache(env) {
  if (!env.SMARTSUBS_CACHE) throw new ApiError(503, 'SERVER_NOT_CONFIGURED', 'Cache binding is missing')
  if (!memory.has(env.SMARTSUBS_CACHE)) memory.set(env.SMARTSUBS_CACHE, new CloudflareTranslationCache({ kv: env.SMARTSUBS_CACHE, version: cacheVersion(env), ttlMs: Number(env.SMARTSUBS_CACHE_TTL_MS || 15552000000) }))
  return memory.get(env.SMARTSUBS_CACHE)
}
async function limited(binding, key) {
  if (binding && !(await binding.limit({ key })).success) throw new ApiError(429, 'RATE_LIMITED', 'Too many requests; try again later')
}
function response(value, status = 200) {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-vueo-build': BUILD_ID } })
}
function stub(env, id) {
  if (!env.VUEO_JOBS || !env.VUEO_TRANSLATION_QUEUE) throw new ApiError(503, 'SERVER_NOT_CONFIGURED', 'Job or Queue binding is missing')
  return env.VUEO_JOBS.get(env.VUEO_JOBS.idFromName(id))
}
async function call(env, id, path, body, owner) {
  const res = await stub(env, id).fetch(`https://vueo-job.internal${path}`, {
    method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(owner ? { 'x-vueo-user': owner } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  })
  if (body && !res.ok) throw new ApiError(503, 'JOB_STORAGE_UNAVAILABLE', 'Job storage is unavailable')
  return res
}
function jobReply(job, request, env) {
  const base = new URL(request.url).origin
  return { ...job, pollAfterMs: ['queued','running'].includes(job.status) ? 3000 : 0,
    ...(job.status === 'ready' ? { resultUrl: `${base}/v1/jobs/${job.jobId}/result.vtt?ticket=${resultTicket(job.jobId, env)}`, language: 'ms', mimeType: 'text/vtt' } : {}) }
}
function cleanError(error) {
  if (error instanceof ApiError) return { code: error.code, message: error.message }
  const match = String(error?.message || '').match(/Gemini HTTP (\d{3})/)
  if (match) return { code: `GEMINI_HTTP_${match[1]}`, message: `Gemini returned HTTP ${match[1]}; check your key, model access or quota` }
  if (/No timed subtitle cues/i.test(error?.message || '')) return { code: 'NO_TIMED_CUES', message: 'Source has no supported timed subtitle cues' }
  return { code: 'TRANSLATION_FAILED', message: 'Translation failed; retry or check the subtitle source' }
}
export async function handleVueoRequest(request, env, options = {}) {
  try {
    const url = new URL(request.url)
    if (request.method === 'GET' && url.pathname === '/health') {
      const ready = Boolean(env.VUEO_SMARTSUBS_SECRET?.length >= 32 && env.VUEO_JOBS && env.VUEO_TRANSLATION_QUEUE && env.SMARTSUBS_CACHE)
      return response({ service: 'VUEO-SmartSubs', build: BUILD_ID, ready, model: model(env), sourceLanguage: 'en', targetLanguage: 'ms' }, ready ? 200 : 503)
    }
    if (request.method === 'GET' && url.pathname === '/') return response({ service: 'VUEO-SmartSubs', api: '/v1', health: '/health', docs: 'See API.md in the repository' })
    secret(env)
    if (request.method === 'POST' && url.pathname === '/v1/session') {
      await limited(env.SMARTSUBS_SESSION_LIMITER, request.headers.get('cf-connecting-ip') || 'anonymous')
      const input = await readJson(request)
      const apiKey = String(input?.geminiApiKey || '').trim()
      if (apiKey.length < 20 || apiKey.length > 256 || /[\r\n\0]/.test(apiKey)) throw new ApiError(400, 'INVALID_API_KEY', 'Gemini key format is invalid')
      try {
        await configure.validateGeminiApiKey(apiKey, { model: model(env), fetchImpl: options.fetchImpl || fetch })
      } catch (error) {
        const detail = cleanError(error)
        throw new ApiError(detail.code.endsWith('_429') ? 429 : 422, detail.code === 'TRANSLATION_FAILED' ? 'KEY_VALIDATION_FAILED' : detail.code, 'Gemini key/model validation failed; check access and quota')
      }
      const exp = Date.now() + 30 * 24 * 60 * 60 * 1000
      const token = seal({ kind: 'session', apiKey, model: model(env), user: userId(apiKey, env), exp }, env)
      return response({ token, expiresAt: exp, model: model(env) }, 201)
    }
    const match = url.pathname.match(/^\/v1\/jobs\/([a-f0-9]{64})(\/result\.vtt)?$/)
    if (request.method === 'GET' && match?.[2]) {
      if (!checkTicket(match[1], url.searchParams.get('ticket'), env)) throw new ApiError(401, 'INVALID_RESULT_TICKET', 'Result link is invalid or expired')
      const res = await call(env, match[1], '/result')
      return new Response(res.body, { status: res.status, headers: { 'content-type': res.headers.get('content-type') || 'application/json', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' } })
    }
    if (request.method === 'POST' && url.pathname === '/v1/jobs') {
      const account = session(request, env)
      await limited(env.SMARTSUBS_GENERATE_LIMITER, account.user)
      const input = await readJson(request)
      if (input?.sourceLanguage !== 'en' || input?.targetLanguage !== 'ms') throw new ApiError(400, 'UNSUPPORTED_LANGUAGE', 'This version translates English to Malay only')
      const source = normalizeSource(input.source, env)
      const rawMedia = input.media || {}
      const media = { type: rawMedia.type, id: rawMedia.id }
      if (!['movie','series'].includes(media.type) || typeof media.id !== 'string' || !/^[\w:.-]{1,128}$/.test(media.id)) throw new ApiError(400, 'INVALID_MEDIA', 'Provide media.type (movie/series) and media.id')
      const identity = hash(JSON.stringify({ source, sourceId: String(input.sourceId || '').slice(0,256), media, owner: account.user }))
      const sourceUrl = source.url || `https://vueo-upload.invalid/${identity}`
      const id = makeCacheKey(sourceUrl, account.model, cacheVersion(env), identity)
      const readyVtt = await cache(env).get(id)
      const job = await (await call(env, id, '/submit', { id, owner: account.user, cacheKey: id, readyVtt,
        sealedInput: seal({ source, sourceUrl, identity, account, media }, env) })).json()
      return response(jobReply(job, request, env), job.status === 'ready' ? 200 : job.status === 'failed' ? 503 : 202)
    }
    if (request.method === 'GET' && match && !match[2]) {
      const account = session(request, env)
      const res = await call(env, match[1], '/status', null, account.user)
      const data = await res.json()
      return response(res.ok ? jobReply(data, request, env) : data, res.status)
    }
    return response({ error: { code: 'NOT_FOUND', message: 'Endpoint not found' } }, 404)
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 500
    return response({ error: cleanError(error) }, status)
  }
}
export async function consumeVueoMessage(message, env, options = {}) {
  const id = message.body?.jobId
  if (!/^[a-f0-9]{64}$/.test(id || '') || !Number.isInteger(message.body?.generation)) { message.ack(); return }
  const attempts = Math.max(1, Number(message.attempts || 1))
  const job = await (await call(env, id, '/claim', { generation: message.body.generation, attempts })).json()
  if (job.skip) { message.ack(); return }
  if (job.busy) { message.retry({ delaySeconds: 60 }); return }
  let retry = false
  try {
    const input = unseal(job.sealedInput, env)
    if (input.account.exp <= Date.now()) throw new ApiError(401, 'SESSION_EXPIRED', 'Renew your Gemini session')
    const text = prepareSourceText(await fetchSource(input.source, env, options.fetchImpl || fetch))
    const selectedProfile = 'user-selected-stable'
    const profileName = queueTranslationProfile(env, attempts, selectedProfile)
    const queueOptions = queueTranslationOptions(env, attempts, selectedProfile)
    const fetchImpl = options.fetchImpl || fetch
    const result = await cfGetOrTranslate({
      cache: cache(env), upstreamUrl: input.sourceUrl, sourceId: input.identity,
      model: input.account.model, apiKey: input.account.apiKey, cacheVersion: cacheVersion(env),
      translateOptions: queueOptions,
      translateContext: {
        mediaType: input.media.type,
        movieAdaptiveChunking: input.media.type === 'movie' && profileName !== 'fallback-stable',
        movieTargetChunks: movieAdaptiveTargetChunks(env), movieChunkItemsMin: movieAdaptiveChunkItemsMin(env), movieChunkItemsMax: movieAdaptiveChunkItemsMax(env),
        abortRetryDelayMs: Number(env.GEMINI_CHUNK_ABORT_RETRY_MS || 1000),
        movieHedgeEnabled: String(env.GEMINI_MOVIE_HEDGE_ENABLED || 'true') === 'true',
        movieHedgeDelayMs: Number(env.GEMINI_MOVIE_HEDGE_DELAY_MS || 35000),
        fetchImpl: async (url, init) => String(url) === input.sourceUrl ? new Response(text, { headers: { 'content-type': 'text/plain' } }) : fetchImpl(url, init)
      },
      ...(options.translateFn ? { translateFn: options.translateFn } : {})
    })
    if (!result.vtt.startsWith('WEBVTT') || Buffer.byteLength(result.vtt) > MAX_SOURCE_BYTES * 1.5) throw new ApiError(422, 'INVALID_RESULT', 'Translated subtitle output is invalid or too large')
    await call(env, id, '/finish', { generation: job.generation, attempts, vtt: result.vtt })
    message.ack()
    console.log(JSON.stringify({ tag: 'VUEO_SMARTSUBS_JOB', jobId: id, status: 'ready', attempts, cache: result.status }))
  } catch (error) {
    const detail = cleanError(error)
    retry = attempts < 3 && !error?.code?.startsWith('SOURCE_') && !['NO_TIMED_CUES','GEMINI_HTTP_400','GEMINI_HTTP_401','GEMINI_HTTP_403','INVALID_RESULT','SESSION_EXPIRED'].includes(detail.code)
    await call(env, id, '/finish', { generation: job.generation, attempts, retry, error: detail })
    if (retry) message.retry({ delaySeconds: detail.code === 'GEMINI_HTTP_429' ? 30 : 10 })
    else message.ack()
    console.log(JSON.stringify({ tag: 'VUEO_SMARTSUBS_JOB', jobId: id, status: retry ? 'retrying' : 'failed', attempts, errorCode: detail.code }))
  }
}
export default {
  fetch: handleVueoRequest,
  async queue(batch, env) { for (const message of batch.messages) await consumeVueoMessage(message, env) }
}
