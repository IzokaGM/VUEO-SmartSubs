import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
export const MAX_SOURCE_BYTES = 1024 * 1024
export const MAX_REQUEST_BYTES = 2 * 1024 * 1024
export class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code }
}
export function secret(env) {
  const value = String(env.VUEO_SMARTSUBS_SECRET || '')
  if (value.length < 32) throw new ApiError(503, 'SERVER_NOT_CONFIGURED', 'Backend secret is not configured')
  return value
}
export const hash = value => createHash('sha256').update(String(value)).digest('hex')
export const userId = (apiKey, env) => createHmac('sha256', secret(env)).update(apiKey).digest('hex')
export function seal(value, env) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(secret(env)).digest(), iv)
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
  return ['v1', iv.toString('base64url'), encrypted.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.')
}
export function unseal(token, env) {
  const parts = String(token || '').split('.')
  if (parts.length !== 4 || parts[0] !== 'v1') throw new ApiError(401, 'INVALID_SESSION', 'Session is invalid or expired')
  try {
    const decoded = parts.slice(1).map(part => {
      const bytes = Buffer.from(part, 'base64url')
      if (!/^[A-Za-z0-9_-]+$/.test(part) || bytes.toString('base64url') !== part) throw new Error('Invalid encoding')
      return bytes
    })
    if (decoded[0].length !== 12 || decoded[2].length !== 16) throw new Error('Invalid authentication parameters')
    const decipher = createDecipheriv('aes-256-gcm', createHash('sha256').update(secret(env)).digest(), decoded[0], { authTagLength: 16 })
    decipher.setAuthTag(decoded[2])
    return JSON.parse(Buffer.concat([decipher.update(decoded[1]), decipher.final()]).toString('utf8'))
  } catch { throw new ApiError(401, 'INVALID_SESSION', 'Session is invalid or expired') }
}
export function session(request, env) {
  const token = request.headers.get('authorization')?.match(/^Bearer (\S{1,4096})$/)?.[1]
  const data = unseal(token, env)
  if (data.kind !== 'session' || !data.apiKey || !/^[a-f0-9]{64}$/.test(data.user || '') || !Number.isFinite(data.exp) || data.exp <= Date.now()) {
    throw new ApiError(401, 'INVALID_SESSION', 'Session is invalid or expired')
  }
  return data
}
export function resultTicket(jobId, env) {
  const expires = Date.now() + 60 * 60 * 1000
  const signature = createHmac('sha256', secret(env)).update(`${jobId}:${expires}`).digest('base64url')
  return `${expires}.${signature}`
}
export function checkTicket(jobId, ticket, env) {
  const parts = String(ticket || '').split('.')
  if (parts.length !== 2) return false
  const [expires, signature] = parts
  if (!/^\d{13}$/.test(expires || '') || Number(expires) <= Date.now()) return false
  const expected = createHmac('sha256', secret(env)).update(`${jobId}:${expires}`).digest('base64url')
  const a = Buffer.from(signature || ''), b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}
