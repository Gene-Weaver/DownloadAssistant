/*
 * GBIF occurrence-download API client.
 *
 * The ONE authenticated part of the pipeline: CREATE a download (POST predicate)
 * and cancel one. Polling status and fetching the zip are PUBLIC (no auth).
 *
 * Auth is pluggable so we can use either a Bearer JWT lifted from the webview
 * login (preferred — no stored password) or Basic username:password from a
 * gitignored .env. `auth` is { type:'bearer', token } | { type:'basic', username, password }.
 */

const fs = require('fs');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const API = 'https://api.gbif.org/v1';

function authHeader(auth) {
  if (!auth) return null;
  if (auth.type === 'bearer' && auth.token) return `Bearer ${auth.token}`;
  if (auth.type === 'basic' && auth.username) {
    return `Basic ${Buffer.from(`${auth.username}:${auth.password || ''}`).toString('base64')}`;
  }
  return null;
}

// Decode a JWT payload (no verification) — used to read the GBIF username the
// download `creator` field needs when we only have a webview Bearer token.
function decodeJwt(token) {
  try {
    const seg = String(token).split('.')[1];
    const json = Buffer.from(seg.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json);
  } catch (_) { return null; }
}

// POST the download request. Returns the download KEY (plain text) on 201.
async function createDownload(body, auth) {
  const h = authHeader(auth);
  if (!h) throw new Error('GBIF login required to create a download.');
  const res = await fetch(`${API}/occurrence/download/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: h },
    body: JSON.stringify(body),
  });
  if (res.status === 201 || res.status === 200) return (await res.text()).trim();
  if (res.status === 401 || res.status === 403) throw new Error('GBIF authentication failed — check your login / token.');
  if (res.status === 420) { const e = new Error('GBIF is throttling downloads (too many running). Retrying shortly.'); e.retryable = true; throw e; }
  const txt = await res.text().catch(() => '');
  throw new Error(`GBIF download request failed (${res.status}). ${txt.slice(0, 300)}`);
}

// Poll status (public, no auth). Returns the status JSON (status/doi/downloadLink/…).
async function pollDownload(key) {
  const res = await fetch(`${API}/occurrence/download/${encodeURIComponent(key)}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Download status poll failed (${res.status}).`);
  return res.json();
}

// Cancel/kill a running download (auth).
async function cancelDownload(key, auth) {
  const h = authHeader(auth);
  if (!h) return { ok: false, reason: 'no-auth' };
  const res = await fetch(`${API}/occurrence/download/${encodeURIComponent(key)}`, { method: 'DELETE', headers: { Authorization: h } });
  return { ok: res.ok, status: res.status };
}

// Best-effort credential check. For basic we hit the user's download list; for
// bearer we read the username from the JWT and do the same.
async function verifyAuth(auth) {
  const h = authHeader(auth);
  if (!h) return { ok: false, reason: 'no-credentials' };
  let username = auth.username;
  if (!username && auth.type === 'bearer') {
    const p = decodeJwt(auth.token);
    username = p && (p.userName || p.preferred_username || p.sub || p.name);
  }
  if (!username) return { ok: false, reason: 'no-username' };
  const res = await fetch(`${API}/occurrence/download/user/${encodeURIComponent(username)}?limit=0`, {
    headers: { Authorization: h, Accept: 'application/json' },
  });
  return { ok: res.ok, status: res.status, username };
}

// Stream the zip to destPath, following the 302 to the file store, resuming a
// partial file via HTTP Range.
async function fetchZip(downloadLink, destPath, { onProgress } = {}) {
  let start = 0;
  try { start = fs.statSync(destPath).size; } catch (_) { /* new file */ }
  const headers = {};
  if (start > 0) headers.Range = `bytes=${start}-`;
  const res = await fetch(downloadLink, { headers, redirect: 'follow' });
  if (res.status === 416) return { path: destPath, size: start }; // already complete
  if (!res.ok && res.status !== 206) throw new Error(`Zip download failed (${res.status}).`);

  const resuming = start > 0 && res.status === 206;
  const out = fs.createWriteStream(destPath, { flags: resuming ? 'a' : 'w' });
  let received = resuming ? start : 0;
  const lenHeader = res.headers.get('content-length');
  const total = lenHeader ? received + Number(lenHeader) : null;
  const body = Readable.fromWeb(res.body);
  body.on('data', (chunk) => { received += chunk.length; if (onProgress) onProgress(received, total); });
  await pipeline(body, out);
  return { path: destPath, size: received };
}

module.exports = { createDownload, pollDownload, cancelDownload, verifyAuth, fetchZip, decodeJwt, authHeader };
