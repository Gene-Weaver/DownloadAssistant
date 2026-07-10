/*
 * Tier-1 image fetch: a plain headless HTTP GET (full resolution).
 *
 * Many institution hosts (Symbiota/SERNEC — a large share of US herbaria) don't
 * bot-block server-side requests, so most images download here, fast and at high
 * concurrency, never touching the webview.
 *
 * Failures are CLASSIFIED (one attempt, no retries here — the caller decides
 * what to do next and logs it):
 *   kind 'broken'    — dead link (DNS ENOTFOUND, 410 Gone). Nothing helps; the
 *                      caller marks it broken so we never waste time on it again.
 *   kind 'blocked'   — looks bot-blocked (401/403/404/429/503, an HTML page
 *                      instead of an image, a suspiciously tiny body). The caller
 *                      routes it to the webview (which has the browser session).
 *   kind 'transient' — timeout / 5xx / network blip. Marked failed; retry later.
 * Each error also carries .status (HTTP) and .outcome (for the fetch_log).
 */

const TIMEOUT_MS = 25000;
const MAX_BYTES = 80 * 1024 * 1024;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch (_) { return 'unknown'; }
}

function fetchError(kind, outcome, status, message) {
  const e = new Error(message);
  e.kind = kind; e.outcome = outcome; e.status = status != null ? status : null;
  return e;
}

// Some GBIF media links point at an HTML VIEWER page, not the raw image. Rewrite
// the known ones to their real full-resolution image URL so the fast direct path
// downloads them (these hosts aren't bot-blocked — the link just isn't the image).
// Returns a rewritten URL or null (leave as-is). Extend per host as we find them.
function resolveLandingUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    // sdplantatlas OpenSeadragon viewer:
    //   /HiResDisplay/HiResZoomDisplay.aspx?H=2930
    //   -> /Synoptic1/HighResDownload/H2930.jpg
    if (host === 'sdplantatlas.org' && /HiResZoomDisplay\.aspx/i.test(u.pathname)) {
      const h = u.searchParams.get('H');
      if (h && /^\d+$/.test(h)) return `https://sdplantatlas.org/Synoptic1/HighResDownload/H${h}.jpg`;
    }
  } catch (_) { /* not a parseable URL */ }
  return null;
}

// HTTP status -> classification.
function classify(status) {
  // 404/410 = the file isn't there. The webview hits the SAME url and 404s too,
  // so treat it as broken (never retry) — e.g. BRY's ~320k dead *_lg.jpg urls.
  if (status === 410 || status === 404) return 'broken';
  if ([401, 403, 429, 503].includes(status)) return 'blocked';
  return 'transient'; // other 4xx/5xx
}

// Returns a Buffer of image bytes, or throws a classified error (one attempt).
async function tryDirect(url) {
  const target = resolveLandingUrl(url) || url; // rewrite known viewer-page links
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    let res;
    try {
      res = await fetch(target, {
        headers: { 'User-Agent': UA, Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8' },
        redirect: 'follow',
        signal: ctl.signal,
      });
    } catch (e) {
      if (e && e.name === 'AbortError') throw fetchError('transient', 'timeout', null, 'timeout');
      const code = (e && (e.code || (e.cause && e.cause.code))) || '';
      if (code === 'ENOTFOUND') throw fetchError('broken', 'broken', null, 'DNS: host not found');
      throw fetchError('transient', 'error', null, code || (e && e.message) || 'network error');
    }
    if (!res.ok) {
      const outcome = [401, 403, 429, 503].includes(res.status) ? 'blocked' : ((res.status === 410 || res.status === 404) ? 'broken' : 'http_error');
      throw fetchError(classify(res.status), outcome, res.status, `http ${res.status}`);
    }
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (!ct.includes('image/') || ct.includes('svg')) throw fetchError('blocked', 'not_image', res.status, `not-an-image (${ct || 'no content-type'})`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) throw fetchError('error', 'error', res.status, 'image exceeds size limit');
    if (buf.length < 512) throw fetchError('blocked', 'not_image', res.status, 'suspiciously small response');
    return buf;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { tryDirect, hostOf, resolveLandingUrl };
