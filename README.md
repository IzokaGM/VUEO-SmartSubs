# Shared SmartSubs translation result cache
Based on backend VUEO-SmartSubs-main (3). Copy the included src and scripts files into your backend, or apply CHANGES.diff. Then deploy using your existing Worker workflow. No app update or new binding is required.

Shared result identity includes normalized exact subtitle text/timing, media, source language and fixed target msa. Model and SMARTSUBS_CACHE_VERSION remain part of the final key. Session owner is excluded ONLY from result identity. Encrypted source records and authorization remain owner-scoped. Queue and prefetch resolve the same canonical shared identity before cache access.

On a shared miss, the selected GET can reuse this authenticated session owner's legacy content cache entry, and promote it into shared cache. Other historical owners cannot be discovered automatically: opening the subtitle once using its old configuration can seed the shared cache. Otherwise the first request may still generate once. No blanket historical migration is claimed.

Prompt behavior is unchanged. Keep SMARTSUBS_CACHE_VERSION updated when deploying incompatible prompt changes. Existing token URLs and private source TTL behavior remain; downloading the original selected subtitle may still be needed to compute content identity even on a translation HIT. This does not mean Gemini ran again.

Tests use mocked KV/Queue/fetch. Different API keys share translated output with network/Gemini disabled; source ownership remains protected; legacy promotion succeeds; changed text/timing/episode/model/version remain separate; queue uses the canonical identity. No live deployment or TV/mobile end-to-end verification performed.
