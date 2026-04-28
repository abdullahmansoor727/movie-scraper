'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const REFERER = 'https://vidlink.pro/';
const ORIGIN  = 'https://vidlink.pro';
const UA      = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124';

// ── WASM singleton (survives warm invocations) ────────────────────────────────
let wasmReady = false;
let bootPromise = null;

function bootWasm() {
  if (bootPromise) return bootPromise;
  bootPromise = (async () => {
    globalThis.window = globalThis;
    globalThis.self = globalThis;
    globalThis.document = { createElement: () => ({}), body: { appendChild: () => {} } };

    const sodium = require('libsodium-wrappers');
    await sodium.ready;
    globalThis.sodium = sodium;

    eval(fs.readFileSync(path.join(__dirname, '..', 'script.js'), 'utf8'));

    const go = new Dm();
    const wasmBuf = fs.readFileSync(path.join(__dirname, '..', 'fu.wasm'));
    const { instance } = await WebAssembly.instantiate(wasmBuf, go.importObject);
    go.run(instance);

    await new Promise(r => setTimeout(r, 500));
    if (typeof globalThis.getAdv !== 'function') throw new Error('getAdv not found after WASM boot');
    wasmReady = true;
  })();
  return bootPromise;
}

// ── Stream URL resolver ───────────────────────────────────────────────────────
async function getStream(id, season, episode) {
  await bootWasm();
  const token = globalThis.getAdv(String(id));
  if (!token) throw new Error('getAdv returned null');

  const apiUrl = season
    ? `https://vidlink.pro/api/b/tv/${token}/${season}/${episode || 1}?multiLang=0`
    : `https://vidlink.pro/api/b/movie/${token}?multiLang=0`;

  const res = await fetch(apiUrl, {
    headers: { Referer: REFERER, Origin: ORIGIN, 'User-Agent': UA }
  });
  if (!res.ok) throw new Error(`vidlink API returned ${res.status}`);
  const data = await res.json();
  const playlist = data?.stream?.playlist;
  if (!playlist) throw new Error('No playlist in response');
  return playlist;
}

// ── HLS upstream fetcher with redirect support ────────────────────────────────
function fetchUpstream(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    (url.startsWith('https') ? https : http).get(url, {
      headers: { Referer: REFERER, Origin: ORIGIN, 'User-Agent': UA, Accept: '*/*' }
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const loc = res.headers.location;
        return resolve(fetchUpstream(loc.startsWith('http') ? loc : new URL(loc, url).href, redirects + 1));
      }
      resolve(res);
    }).on('error', reject);
  });
}

function toProxiedUrl(value, playlistUrl) {
  if (/^(data|blob):/i.test(value)) return value;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^https?:/i.test(value)) return value;
  return '/api?url=' + encodeURIComponent(new URL(value, playlistUrl).href);
}

function rewriteM3u8(body, url) {
  return body.split('\n').map(line => {
    const t = line.trim();
    if (!t) return line;
    if (t.startsWith('#')) {
      return line.replace(/URI="([^"]+)"/g, function(_, uri) {
        return 'URI="' + toProxiedUrl(uri, url) + '"';
      });
    }
    return toProxiedUrl(t, url);
  }).join('\n');
}

function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', chunk => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

function getQuery(event) {
  if (event.queryStringParameters) {
    return event.queryStringParameters;
  }

  const rawUrl = event.rawUrl || event.path || '/api';
  const { searchParams } = new URL(rawUrl, 'http://localhost');
  return Object.fromEntries(searchParams);
}

async function handler(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Range',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  const q = getQuery(event);

  // Proxy mode: /api?url=...
  if (q.url) {
    const url = q.url;
    try {
      const upstream = await fetchUpstream(url);
      const ct = (upstream.headers['content-type'] || '').toLowerCase();
      const isM3u8 = ct.includes('mpegurl') || ct.includes('m3u8') || /\.m3u8?(\?|$)/i.test(url.split('?')[0]);
      const bodyBuffer = await streamToBuffer(upstream);

      if (isM3u8) {
        return {
          statusCode: 200,
          headers: { ...headers, 'Content-Type': 'application/vnd.apple.mpegurl' },
          body: rewriteM3u8(bodyBuffer.toString('utf8'), url),
        };
      }

      return {
        statusCode: upstream.statusCode || 200,
        headers: { ...headers, 'Content-Type': ct || 'application/octet-stream' },
        body: bodyBuffer.toString('base64'),
        isBase64Encoded: true,
      };
    } catch (err) {
      return {
        statusCode: 502,
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: err.message }),
      };
    }
  }

  // Stream lookup: /api?id=550  or  /api?id=456&s=1&e=2
  if (!q.id) {
    return {
      statusCode: 400,
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'missing id' }),
    };
  }

  try {
    const url = await getStream(q.id, q.s, q.e);
    return {
      statusCode: 200,
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message }),
    };
  }
}

exports.handler = handler;
