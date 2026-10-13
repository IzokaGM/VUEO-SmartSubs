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
