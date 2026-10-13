'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createUserConfigToken } = require('../src/user-config')

function memoryKv() {
  const values = new Map()
  return {
    async put(key, value) { values.set(String(key), String(value)) },
    async get(key) { return values.get(String(key)) ?? null },
    async list(options = {}) {
      const prefix = String(options.prefix || '')
      const keys = [...values.keys()].filter(key => key.startsWith(prefix)).map(name => ({ name }))
      return { keys }
    }
  }
}

test('Nuvio diagnose build marker is exposed by production worker health', async () => {
  const { BUILD_ID, handleRequest } = await import('../src/cloudflare-worker.mjs')
  assert.equal(BUILD_ID, 'vueo-v2-upstream-1')
  const response = await handleRequest(new Request('https://smartsubs.example/health'), {
    SMARTSUBS_SECRET: 'server-secret-for-tests',
    SMARTSUBS_CACHE: memoryKv()
  })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.build, 'vueo-v2-upstream-1')
  assert.equal(body.diagnose, true)
})

test('VUEO English source returns on-demand Malay Auto and English without any upstream addon lookup', async () => {
  const { handleRequest } = await import('../src/cloudflare-worker.mjs')
  const secret = 'server-secret-for-tests'
  const token = createUserConfigToken('fake-gemini-key-12345678901234567890', {
    secret,
    model: 'gemini-3.5-flash-lite',
    iv: Buffer.alloc(12, 5)
  })
  const kv = memoryKv()
  const originalFetch = global.fetch
  global.fetch = async url => {
    if (String(url).startsWith('https://opensubtitles-v3.strem.io/')) {
      return new Response(JSON.stringify({
        subtitles: [
          { id: 'english-normal', lang: 'eng', url: 'https://example.test/subtitle-en.srt' }
        ]
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  }

  try {
    const base = `https://smartsubs.example/c/${token}`
    const response = await handleRequest(
      new Request(`${base}/subtitles`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ media: { type: 'movie', id: 'tmdb:1375666' }, subtitles: [{ id: 'english-normal', lang: 'eng', text: '1\n00:00:01,000 --> 00:00:02,000\nHello' }] }) }),
      { SMARTSUBS_SECRET: secret, SMARTSUBS_CACHE: kv }
    )
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.subtitles.length, 2)
    assert.equal(body.subtitles[0].lang, 'msa')
    assert.match(body.subtitles[0].url, /\/translated\/.+\.vtt$/)
    assert.equal(body.subtitles[1].lang, 'eng')
    assert.match(body.subtitles[1].id, /^vueo-eng-[a-f0-9]{64}$/)
    assert.match(body.subtitles[1].url, /\/source\/[a-f0-9]{64}$/)

    const diagnose = await handleRequest(new Request(`${base}/diagnose`), {
      SMARTSUBS_SECRET: secret,
      SMARTSUBS_CACHE: kv
    })
    assert.equal(diagnose.status, 200)
    const html = await diagnose.text()
    assert.match(html, /Diagnostics recording is off/) // Diagnose OFF by default; no stored event is read.
  } finally {
    global.fetch = originalFetch
  }
})
