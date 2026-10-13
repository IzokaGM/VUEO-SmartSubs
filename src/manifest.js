'use strict'

module.exports = {
  id: 'community.vueo-smartsubs',
  version: '1.0.0',
  name: 'VUEO-SmartSubs',
  description: 'Smart Malay subtitles from VUEO provider subtitles with Gemini BYOK translation',
  resources: [
    { name: 'subtitles', types: ['movie', 'series'], idPrefixes: ['tt'] }
  ],
  types: ['movie', 'series'],
  catalogs: [],
  idPrefixes: ['tt'],
  behaviorHints: { configurable: true, configurationRequired: true }
}
