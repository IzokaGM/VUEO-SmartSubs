'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')

const manifest = require('../src/manifest')
const { createConfiguredManifest } = require('../src/configured-manifest')

test('SmartSubsV2 parity migration preserves the stable addon identity', () => {
  assert.equal(manifest.id, 'community.smartsubsv2')
  assert.equal(manifest.name, 'SmartSubsV2')
  assert.equal(manifest.version, '1.0.0')
})

test('configured SmartSubsV2 manifest preserves identity and subtitle resources', () => {
  const configured = createConfiguredManifest('https://smartsubs.example/c/private')

  assert.equal(configured.id, 'community.smartsubsv2')
  assert.equal(configured.name, 'SmartSubsV2')
  assert.deepEqual(configured.resources, manifest.resources)
  assert.deepEqual(configured.types, ['movie', 'series'])
})

test('VUEO-SmartSubs has isolated Cloudflare resources', () => {
  const config = JSON.parse(fs.readFileSync('wrangler.jsonc', 'utf8'))

  assert.equal(config.name, 'vueo-smartsubs')
  assert.deepEqual(config.kv_namespaces, [{
    binding: 'SMARTSUBS_CACHE',
    id: 'REPLACED_BY_PROVISION_SCRIPT'
  }])
  assert.equal(config.queues.producers[0].queue, 'vueo-smartsubs-translation')
  assert.equal(config.queues.consumers[0].queue, 'vueo-smartsubs-translation')
  assert.deepEqual(config.ratelimits.map(item => item.namespace_id), ['9283101', '9283102'])
  assert.equal(config.durable_objects.bindings[0].name, 'VUEO_JOBS')
  assert.equal(config.migrations[0].tag, 'vueo-smartsubs-jobs-v1')
})
