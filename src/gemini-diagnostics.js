'use strict'

// Incoming metadata is not the outbound IP Google sees. Never label it as egress.
function geminiRequestContext(request) {
  const clean = (value, pattern) => pattern.test(String(value || '')) ? String(value) : null
  return {
    ingressColo: clean(request.cf?.colo, /^[A-Z]{3}$/),
    clientCountry: clean(request.cf?.country, /^[A-Z]{2}$/),
    placement: clean(request.headers.get('cf-placement'), /^[a-zA-Z0-9_:;=., -]{1,96}$/),
    googleObservedEgress: 'unknown',
    note: 'Ingress/client metadata does not prove the outgoing IP or country Google detected. Fetch checks do not test Queue execution.'
  }
}

function renderGeminiDiagnostics(model) {
  const safeModel = String(model || '').slice(0, 100)
  const script = `(() => {
    const model = ${JSON.stringify(safeModel).replace(/</g, '\\u003c')};
    const input = document.getElementById('key');
    const button = document.getElementById('run');
    const output = document.getElementById('result');
    function clean(value, key) {
      return String(value || '').split(key).join('[redacted]')
        .replace(/AIza[A-Za-z0-9_-]+/g, '[redacted]')
        .replace(/https?:\\/\\/\\S+/gi, '[URL redacted]').slice(0, 300);
    }
    async function check(url, options, key, worker) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 25000);
      try {
        const response = await fetch(url, {...options, signal: controller.signal, cache: 'no-store', credentials: 'omit', redirect: 'error'});
        const body = await response.json().catch(() => ({}));
        return worker ? {ok: response.ok, http: response.status,
          errorCode: body.errorCode || null, reason: body.errorReason || null,
          upstreamStatus: body.upstreamStatus || null, apiStatus: body.upstreamApiStatus || null,
          detail: clean(body.errorDetail || body.error, key), requestContext: body.requestContext || null} :
          {ok: response.ok, http: response.status, apiStatus: body.error?.status || null,
           detail: clean(body.error?.message, key)};
      } catch (error) {
        return {ok: false, http: null, detail: error.name === 'AbortError' ? 'Timed out.' :
          'Browser/network/CORS failure. This does not establish a Gemini regional rejection.'};
      } finally { clearTimeout(timer); }
    }
    button.addEventListener('click', async () => {
      const key = input.value.trim();
      if (key.length < 20 || key.length > 256 || /[\\r\\n\\0]/.test(key)) { output.textContent = 'Enter a valid Gemini API key.'; return; }
      button.disabled = true; input.disabled = true; output.textContent = 'Checking both paths…';
      try {
        const worker = await check('/v1/gemini/diagnose', {method: 'POST',
          headers: {'content-type': 'application/json'}, body: JSON.stringify({geminiApiKey: key})}, key, true);
        const direct = await check('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent',
          {method: 'POST', headers: {'content-type': 'application/json', 'x-goog-api-key': key},
           body: JSON.stringify({contents: [{parts: [{text: 'Reply with OK.'}]}], generationConfig: {maxOutputTokens: 4}})}, key, false);
        let conclusion;
        if (worker.ok && direct.ok) conclusion = 'Both paths succeeded now. Previous failure may be intermittent.';
        else if (!worker.ok && direct.ok) conclusion = 'Only the Worker path failed. If the error is regional, investigate its outbound route/IP classification. This does not identify an exact exit IP.';
        else if (worker.ok && !direct.ok) conclusion = 'Worker succeeded. Investigate browser/network restrictions for the direct path.';
        else conclusion = 'Both checks failed. Compare exact errors; account/project eligibility or separate network issues remain possible.';
        output.textContent = JSON.stringify({model, checkedAt: new Date().toISOString(), worker, browserDirect: direct, conclusion,
          queueTested: false}, null, 2);
      } finally { input.value = ''; input.disabled = false; button.disabled = false; }
    });
  })();`
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>VUEO Gemini connection check</title><style>:root{color-scheme:dark}body{margin:0;background:#101116;color:#f4f4f5;font:16px system-ui,sans-serif}main{max-width:760px;margin:auto;padding:24px 18px}.card{padding:20px;border:1px solid #30333d;border-radius:16px;background:#181a21}input,button{box-sizing:border-box;width:100%;padding:14px;border-radius:10px;margin:8px 0;font:inherit}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;line-height:1.5}p{line-height:1.5;color:#b8bbc4}a{color:#c9ffdc}</style></head><body><main><a href="/diagnose">Back to diagnostics</a><h1>Gemini connection check</h1><section class="card"><p>Compare the same key and model through this Worker and directly from your browser. Each run makes two small Gemini generation requests and uses your quota.</p><p>The key is used only for these checks, is not saved, and is cleared from the field afterwards. Results contain no key or session token.</p><label for="key">Your Gemini API key</label><input id="key" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="256"><button id="run" type="button">Run both checks</button><pre id="result" aria-live="polite">No check run.</pre><p>Location metadata describes the incoming request. It cannot confirm the outgoing IP seen by Google. Queue translation is not tested by this page.</p></section></main><script>${script}</script></body></html>`
  return {html, script}
}

module.exports = { geminiRequestContext, renderGeminiDiagnostics }
