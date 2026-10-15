import { createHash } from 'node:crypto'
import userConfig from './user-config.js'

const SOURCE_BASE = 'https://vueo-source.invalid/'
const MAX_BYTES = 2 * 1024 * 1024
const SOURCE_PREFIX = 'vueo:source:'
const sourceSecret = env => String(env.SMARTSUBS_SECRET || env.CONFIG_TOKEN_SECRET || env.TRANSLATION_TOKEN_SECRET || '')
const allowedHeaders = new Set(['referer', 'origin', 'user-agent', 'authorization', 'cookie', 'accept', 'accept-language'])
export class VueoInputError extends Error {}

export async function readVueoJson(request) {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new VueoInputError('Use application/json')
  const reader = request.body?.getReader()
  if (!reader) throw new VueoInputError('JSON body required')
  const chunks = []; let bytes = 0
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break
      bytes += next.value.byteLength
      if (bytes > MAX_BYTES) { await reader.cancel(); throw new VueoInputError('Request exceeds 2 MiB') }
      chunks.push(Buffer.from(next.value))
    }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid object')
    return value
  } catch (error) {
    if (error instanceof VueoInputError) throw error
    throw new VueoInputError('Invalid JSON object')
  } finally { reader.releaseLock() }
}

function safeUrl(value) {
  let url
  try { url = new URL(value) } catch { throw new VueoInputError('Invalid subtitle URL') }
  const host = url.hostname.toLowerCase()
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443') ||
      !host.includes('.') || host.includes(':') || /^\d+(\.\d+){3}$/.test(host) || /(^|\.)(localhost|local|internal|lan|invalid|test)$/.test(host)) {
    throw new VueoInputError('Subtitle URL must use a public HTTPS hostname')
  }
  return url.toString()
}

function normaliseSource(track) {
  if (!track || typeof track !== 'object' || Array.isArray(track)) throw new VueoInputError('Invalid subtitle track')
  const lang = String(track.lang || '').trim().toLowerCase()
  if (!/^[a-z]{2,3}$/.test(lang)) throw new VueoInputError('Provide subtitle language code')
  const text = typeof track.text === 'string', url = typeof track.url === 'string'
  if (text === url) throw new VueoInputError('Provide exactly one subtitle URL or text')
  const headers = {}
  if (track.headers != null) {
    if (!track.headers || typeof track.headers !== 'object' || Array.isArray(track.headers)) throw new VueoInputError('Invalid source headers')
    for (const [name,value] of Object.entries(track.headers)) {
      const key = name.toLowerCase()
      if (!allowedHeaders.has(key) || typeof value !== 'string' || /[\r\n\0]/.test(value)) throw new VueoInputError('Unsupported source header')
      headers[key] = value
    }
  }
  if (Buffer.byteLength(JSON.stringify(headers)) > 8192) throw new VueoInputError('Source headers too large')
  if (text && (!track.text.trim() || Buffer.byteLength(track.text) > MAX_BYTES)) throw new VueoInputError('Subtitle text is empty or exceeds 2 MiB')
  return { lang, id: String(track.id || '').slice(0,256), providerName: String(track.providerName || '').replace(/[\r\n\0]/g, ' ').slice(0,160), ...(text ? { text: track.text } : { url: safeUrl(track.url), headers }) }
}

