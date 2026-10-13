# VUEO-SmartSubs

- New backend derived from the supplied SmartSubsV2-main (4).zip.
- Keep SmartSubs/SmartSubsV2 infrastructure separate from VUEO-SmartSubs.
- The public Worker entrypoint is src/vueo-worker.mjs. Legacy Stremio modules remain internal engine/regression-test dependencies; their routes are not exposed by this service.
- Each user provides their own Gemini key. Never add a shared Gemini key, log user keys, or store keys/headers as plaintext jobs.
- Preserve translator.js, movie adaptive/chunking defaults, cultural preservation, lyrics exclusion and SDH cleanup unless explicitly requested.
- Run npm run check and npm test. Test API ownership, input validation, retry and job deduplication alongside legacy translation regression tests.
- Keep workflow YAML outside delivery ZIPs when requested. Never include node_modules, live credentials, generated deployment configuration or build output in ZIPs.
