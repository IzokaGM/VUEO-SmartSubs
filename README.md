# VUEO SmartSubs

**On-demand English-to-Malay subtitle translation for VUEO, powered by Gemini and Cloudflare Workers.**

VUEO SmartSubs takes subtitle tracks supplied by VUEO plugins, offers Bahasa Melayu Malaysia AI tracks, and translates the selected source when requested. It adapts the SmartSubsV2 translation engine to VUEO's provider-based subtitle flow, retaining its chunking, retries, queue processing, cache, and delivery relay.

This repository contains the backend. A compatible VUEO client must submit provider tracks, display the returned choices, and handle translation preparation before loading the final WebVTT subtitle.

## Contents

- [Features](#features)
- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Setup and deployment](#setup-and-deployment)
- [API quick start](#api-quick-start)
- [Configuration](#configuration)
- [Diagnostics and troubleshooting](#diagnostics-and-troubleshooting)
- [Development](#development)
- [Repository layout](#repository-layout)
- [Applying ZIP patches](#applying-zip-patches)
- [Security and limitations](#security-and-limitations)

## Features

- **Malaysian Malay translation:** English subtitle dialogue translated through Gemini, with contextual phrasing and consistent tone.
- **Bring your own key (BYOK):** each user supplies their own Gemini API key through the configuration API.
- **Provider subtitle input:** accepts public HTTPS subtitle URLs with supported request headers, or uploaded VTT/SRT text.
- **Worker-owned source selection:** filters eligible English tracks, prioritises plugin sources, removes duplicates, and offers up to five AI choices.
- **On-demand generation:** listing tracks does not download or translate subtitle sources.
- **Asynchronous processing:** Cloudflare Queues, adaptive chunks, retries, and a Durable Object delivery relay support translation requests.
- **Content-based caching:** equivalent subtitle content can reuse translation results independently of changing provider URLs or display metadata.
- **Diagnostics:** configuration-scoped translation diagnostics, KV monitoring, and a Gemini connection checker.

## How it works

1. The client submits the user's Gemini key and receives an encrypted configuration token.
2. The client forwards provider subtitle tracks for a movie or episode.
3. The Worker returns subtitle choices, including eligible on-demand Malay AI tracks.
4. When the viewer selects an AI track, the client requests its translated-subtitle URL.
5. The backend checks its cache and, when needed, fetches and parses the source, processes translation chunks, and returns the resulting WebVTT.

The player must support the backend's preparation and retry responses. Discovery is not a guarantee that a translated file is already ready.

## Requirements

- A Cloudflare account with Workers, KV, Queues, and Durable Objects available.
- A Gemini API key with access to the configured model, available quota, and a supported request location.
- Node.js and npm for local checks and Wrangler. The repository's CI uses **Node.js 24**.
- A compatible VUEO client integration.

The configured model in `wrangler.jsonc` is `gemini-3.5-flash-lite`. Model access must be verified for the user's key and deployment; the configuration alone does not establish availability.

## Setup and deployment

### 1. Install dependencies

From the repository root:

```sh
npm ci --ignore-scripts
```

### 2. Configure Cloudflare resources

Use dedicated resources for this project rather than sharing a SmartSubsV2 installation's resources.

| Resource | Binding or name | Setup |
| --- | --- | --- |
| Worker | `vueo-smartsubs` | Keep the Worker name aligned with `wrangler.jsonc`. |
| KV namespace | `SMARTSUBS_CACHE` | Set `kv_namespaces[].id` to the namespace ID for your account. |
| Queue | `vueo-smartsubs-translation` | Create this queue; producer and consumer declarations are included. |
| Queue producer | `SMARTSUBS_TRANSLATION_QUEUE` | Keep the declared binding name. |
| Durable Object | `SMARTSUBS_DELIVERY` | Uses `TranslationDeliveryRelay`; the binding and migration are included. |
| Rate limiters | `SMARTSUBS_SUBTITLE_LIMITER`, `SMARTSUBS_GENERATE_LIMITER` | Keep the rate-limit bindings declared in the configuration. |

The checked-in KV ID is account-specific. Replace it when deploying to another account.

### 3. Set the runtime secret

Set **`SMARTSUBS_SECRET`** in the Worker's secret settings to a strong private random value. Keep it stable: configuration and translation tokens depend on it.

This is the backend's encryption/signing secret, separate from each user's Gemini API key. Do not commit either secret to the repository.

### 4. Deploy through Cloudflare

Connect the repository through Cloudflare's Git integration:

| Setting | Value |
| --- | --- |
| Root directory | Repository root |
| Dependency installation | Use the committed `package-lock.json` |
| Deploy command | `npx wrangler deploy` |
| Worker entry point | `src/cloudflare-worker.mjs` |

Cloudflare manages deployment authentication for its Git integration. The repository's apply-patch and CI workflows handle repository updates and validation; they do not deploy the Worker.

### 5. Verify the deployment

- Request `GET /health` to check that the Worker responds.
- Open `/diagnose/gemini` to test Gemini connectivity with your key.
- Complete an end-to-end subtitle request from the VUEO client.

A health response or successful key check does not verify queue processing or full subtitle translation.

## API quick start

Replace `YOUR_WORKER_HOST` and `CONFIG_TOKEN` below with your deployment values. Examples contain placeholders only.

### Configure a user's key

```http
POST https://YOUR_WORKER_HOST/configure
Content-Type: application/json
```

```json
{
  "geminiApiKey": "YOUR_GEMINI_API_KEY"
}
```

A successful request returns HTTP `201` with `token`, `model`, `configuredBaseUrl`, and `expiresAt`. `/v1/session` is a compatibility alias for the same operation.

Store the token securely. `expiresAt` is a client renewal hint; the existing configuration token has no server-enforced expiry.

### Submit provider subtitles

```http
POST https://YOUR_WORKER_HOST/c/CONFIG_TOKEN/subtitles
Content-Type: application/json
```

```json
{
  "media": {
    "type": "series",
    "id": "tmdb:80539:1:1"
  },
  "subtitles": [
    {
      "id": "plugin:english",
      "lang": "en",
      "providerId": "example-plugin",
      "providerName": "Example Plugin",
      "url": "https://provider.example/subtitles/episode-1.vtt"
    }
  ]
}
```

Each track must contain exactly one of `url` or `text`. To upload the source directly, replace `url` with the complete VTT/SRT content in `text`. Supply a media ID that uniquely identifies the movie or episode, including season and episode for series.

The request accepts up to **50 tracks** within a **2 MiB** request body. Clients should supply known language metadata; automatic language detection is not provided.

### Load a subtitle choice

Use the returned track URL directly rather than constructing tokens or matching tracks by array position:

| Route | Purpose |
| --- | --- |
| `/c/CONFIG_TOKEN/translated/TRANSLATION_TOKEN.vtt` | Request an on-demand Malay AI subtitle. |
| `/c/CONFIG_TOKEN/source/SOURCE_HASH` | Proxy an original source track for the same configuration. |

Use returned display and source metadata to label choices. Handle preparation/retry responses before loading the ready VTT into the player.

See [API.md](API.md) for supported source headers, addon-source selection, metadata fields, and diagnostic response details.

## Configuration

Runtime bindings and tuning values are defined in [wrangler.jsonc](wrangler.jsonc).

| Setting | Purpose | Checked-in value |
| --- | --- | --- |
| `GEMINI_MODEL` | Gemini translation model | `gemini-3.5-flash-lite` |
| `SMARTSUBS_CACHE_VERSION` | Translation cache version | `m8-v1` |
| `SMARTSUBS_CACHE_TTL_MS` | Cache lifetime | `15552000000` (180 days) |
| `TRANSLATION_CHUNK_ITEMS` | Default cue limit per translation chunk | `180` |
| `TRANSLATION_CHUNK_CHARS` | Default character limit per chunk | `24000` |
| `TRANSLATION_CONCURRENCY` | Default concurrent translation calls | `2` |

Queue-specific profiles have their own limits, concurrency, wait periods, and retry settings. See the configuration and Worker implementation before tuning them.

The translation prompt is built by `buildIndexedPrompt()` in [src/translator.js](src/translator.js). Changing the prompt does not automatically invalidate existing cached translations. Use an uncached subtitle when evaluating prompt changes, or deliberately change the cache version when a broader cache refresh is intended.

## Diagnostics and troubleshooting

| Endpoint | Purpose |
| --- | --- |
| `/health` | Worker health response. |
| `/diagnose/gemini` | Browser page comparing Worker and direct-browser Gemini checks. |
| `/c/CONFIG_TOKEN/diagnose` | Diagnostics scoped to a configuration. |
| `/c/CONFIG_TOKEN/kv-monitor` | KV monitoring scoped to a configuration. |

A Gemini comparison run makes two small generation requests and consumes quota. It does not create a configuration token. See [API.md](API.md) for diagnostic privacy and interpretation details.

| Symptom | What to check |
| --- | --- |
| Gemini key validation fails | Key access, model availability, quota, and request-location restrictions. |
| Browser Gemini check succeeds but Worker check fails | Worker outbound-route restrictions; incoming Cloudflare location metadata does not prove the outbound location. |
| Provider subtitle cannot be fetched | Required allowed headers, URL expiry, and device/IP/session restrictions. Upload source text from the client when necessary. |
| Translation remains pending | Queue bindings, consumer failures, diagnostics, and client retry handling. |
| Prompt changes appear to have no effect | Whether the selected subtitle is served from an existing translation cache entry. |
| No AI choices appear | Source language/format metadata, duplicate filtering, and addon-source selection settings. |

## Development

```sh
npm run check
npm test
```

`check` validates JavaScript syntax. `test` runs the Node.js test files in `scripts/`, covering Gemini diagnostics, source selection/display, metadata flow, and content-cache behaviour.

These checks do not replace live verification of Cloudflare resources, provider access, Gemini quota, or VUEO playback.

## Repository layout

| Path | Responsibility |
| --- | --- |
| `src/cloudflare-worker.mjs` | HTTP routes, queue processing, and delivery orchestration. |
| `src/vueo-upstream.mjs` | Provider source input, selection, storage, and display metadata. |
| `src/translator.js` | Subtitle parsing, preprocessing, translation prompt, and Gemini translation pipeline. |
| `src/cf-cache.mjs` | Cloudflare-backed translation caching. |
| `src/configure.js`, `src/user-config.js`, `src/token.js` | Configuration UI, encrypted user configuration, and tokens. |
| `src/diagnostics.js`, `src/gemini-diagnostics.js` | Translation and Gemini diagnostic pages. |
| `src/kv-monitor.mjs`, `src/kv-usage.mjs` | KV monitoring and usage tracking. |
| `scripts/` | Syntax validation, automated tests, and usage reporting. |
| `.github/workflows/` | ZIP patch application, CI, and Gemini diagnostic workflow. |
| `docs/` | Recovery analysis and SmartSubsV2 reference documentation. |
| `API.md` | Detailed VUEO API contract. |
| `wrangler.jsonc` | Cloudflare runtime, resources, and tuning. |

## Applying ZIP patches

The repository includes **VUEO SmartSubs - Apply ZIP Patch**:

1. Upload a patch ZIP to the repository root on `main`.
2. Keep repository-relative paths inside the archive, such as `src/translator.js` or `README.md`.
3. The workflow validates and stages the archive, runs its checks, commits the applied changes, and removes the processed ZIP.
4. The CI workflow performs follow-up validation after a successful patch run.

Partial patches should contain only intended changes. The `.smartsubsv2-full-snapshot` marker is reserved for a complete repository snapshot; do not add it to an ordinary patch. The apply workflow protects paths such as `.github`, `.git`, and environment files.

## Security and limitations

- Configuration tokens and configured URLs are sensitive. Avoid exposing them in logs, screenshots, or public issues.
- Provider source descriptors are stored encrypted in KV. Supported headers can include credentials; handle them as secrets.
- URL sources must use public HTTPS hostnames. Private/IP URLs are rejected, and cookies/Authorization are stripped on cross-origin redirects.
- This fork uses provider-supplied tracks. The legacy GET subtitle-discovery route returns an empty list instead of discovering OpenSubtitles sources.
- `/v1/jobs` from the superseded backend is not supported.
- The backend does not include the VUEO player or its frontend integration.
- AI translation can contain errors. Review representative dialogue when changing the model or prompt.

Built on the SmartSubsV2 translation engine, adapted for VUEO provider subtitles. Historical implementation notes are available in [docs/](docs/).
