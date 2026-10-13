# VUEO-SmartSubs — corrected V2-based backend

This replaces the earlier redesigned VUEO-SmartSubs ZIP. Based directly on **SmartSubsV2-main (4).zip**. 

## Scope 

- OpenSubtitles discovery is replaced by subtitle tracks supplied by VUEO plugins.
- Each user enters their Gemini key in VUEO → Enhancements → Gemini. The backend still uses V2's existing encrypted BYOK config token.
- Original translation engine, model, adaptive chunks, concurrency, retries, cache TTL/version, on-demand source selection, Queue Join, final grace, Delivery Relay and diagnostics are retained.
- No new job Durable Object, session registry, provisioning script or GitHub-to-Cloudflare deploy action.
- Repository/Worker/Queue/KV identities are isolated for the new project. Binding names and behavior match V2.

## Replace the earlier package

1. Replace `.github/workflows/vueo-smartsubs.yml` with the separately supplied **vueo-smartsubs-v2-style.yml**. Keep the destination filename `vueo-smartsubs.yml` so the earlier deploy workflow is replaced.
2. Upload the corrected full-project ZIP to the repo root. Its full-snapshot marker makes the inherited universal workflow remove stale tracked files from the earlier package, apply root paths, test, commit and remove the ZIP.
3. GitHub Actions only applies the ZIP and runs checks/tests. It does not deploy or need CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID GitHub secrets.

## Cloudflare runtime — V2 style

Connect the VUEO-SmartSubs repository using the Cloudflare-side Git integration you use for V2. Worker name must match `vueo-smartsubs` in wrangler.jsonc. Root directory is repository root. Deploy command is `npx wrangler deploy`; dependency installation uses the supplied lockfile.

Before the first deployment:
- Create a separate KV namespace for VUEO-SmartSubs. Replace `REPLACE_WITH_VUEO_SMARTSUBS_KV_ID` in wrangler.jsonc with its real ID. Do not use V2's existing KV ID.
- Create Queue `vueo-smartsubs-translation` in the same account. The V2 producer binding remains `SMARTSUBS_TRANSLATION_QUEUE`.
- Configure runtime secret **SMARTSUBS_SECRET** on this Worker, as V2 does. Use a private random value and keep it stable. This is not the Gemini key.
- The existing `TranslationDeliveryRelay` class/binding and migration are declared in wrangler.jsonc for the new Worker.

No account-specific Cloudflare API token is committed or requested as a GitHub secret by this workflow. Cloudflare's own build authentication remains managed by its Git integration.

Official deployment reference: https://developers.cloudflare.com/workers/ci-cd/builds/configuration/

## API

See API.md. Existing configured routes `/c/TOKEN/translated/...vtt`, `/diagnose`, `/kv-monitor` and Queue delivery remain V2 routes. `/configure` also accepts JSON; `/v1/session` is a compatibility alias for the already supplied VUEO settings patch. It returns the existing V2 config token, not a new session system. `expiresAt` is a 30-day client renewal hint; V2 config tokens themselves are unchanged and have no server expiry.

The frontend settings patch can connect after this deployment. Passing provider subtitles to this API and adding returned AI tracks to the VUEO player still needs the player integration patch.

URL input accepts source headers. If a provider binds its URL to the device's IP/session, VUEO can download and upload the original VTT/SRT text. Translation still runs in Cloudflare. The adapter stores private source descriptors encrypted in the existing KV; it adds no new storage service. Source storage expires using V2's cache TTL. Request body limit is 2 MiB and at most 50 tracks; selection remains up to five English/AI sources.

## Validation

230 tests passed, including the inherited V2 suite and VUEO upstream/configuration/queue tests. Engine files and all runtime vars checked against the supplied V2 source. Live Cloudflare deployment, provider session access and live Gemini quota/model access have not been tested.