export async function readJson(request) {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new ApiError(415, 'JSON_REQUIRED', 'Use application/json')
  const size = Number(request.headers.get('content-length') || 0)
  if (size > MAX_REQUEST_BYTES) throw new ApiError(413, 'REQUEST_TOO_LARGE', 'Request is too large')
  const reader = request.body?.getReader()
  if (!reader) throw new ApiError(400, 'INVALID_JSON', 'Request body is missing')
  const chunks = []; let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break
      total += value.byteLength
      if (total > MAX_REQUEST_BYTES) { await reader.cancel(); throw new ApiError(413, 'REQUEST_TOO_LARGE', 'Request is too large') }
      chunks.push(Buffer.from(value))
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw new ApiError(400, 'INVALID_JSON', 'Request must contain a JSON object')
  } finally { reader.releaseLock() }
}
export function publicUrl(value, env) {
  let url
  try { url = new URL(value) } catch { throw new ApiError(400, 'INVALID_SOURCE_URL', 'Source URL is invalid') }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || url.hash) throw new ApiError(400, 'INVALID_SOURCE_URL', 'Source URL must be HTTPS without credentials, fragments or custom ports')
  const host = url.hostname.toLowerCase()
  if (!host.includes('.') || host.includes(':') || /^\d+(\.\d+){3}$/.test(host) || /(^|\.)(localhost|local|internal|lan|invalid|test)$/.test(host)) throw new ApiError(400, 'INVALID_SOURCE_URL', 'Source host is not permitted')
  const allowed = String(env.VUEO_UPSTREAM_HOSTS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean)
  if (!allowed.some(rule => rule.startsWith('*.') ? host.endsWith(rule.slice(1)) && host !== rule.slice(2) : host === rule)) throw new ApiError(400, 'SOURCE_HOST_NOT_ALLOWED', 'Use subtitle text upload or configure this upstream host')
  return url.toString()
}
export function sourceHeaders(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ApiError(400, 'INVALID_HEADERS', 'Source headers must be an object')
  const allowed = new Set(['referer', 'origin', 'user-agent', 'authorization', 'cookie', 'accept', 'accept-language'])
  const headers = {}
  for (const [name, value] of Object.entries(input)) {
    const key = name.toLowerCase()
    if (!allowed.has(key) || typeof value !== 'string' || /[\r\n\0]/.test(value)) throw new ApiError(400, 'INVALID_HEADERS', 'Source contains an unsupported header')
    headers[key] = value
  }
  if (Buffer.byteLength(JSON.stringify(headers)) > 8192) throw new ApiError(400, 'INVALID_HEADERS', 'Source headers are too large')
  return headers
}
export function normalizeSource(input, env) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ApiError(400, 'SOURCE_REQUIRED', 'Provide a subtitle URL or subtitle text')
  const text = typeof input.text === 'string', url = typeof input.url === 'string'
  if (text === url) throw new ApiError(400, 'INVALID_SOURCE', 'Provide exactly one of source.text or source.url')
  if (text) {
    if (!input.text.trim() || Buffer.byteLength(input.text) > MAX_SOURCE_BYTES) throw new ApiError(413, 'SOURCE_TOO_LARGE_OR_EMPTY', 'Subtitle text must be between 1 byte and 1 MiB')
    return { text: input.text, headers: {} }
  }
  return { url: publicUrl(input.url, env), headers: sourceHeaders(input.headers || {}) }
}
export async function fetchSource(source, env, fetchImpl = fetch) {
  if (typeof source.text === 'string') return source.text
  let url = publicUrl(source.url, env)
  const originalOrigin = new URL(url).origin
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 15000)
  try {
    for (let hops = 0; hops <= 3; hops++) {
      const headers = { accept: 'text/vtt,text/plain,application/x-subrip,*/*', ...source.headers }
      if (new URL(url).origin !== originalOrigin) { delete headers.authorization; delete headers.cookie }
      const response = await fetchImpl(url, { headers, redirect: 'manual', signal: controller.signal })
      if ([301,302,303,307,308].includes(response.status)) {
        const location = response.headers.get('location'); await response.body?.cancel()
        if (!location || hops === 3) throw new ApiError(422, 'SOURCE_REDIRECT_FAILED', 'Subtitle redirect limit exceeded')
        url = publicUrl(new URL(location, url).toString(), env); continue
      }
      if (!response.ok) { await response.body?.cancel(); throw new ApiError(422, 'SOURCE_HTTP_ERROR', `Subtitle source HTTP ${response.status}`) }
      if (Number(response.headers.get('content-length') || 0) > MAX_SOURCE_BYTES) { await response.body?.cancel(); throw new ApiError(413, 'SOURCE_TOO_LARGE', 'Subtitle source exceeds 1 MiB') }
      const reader = response.body?.getReader(); if (!reader) throw new ApiError(422, 'EMPTY_SOURCE', 'Subtitle source is empty')
      const chunks = []; let size = 0
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break
          size += value.byteLength
          if (size > MAX_SOURCE_BYTES) { await reader.cancel(); throw new ApiError(413, 'SOURCE_TOO_LARGE', 'Subtitle source exceeds 1 MiB') }
          chunks.push(Buffer.from(value))
        }
      } finally { reader.releaseLock() }
      if (!size) throw new ApiError(422, 'EMPTY_SOURCE', 'Subtitle source is empty')
      return Buffer.concat(chunks).toString('utf8')
    }
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw new ApiError(422, 'SOURCE_FETCH_FAILED', 'Subtitle fetch failed or timed out')
  } finally { clearTimeout(timer) }
}
