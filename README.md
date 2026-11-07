# VUEO SmartSubs

**AI-powered Bahasa Melayu Malaysia subtitles for VUEO.**

SmartSubs is VUEO's subtitle translation backend. It uses Gemini to translate English subtitle tracks supplied by VUEO plugins into natural Malaysian Malay, on demand.

This project is built specifically for VUEO and works through its subtitle selection flow.

## Features

- **Malaysian Malay subtitles** — contextual translation that preserves the dialogue's meaning and tone.
- **Your own Gemini key** — connect using your personal Gemini API key.
- **Plugin subtitle support** — translates eligible English tracks provided through VUEO.
- **On-demand translation** — translation starts when an AI subtitle track is selected.
- **Cached results** — reuses available translations to avoid unnecessary processing.
- **Multiple source choices** — offers up to five eligible AI subtitle options.

## Using SmartSubs in VUEO

With a compatible VUEO integration:

1. Open **VUEO → Enhancements → Gemini** and connect your Gemini API key.
2. Open a movie or episode with an eligible English subtitle source.
3. Select a **Malay AI** subtitle option.
4. Allow the translation to finish before playback displays the translated subtitles.

Available tracks depend on the subtitles supplied by the plugins. Translation requires a valid Gemini key with model access and available quota.

## About this repository

This repository contains the Cloudflare Workers backend for VUEO SmartSubs, built on the SmartSubsV2 translation engine. It handles subtitle sources, Gemini translation, caching, background processing, and delivery to VUEO.

For the client integration contract, see [API.md](API.md).

## Development

```sh
npm ci --ignore-scripts
npm run check
npm test
```
