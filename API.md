# VUEO-SmartSubs API v1

All production requests use HTTPS. Bodies are JSON. No Gemini keys go in URLs. The backend uses one user's encrypted session per account/key.

## 1. Register the user's key

`POST /v1/session`

```json
{"geminiApiKey":"USER_GEMINI_KEY"}
```

Returns HTTP 201:

```json
{"token":"ENCRYPTED_SESSION_TOKEN","expiresAt":1800000000000,"model":"gemini-3.5-flash-lite"}
```

This checks real Gemini model access and uses a small validation request. Store the returned token securely. Renew after expiry or key/model changes. There is no shared Gemini key and no account/login database in this version.

## 2. Submit a translation

`POST /v1/jobs`

Header: `Authorization: Bearer ENCRYPTED_SESSION_TOKEN`

Preferred first test (text upload):

```json
{
  "sourceLanguage":"en",
  "targetLanguage":"ms",
  "sourceId":"provider:episode:english-track-id",
  "media":{"type":"series","id":"80539:1:1"},
  "source":{"text":"WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHello.\n"}
}
```

URL variant, after configuring approved hosts:

```json
{
  "sourceLanguage":"en",
  "targetLanguage":"ms",
  "sourceId":"provider:episode:english-track-id",
  "media":{"type":"series","id":"80539:1:1"},
  "source":{
    "url":"https://approved.example.com/english.vtt",
    "headers":{"Referer":"https://approved.example.com/"}
  }
}
```

Provide exactly one of source.text or source.url. Maximum decoded subtitle size: 1 MiB. Maximum JSON request body: 2 MiB. VTT/SRT use the inherited parser; ASS/SSA is converted to VTT by the new server input adapter first; video, OCR and burned-in captions are not inputs. The caller must identify the source as English; language detection is not added here.

Use media.type `movie` or `series`. Include the specific episode in media.id for series. Source ID is metadata/cache identity, not a subtitle file URL. The result is one Malay VTT track for that chosen source; VUEO decides which English source to submit.

Returns HTTP 202 for queued/running or 200 for cached/ready:

```json
{"jobId":"64_HEX_DIGITS","status":"queued","attempts":0,"createdAt":1800000000000,"pollAfterMs":3000}
```

## 3. Poll status

`GET /v1/jobs/JOB_ID`

Header: `Authorization: Bearer ENCRYPTED_SESSION_TOKEN`

States: queued, running, ready, failed. Poll no faster than pollAfterMs. Stop polling after ready/failed; resume explicitly as needed. Another user's session receives HTTP 403.

Ready response adds:

```json
{
  "resultUrl":"https://WORKER_HOST/v1/jobs/JOB_ID/result.vtt?ticket=SIGNED_RESULT_TICKET",
  "language":"ms",
  "mimeType":"text/vtt",
  "pollAfterMs":0
}
```

## 4. Give the result URL to the player

`GET resultUrl` returns `text/vtt; charset=utf-8`.

The ticket authorizes only that job for one hour. No Authorization header is needed for this signed result URL. Treat it as a temporary secret and omit it from logs. Status requests issue a fresh result URL while the job remains available. No placeholder/empty VTT is returned while translation is running.

## Errors and retries

Error body: `{"error":{"code":"CODE","message":"Safe explanation"}}`.
Failed-job status contains an error with the same code/message shape. No raw Gemini body, subtitle text, key, cookie or signed URL appears in application logs.

- INVALID_SESSION / SESSION_EXPIRED: register the user's key again.
- GEMINI_HTTP_429: user quota/rate limit; respect waiting and retry.
- GEMINI_HTTP_400/401/403: key/model/account access problem.
- SOURCE_HOST_NOT_ALLOWED: configure the host or use source.text upload.
- SOURCE_HTTP_ERROR: upstream rejected/expired URL; fetch a fresh source or upload.
- NO_TIMED_CUES: unsupported or invalid subtitle contents.
- RESULT_NOT_READY: wait for the status endpoint to return ready.
- JOB_NOT_FOUND / RESULT_EXPIRED: submit again; cache can still reuse the completed translation.

Health: `GET /health`. This checks backend bindings/configuration, not a specific user's key or provider availability.
