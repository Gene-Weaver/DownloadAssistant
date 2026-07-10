/*
 * GBIF authentication provider for the download API.
 *
 * Reality (verified 2026-07-10 against a live logged-in session): GBIF's WEBSITE
 * login stores a JWT in a `token` cookie, but api.gbif.org REJECTS that token
 * (401) — the site creates downloads through its own backend, not by passing the
 * user's token to the API. So the webview login alone can't authorize downloads.
 *
 * Order of preference:
 *   1. A webview JWT — ONLY if it actually verifies against the API (kept in case
 *      GBIF ever accepts it; today it won't, so this is effectively inert).
 *   2. Basic username/password from a gitignored .env in the project root
 *      (GBIF_USER / GBIF_PASS / GBIF_EMAIL). This is the working path.
 *
 * Nothing is written to settings.json; the Authorization header is never logged.
 */

const fs = require('fs');
const path = require('path');
const { session } = require('electron');
const { decodeJwt, verifyAuth } = require('../server/gbif-download-api');

let webviewToken = null; // { token, exp(ms)|null, username, verified }

const isJwt = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/.test(v);

function setWebviewToken(token) {
  if (!token) { webviewToken = null; return status(); }
  if (webviewToken && webviewToken.token === token) return status(); // unchanged
  const p = decodeJwt(token) || {};
  webviewToken = {
    token,
    exp: p.exp ? p.exp * 1000 : null,
    username: p.userName || p.preferred_username || p.sub || p.name || null,
    verified: null, // unknown until verifyToken()
  };
  return status();
}
function clearWebviewToken() { webviewToken = null; return status(); }

function tokenPresent() {
  return !!(webviewToken && webviewToken.token && (!webviewToken.exp || webviewToken.exp > Date.now() + 30000));
}

// Confirm the token actually authorizes the API (GBIF's website token does not).
async function verifyToken() {
  if (!tokenPresent()) return false;
  if (webviewToken.verified != null) return webviewToken.verified;
  try {
    const v = await verifyAuth({ type: 'bearer', token: webviewToken.token, username: webviewToken.username });
    webviewToken.verified = !!v.ok;
  } catch (_) { webviewToken.verified = false; }
  return webviewToken.verified;
}

// Read the webview session cookies for a JWT and verify it (best-effort).
async function scanCookies() {
  if (tokenPresent() && webviewToken.verified != null) return status();
  try {
    const ses = session.fromPartition('persist:gbif');
    const cookies = await ses.cookies.get({ domain: 'gbif.org' });
    for (const ck of cookies) {
      const val = (() => { try { return decodeURIComponent(ck.value); } catch (_) { return ck.value; } })();
      const cand = isJwt(val) ? val : (val.match(/[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/) || [])[0];
      if (cand && decodeJwt(cand)) { setWebviewToken(cand); await verifyToken(); break; }
    }
  } catch (_) { /* best-effort */ }
  return status();
}

// Minimal .env reader (project root) — avoids adding the dotenv dependency.
function readEnv() {
  try {
    const txt = fs.readFileSync(path.join(__dirname, '..', '..', '.env'), 'utf8');
    const out = {};
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      out[m[1]] = v;
    }
    return out;
  } catch (_) { return {}; }
}

// { type:'bearer', … } (only if verified) | { type:'basic', … } | null
function getAuth() {
  if (tokenPresent() && webviewToken.verified === true) {
    return { type: 'bearer', token: webviewToken.token, username: webviewToken.username };
  }
  const env = readEnv();
  if (env.GBIF_USER && env.GBIF_PASS) return { type: 'basic', username: env.GBIF_USER, password: env.GBIF_PASS };
  return null;
}

function getCreator() { const a = getAuth(); return a ? a.username || null : null; }
function getEmail() { return readEnv().GBIF_EMAIL || readEnv().GBIF_USER || null; }

function status() {
  const a = getAuth();
  // Signal when a webview login exists but the API won't accept it (→ use .env).
  const webviewOnly = !a && tokenPresent();
  return { available: !!a, method: a ? a.type : null, username: a ? a.username || null : (webviewToken ? webviewToken.username : null), webviewRejected: webviewOnly };
}

module.exports = {
  setWebviewToken, clearWebviewToken, getAuth, getCreator, getEmail, status, scanCookies, verifyToken,
};
