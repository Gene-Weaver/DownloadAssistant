/*
 * Tier-1 image fetch: a plain headless HTTP GET (full resolution).
 *
 * Many institution hosts (Symbiota/SERNEC — a large share of US herbaria) do
 * NOT bot-block server-side requests, so most images download here, fast and at
 * high concurrency, never touching the webview. Hosts that DO block (return 403
 * or an HTML "rejected" page) throw with `.blocked = true`, and the caller routes
 * those to the webview downloader (tier 2), which uses the real browser session.
 */

const TIMEOUT_MS = 25000;
const MAX_BYTES = 80 * 1024 * 1024;
// A normal browser UA — some hosts 403 non-browser agents (and the Electron token).
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch (_) { return 'unknown'; }
}

function blocked(msg) { const e = new Error(msg); e.blocked = true; return e; }

// Returns a Buffer of image bytes, or throws. e.blocked === true means "the host
// rejected a headless fetch — try the webview".
async function tryDirect(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8' },
      redirect: 'follow',
      signal: ctl.signal,
    });
    if (!res.ok) {
      // 403/401/429/503 look like bot-blocking → webview may still succeed.
      if ([401, 403, 429, 503].includes(res.status)) throw blocked(`http ${res.status}`);
      throw new Error(`http ${res.status}`); // 404/5xx → genuine failure, retry/fail
    }
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (!ct.includes('image/') || ct.includes('svg')) throw blocked(`not-an-image (${ct || 'no content-type'})`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) throw new Error('image exceeds size limit');
    if (buf.length < 512) throw blocked('suspiciously small response');
    return buf;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { tryDirect, hostOf };
