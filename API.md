# VUEO upstream API

## Key entry

POST `/configure` with `Content-Type: application/json`:

```json
{"geminiApiKey":"EACH_USERS_OWN_KEY"}
```

`/v1/session` is an alias for compatibility with the VUEO settings patch. Response 201 contains `token`, `model`, `configuredBaseUrl`, `expiresAt` (client renewal hint). The token is exactly the existing V2 encrypted config token. Store it securely; configured URLs contain it and must not be logged. Validation uses V2's tiny Gemini key/model test.

## Provider subtitle input

POST `/c/TOKEN/subtitles` with JSON:

```json
{
  "media":{"type":"series","id":"tmdb:80539:1:1"},
  "subtitles":[
    {"id":"provider:english","lang":"en","url":"https://provider.example/english.vtt","headers":{"Referer":"https://provider.example/"}},
    {"id":"provider:uploaded","lang":"eng","text":"WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello\n"}
  ]
}
```

Each track has exactly one `url` or `text`. Provide its known language; language detection is not added. Media id must uniquely identify the episode (for series include season/episode). URL must use a public HTTPS hostname. Supports Referer, Origin, User-Agent, Authorization, Cookie, Accept, Accept-Language. Private/IP URLs are rejected and cookies/Authorization are stripped on cross-origin redirects. VTT/SRT parser remains V2's parser.

Response uses V2's subtitle-list shape: native Malay when supplied, up to five on-demand Malay AI tracks, and up to five English tracks. No translation or provider download occurs during discovery. The private source URL/header/text is stored encrypted in the existing KV; returned delivery URLs do not expose them.

Selecting a Malay AI track fetches its `/c/TOKEN/translated/TRANSLATION_TOKEN.vtt` URL. Existing V2 queue/selection, retry, join/wait, delivery relay, cache and preparing-response behavior apply. The queue message remains V2's opaque config/translation-token payload. VUEO player integration must handle the existing pending/retry response before adding the ready VTT track.

Native/English proxy delivery uses `/c/TOKEN/source/SOURCE_HASH`, bound to the same configuration. Source headers stay in backend storage. VUEO can keep its original plugin subtitle tracks too.

Old GET `/c/TOKEN/subtitles/movie-or-series/id.json` returns an empty list in this fork; it no longer discovers OpenSubtitles. Use the POST input above. `/v1/jobs` from the superseded backend is not supported.


## Gemini location diagnostics

Open `/diagnose/gemini` in a browser. On explicit user action it performs two tiny generation checks with the same BYOK key/model: `POST /v1/gemini/diagnose` and a direct browser request to Google's Gemini API. This consumes quota. The key is not persisted and the UI clears its field after completion. Results exclude generated content, credentials and session tokens.

`POST /v1/gemini/diagnose` accepts the same JSON key input as `/v1/session`, requires the existing server secret and uses the existing configuration limiter. On successful validation it returns HTTP 200 with `ok`, `model`, and `requestContext`, without creating a config token. Errors use the existing sanitized validation response.

Existing `/v1/session` keeps its HTTP 201/token contract. Gemini validation failures keep existing app-compatible `errorCode` values, with additive `errorReason` and `requestContext`. Regional precondition errors report `GEMINI_LOCATION_UNSUPPORTED` as the reason. The log event `VUEO_GEMINI_VALIDATION_FAILED` contains classifications and incoming location metadata only; no key, token, prompt or raw Google response is logged.

`ingressColo` and `clientCountry` describe incoming metadata. `placement` is the incoming `cf-placement` header when available. These are not independently verified egress evidence. `googleObservedEgress` is explicitly `unknown`. No extra IP lookup is made. Fetch checks do not validate Queue placement or translation.

Worker-only regional rejection is evidence to investigate the Worker outbound route/IP classification, not proof of an exact egress location. Browser CORS/network failures are inconclusive. Placement, translation, Queue, chunking, retries and cache behavior are unchanged by this patch.


## Worker-owned source selection and display metadata

`POST /c/<token>/subtitles` accepts up to 50 source records plus
`includeAddonSources` (boolean, default false). New clients supply the original
`lang`, `providerId`, `providerName`, optional `mimeType` and optional existing
`displayId`, alongside `id` and exactly one of `url` or `text`. URL headers retain
the existing allowlist. Clients may forward originals without filtering by language.
The worker filters English VTT/SRT candidates, prioritizes plugins, removes
duplicates and limits AI choices to five. Legacy clients without providerId
retain their preselected-input behavior. Listing does not download or translate.

AI records carry `id`, `url`, `lang`, `name`, `providerName`, `mimeType`,
`displayId`, `sourceId`, `sourceDisplayId` and `sourceProviderName`.
`sourceId` identifies the original supplied source; the worker prepares
`displayId` as `Provider - English display ID`. Consumers read these fields
directly and never match response records by array position.
The addon GET response also carries prepared display metadata.
Internal IDs, signed translation tokens and translation cache keys retain
their existing identity; display metadata is not included in their hash.
