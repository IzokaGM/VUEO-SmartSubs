# VUEO-SmartSubs

Remote English → Bahasa Melayu Malaysia subtitle translation backend for VUEO TV and mobile.
Based on **SmartSubsV2-main (4).zip**. Translation, parsing, chunking, movie adaptive settings, cultural preservation, lyrics exclusion and SDH cleanup use that supplied engine. VUEO integration is a separate next step.

## What is ready

- Every user enters their own Gemini key. `POST /v1/session` validates that key/model and returns an encrypted session token.
- Accept subtitle **text upload** or an **HTTPS URL with source headers**.
- Queue translation, deduplicate jobs for the same user/source/model, poll job status and return a signed VTT download link.
- Gemini keys and upstream cookies/Authorization headers are encrypted in stored job input. Queue messages contain only job ID and generation.
- Cache is separated by user and source identity. Jobs/results in the Durable Object expire after 24 hours; translation cache follows the original cache TTL. Download tickets expire after one hour.
- Session tokens expire after 30 days. A token authorizes that user's jobs, so VUEO must store it as a secret and never put it into logs.

## Empty GitHub repo setup

1. Add the separately supplied **vueo-smartsubs.yml** as `.github/workflows/vueo-smartsubs.yml`.
2. Upload the project ZIP to the root of **VUEO-SmartSubs**. The workflow extracts root paths, tests the project, removes the ZIP and commits the files.
3. For deployment, add these GitHub Actions secrets:
   - `CLOUDFLARE_ACCOUNT_ID`
   - `CLOUDFLARE_API_TOKEN` with Workers Scripts, Workers KV Storage, Queues and Durable Objects permissions for the chosen account.
   - `VUEO_SMARTSUBS_SECRET`: a unique random value of at least 32 characters. Keep it stable across deployments. This is the backend encryption secret, **not a Gemini key**.
4. Run **VUEO-SmartSubs → Run workflow**, choose `deploy = true`.
5. Deployment creates/reuses **vueo-smartsubs-cache**, **vueo-smartsubs-translation**, Worker **vueo-smartsubs**, and its dedicated SQLite Durable Object. It never references the original SmartSubsV2 KV ID or queue.
6. Open the deployed Worker `/health`. It should return `ready: true`. Then test the session/upload/job/result sequence in API.md before building VUEO integration.

No live credentials are included. Local/mock tests do not verify your Cloudflare deployment, live Gemini quota, model access or a particular provider URL.

## Source URL access

For URL input, set `VUEO_UPSTREAM_HOSTS` in wrangler.jsonc to approved public hostnames, separated by commas. `*.example.com` allows subdomains only. Include any legitimate redirect hosts too. The default is empty, so **text uploads work first and URL submissions return SOURCE_HOST_NOT_ALLOWED until configured**.

The server supports Referer, Origin, User-Agent, Authorization, Cookie, Accept and Accept-Language. It rejects other headers, private/IP/custom-port URLs and unapproved redirect hosts. Authorization/Cookie are stripped when redirects cross origins. URL fetch timeout is 15 seconds; subtitle input is limited to 1 MiB.

If the provider URL is tied to the phone/TV's IP or browser session, VUEO can fetch the original subtitle and upload its text. Translation still happens on the backend.

## Model and settings

The model defaults to the supplied `gemini-3.5-flash-lite` value. `/v1/session` checks real access with the user's key and performs a tiny validation call. If unavailable for your account, change GEMINI_MODEL to a model you can access and register a new session.

Original chunk/concurrency settings are retained in wrangler.jsonc. Requests use the original `user-selected-stable` queue profile; movie adaptive defaults remain 160–200 items / target 10 chunks. Failed jobs may retry up to three queue deliveries using the inherited recovery profiles. Jobs never silently switch to another user's key.

## Development

- `npm ci --ignore-scripts`
- `npm run check`
- `npm test`

The new tests use mocked Cloudflare storage/Queue and mocked Gemini responses. Legacy engine tests are retained; deployment identity tests are updated for the new isolated service.

Official infrastructure API references:
- https://developers.cloudflare.com/api/resources/queues/methods/create/
- https://developers.cloudflare.com/api/resources/kv/subresources/namespaces/methods/create/
- https://developers.cloudflare.com/durable-objects/platform/limits/
