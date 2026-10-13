'use strict'

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function buildConfiguredUrls(base, token) {
  const root = String(base || '').replace(/\/+$/, '')
  const configured = `${root}/c/${encodeURIComponent(token)}`
  const manifestUrl = `${configured}/manifest.json`
  return {
    configuredBaseUrl: configured,
    manifestUrl,
    installUrl: `stremio://${manifestUrl.replace(/^https?:\/\//, '')}`
  }
}

class GeminiValidationError extends Error {
  constructor(code, message, upstreamStatus = null) {
    super(message)
    this.name = 'GeminiValidationError'
    this.code = code
    this.upstreamStatus = upstreamStatus
  }
}

async function validateGeminiApiKey(apiKey, options = {}) {
  const key = String(apiKey || '').trim()
  if (key.length < 20) throw new GeminiValidationError('GEMINI_KEY_INVALID', 'Gemini API key looks invalid.')
  const model = String(options.model || 'gemini-3.5-flash-lite')
  const fetchImpl = options.fetchImpl || fetch
  let response
  try {
    response = await fetchImpl(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: 'POST',
      signal: AbortSignal.timeout(20_000),
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ parts: [{ text: 'Reply with OK.' }] }],
        generationConfig: { maxOutputTokens: 4 }
      })
    }
    )
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError'
    throw new GeminiValidationError(timedOut ? 'GEMINI_TIMEOUT' : 'GEMINI_NETWORK_ERROR',
      timedOut ? 'Gemini validation timed out. Try again.' : 'SmartSubs could not reach Gemini. Try again later.')
  }
  if (!response.ok) {
    // Use only known classifications. Never return Google's raw message, key or URL.
    let payload = null
    try { payload = await response.json() } catch {}
    const reasons = Array.isArray(payload?.error?.details)
      ? payload.error.details.map(detail => detail?.reason) : []
    const invalidKey = reasons.includes('API_KEY_INVALID') ||
      /API key not valid|invalid API key/i.test(String(payload?.error?.message || ''))
    const status = response.status
    let code = 'GEMINI_REQUEST_REJECTED'
    let message = 'Gemini rejected the validation request. Check the configured model.'
    if (invalidKey || status === 401) {
      code = 'GEMINI_KEY_INVALID'; message = 'Gemini rejected this API key. Check or replace the key.'
    } else if (status === 403) {
      code = 'GEMINI_ACCESS_DENIED'; message = 'Gemini denied access. Check API key restrictions and project permissions.'
    } else if (status === 404) {
      code = 'GEMINI_MODEL_UNAVAILABLE'; message = 'The configured Gemini model is unavailable for this key or API version.'
    } else if (status === 429) {
      code = 'GEMINI_QUOTA_EXCEEDED'; message = 'Gemini quota or rate limit reached. Check quota or try again later.'
    } else if (status >= 500) {
      code = 'GEMINI_SERVICE_UNAVAILABLE'; message = 'Gemini is temporarily unavailable. Try again later.'
    }
    throw new GeminiValidationError(code, message, status)
  }
  return true
}

function renderConfigurePage(options = {}) {
  const error = options.error ? `<p class="error">${escapeHtml(options.error)}</p>` : ''
  const result = options.manifestUrl
    ? `<div class="result"><p>SmartSubsV2 is configured.</p><p><a href="${escapeHtml(options.installUrl || '')}">Install in Stremio</a></p><p><a href="${escapeHtml(options.diagnoseUrl || '')}">Open Diagnose</a></p><code>${escapeHtml(options.manifestUrl)}</code></div>`
    : ''
  const disabled = options.secretReady === false ? ' disabled' : ''
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SmartSubsV2</title><style>:root{color-scheme:dark}body{font-family:system-ui,sans-serif;background:#101116;color:#f4f4f5;margin:0}.wrap{max-width:680px;margin:auto;padding:24px}.card{background:#181a21;border:1px solid #30333d;border-radius:16px;padding:20px}input,button{width:100%;box-sizing:border-box;padding:12px;margin-top:10px;border-radius:10px}code{word-break:break-all}.error{color:#ffb4b4}a{color:#c9ffdc}</style></head><body><main class="wrap"><section class="card"><h1>SmartSubsV2</h1><p>Malay subtitles using OpenSubtitles v3 with Gemini BYOK fallback.</p>${error}<form method="post"><label>Gemini API key<input name="geminiApiKey" type="password" autocomplete="off" required${disabled}></label><button type="submit"${disabled}>Configure</button></form>${result}<p>Model: <code>${escapeHtml(options.model || '')}</code></p></section></main></body></html>`
}

module.exports = { escapeHtml, buildConfiguredUrls, validateGeminiApiKey, GeminiValidationError, renderConfigurePage }