// Candidate policy belongs to the worker. Old clients without origin metadata
// remain supported; new clients explicitly identify plugin/addon sources.
export function selectVueoSources(input) {
  const includeAddons = input.includeAddonSources === true
  const candidates = input.subtitles.filter(track => {
    if (!track || typeof track !== 'object') return false
    if (track.providerId === 'vueo-smartsubs-ai' || /gemini-ai-/i.test(String(track.id || ''))) return false
    if (!['en', 'eng', 'english'].includes(String(track.lang || track.language || '').trim().toLowerCase())) return false
    if (track.providerId && !String(track.providerId).startsWith('plugin:') && !includeAddons) return false
    if (typeof track.text === 'string') return true
    const hintFormat = value => {
      const hint = String(value || '').trim().toLowerCase()
      if (hint === 'ass' || hint === 'ssa' || /text\/x-(ssa|ass)/.test(hint)) return 'unsupported'
      if (hint === 'ttml' || hint === 'xml' || hint.includes('ttml')) return 'unsupported'
      if (hint === 'vtt' || hint.includes('text/vtt') || hint.includes('webvtt')) return 'supported'
      if (hint === 'srt' || hint.includes('subrip')) return 'supported'
      return null
    }
    let decodedUrl = String(track.url || '')
    try { decodedUrl = decodeURIComponent(decodedUrl) } catch {}
    const path = decodedUrl.split(/[?#]/)[0]
    let format = hintFormat(String(track.mimeType || '').split(';')[0]) || hintFormat(path.split('.').pop())
    if (!format) {
      const query = new URLSearchParams(decodedUrl.split('?')[1]?.split('#')[0] || '')
      for (const [key, value] of query) {
        if (['format','type','ext','extension','mime','mimetype','contenttype'].includes(key.toLowerCase())) {
          format = hintFormat(value)
          if (format) break
        }
      }
    }
    if (format === 'unsupported') return false
    try { safeUrl(track.url); return true } catch { return false }
  }).sort((a, b) => Number(!String(a.providerId || '').startsWith('plugin:')) - Number(!String(b.providerId || '').startsWith('plugin:')))
  const seen = new Set()
  return candidates.filter(track => {
    const key = typeof track.text === 'string' ? 'text:' + track.text : track.url
    if (seen.has(key)) return false
    seen.add(key); return true
  }).slice(0, 5)
}

function sourceDisplayId(track) {
  const explicit = typeof track.displayId === 'string' ? track.displayId.trim() : ''
  if (explicit) return explicit.slice(0, 512)
  const raw = String(track.id || '').trim()
  const id = raw.match(/^.+?:\d+:(.+)$/)?.[1]?.trim() || raw
  return !id || /^(vueo-subtitle:|external:)/.test(id) || /^track\s*\d+$/i.test(id) || ['en', 'eng', 'english'].includes(id.toLowerCase()) ? '' : id
}

export async function prepareVueoSources(input, env, configId) {
  const media = input.media
  if (!media || !['movie','series'].includes(media.type) || typeof media.id !== 'string' || !/^[\w:.-]{1,128}$/.test(media.id)) throw new VueoInputError('Provide media.type and media.id')
  if (!Array.isArray(input.subtitles) || input.subtitles.length > 50) throw new VueoInputError('Provide up to 50 subtitle tracks')
  const sources = selectVueoSources(input).map(track => ({
    ...normaliseSource({ ...track, lang: 'eng' }),
    providerDisplayId: sourceDisplayId(track),
  }))
  if (!env.SMARTSUBS_CACHE || !sourceSecret(env)) throw new Error('SmartSubs backend bindings are not configured')
  const tracks = []
  for (const source of sources) {
    // The original deduper compares language/URL, not the provider's display ID.
    const id = createHash('sha256').update(JSON.stringify({ configId, media, source: { ...source, id: undefined, providerName: undefined, providerDisplayId: undefined } })).digest('hex')
    // Reuse V2 AES-GCM config-token encryption for private source text/headers.
    const token = userConfig.createUserConfigToken(JSON.stringify({ ...source, owner: configId }), { secret: sourceSecret(env), model: 'vueo-source-v1' })
    await env.SMARTSUBS_CACHE.put(SOURCE_PREFIX + id, token, { expirationTtl: Math.max(60, Math.floor(Number(env.SMARTSUBS_CACHE_TTL_MS || 15552000000)/1000)) })
    tracks.push({ id, lang: source.lang, url: SOURCE_BASE + id,
      providerSubtitleId: source.id, sourceDisplayId: source.providerDisplayId,
      sourceProviderName: source.providerName.trim().split(/ \/ | • /).pop(),
    })
  }
  return { media: { type: media.type, id: media.id }, tracks }
}

async function download(source, fetchImpl, signal) {
  let url = safeUrl(source.url)
  const origin = new URL(url).origin
  for (let redirects = 0; redirects <= 3; redirects++) {
    const headers = { accept: 'text/vtt,text/plain,application/x-subrip,*/*;q=0.5', ...source.headers }
    if (new URL(url).origin !== origin) { delete headers.cookie; delete headers.authorization }
    const response = await fetchImpl(url, { headers, signal, redirect: 'manual' })
    if ([301,302,303,307,308].includes(response.status)) {
      const location = response.headers.get('location'); await response.body?.cancel()
      if (!location || redirects === 3) throw new Error('Subtitle source redirect failed')
      url = safeUrl(new URL(location,url).toString()); continue
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Subtitle source HTTP ${response.status}`) }
    if (Number(response.headers.get('content-length') || 0) > MAX_BYTES) { await response.body?.cancel(); throw new Error('Subtitle source is too large') }
    const reader = response.body?.getReader()
    if (!reader) throw new Error('Subtitle source is empty')
    const chunks = []; let bytes = 0
    try {
      while (true) {
        const next = await reader.read(); if (next.done) break
        bytes += next.value.byteLength
        if (bytes > MAX_BYTES) { await reader.cancel(); throw new Error('Subtitle source is too large') }
        chunks.push(Buffer.from(next.value))
      }
    } finally { reader.releaseLock() }
    return Buffer.concat(chunks).toString('utf8')
  }
}

export function vueoUpstreamOptions(env, upstreamUrl, fetchImpl = fetch, configId = '') {
  if (!String(upstreamUrl).startsWith(SOURCE_BASE)) return {}
  return { fetchImpl: async (url, options = {}) => {
    if (!String(url).startsWith(SOURCE_BASE)) return fetchImpl(url, options)
    const id = String(url).slice(SOURCE_BASE.length)
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid VUEO subtitle source')
    const token = await env.SMARTSUBS_CACHE.get(SOURCE_PREFIX + id)
    if (!token) throw new Error('VUEO subtitle source expired; send it again from VUEO')
    const decoded = userConfig.decodeUserConfigToken(token, { secret: sourceSecret(env) })
    if (decoded.model !== 'vueo-source-v1') throw new Error('Invalid VUEO subtitle source')
    const source = JSON.parse(decoded.apiKey)
    if (configId && source.owner !== configId) throw new Error('VUEO source does not belong to this configuration')
    const text = typeof source.text === 'string' ? source.text : await download(source,fetchImpl,options.signal)
    return new Response(text, { headers: { 'content-type': /^\uFEFF?WEBVTT/.test(text) ? 'text/vtt; charset=utf-8' : 'application/x-subrip; charset=utf-8', 'cache-control': 'private, no-store' } })
  } }
}

/** Resolve the selected source before cache/job lookup. Transport credentials
 * are not subtitle identity; retain all cue times and text in the digest.
 * Only the selected track is downloaded, never every listed AI candidate.
 */
export async function canonicalVueoTranslationSource(tokenData, env, configId, fetchImpl = fetch) {
  if (!String(tokenData.url).startsWith(SOURCE_BASE)) return tokenData
  const sourceId = String(tokenData.url).slice(SOURCE_BASE.length)
  if (!/^[a-f0-9]{64}$/.test(sourceId)) throw new Error('Invalid VUEO subtitle source')
  const stored = await env.SMARTSUBS_CACHE.get(SOURCE_PREFIX + sourceId)
  if (!stored) throw new Error('VUEO subtitle source expired; send it again from VUEO')
  const decoded = userConfig.decodeUserConfigToken(stored, { secret: sourceSecret(env) })
  if (decoded.model !== 'vueo-source-v1') throw new Error('Invalid VUEO subtitle source')
  const source = JSON.parse(decoded.apiKey)
  if (!configId || source.owner !== configId) throw new Error('VUEO source does not belong to this configuration')
  const text = (typeof source.text === 'string' ? source.text : await download(source, fetchImpl, AbortSignal.timeout(30_000)))
    .replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  if (!text.trim() || !text.includes('-->') || Buffer.byteLength(text) > MAX_BYTES) {
    throw new Error('Invalid VUEO subtitle content')
  }
  const id = createHash('sha256').update(JSON.stringify({
    version: 'vueo-content-v1', owner: configId, media: tokenData.media,
    lang: source.lang, text
  })).digest('hex')
  // Freeze exact input for Queue/direct translation, so the bytes hashed here
  // are also the bytes translated even if the provider URL later changes.
  const frozen = userConfig.createUserConfigToken(JSON.stringify({
    owner: configId, lang: source.lang, text, id: source.id, providerName: source.providerName
  }), { secret: sourceSecret(env), model: 'vueo-source-v1' })
  await env.SMARTSUBS_CACHE.put(SOURCE_PREFIX + id, frozen, {
    expirationTtl: Math.max(60, Math.floor(Number(env.SMARTSUBS_CACHE_TTL_MS || 15552000000) / 1000))
  })
  return { ...tokenData, url: SOURCE_BASE + id, sourceId: id, cacheId: id,
    providerSubtitleId: String(source.id || ''), providerName: String(source.providerName || '') }
}
