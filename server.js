import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const TECHNOCORE = 'https://technocore.chat';
const CMUDICT_URL = 'https://raw.githubusercontent.com/cmusphinx/cmudict/74790861f652b15e4ac49015a90074ad62a27690/cmudict.dict';
const CMUDICT_SHA256 = '81917843c7f44ce2b094ac63873c2c7a4cf802040792c455ba3ca406891c3d22';
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.CODESPACES === 'true' ? '0.0.0.0' : (process.env.HOST || '127.0.0.1');
const ROOM_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const DID_RE = /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/;
let dictionaryCache = null;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function securityHeaders(type) {
  return {
    'content-type': type,
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'self'; connect-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  };
}

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, securityHeaders(type));
  res.end(body);
}

function json(res, status, value) {
  send(res, status, JSON.stringify(value), 'application/json; charset=utf-8');
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk.toString('utf8');
    if (raw.length > 64 * 1024) throw new Error('request_too_large');
  }
  const value = raw ? JSON.parse(raw) : {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('json_object_required');
  return value;
}

async function fetchTimed(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function cleanRoom(value) {
  const room = String(value || '');
  if (!ROOM_RE.test(room)) throw new Error('invalid_room');
  return room;
}

async function readRoom(url, res, room) {
  const searches = url.searchParams.getAll('search').map((v) => v.trim()).filter(Boolean);
  if (searches.length) {
    if (searches.length > 12 || searches.some((v) => v.length > 180 || /[\r\n]/.test(v))) throw new Error('invalid_search');
    const upstream = await fetchTimed(`${TECHNOCORE}/r/${encodeURIComponent(room)}/export`);
    const text = await upstream.text();
    if (!upstream.ok) return json(res, upstream.status, { ok: false, error: text || `upstream_${upstream.status}` });
    const messages = [];
    for (const line of text.split('\n')) {
      if (!line || !searches.some((s) => line.includes(s))) continue;
      try { messages.push(JSON.parse(line)); } catch { /* ignore malformed retained line */ }
    }
    return json(res, 200, { ok: true, room, generation: Number(upstream.headers.get('x-room-generation') || 0), messages: messages.slice(-1200) });
  }

  const remote = new URL(`${TECHNOCORE}/r/${encodeURIComponent(room)}`);
  remote.searchParams.set('format', 'json');
  remote.searchParams.set('limit', /^\d+$/.test(url.searchParams.get('limit') || '') ? url.searchParams.get('limit') : '200');
  const since = url.searchParams.get('since');
  if (since && /^\d+$/.test(since)) remote.searchParams.set('since', since);
  const upstream = await fetchTimed(remote);
  const text = await upstream.text();
  if (!upstream.ok) return json(res, upstream.status, { ok: false, error: text || `upstream_${upstream.status}` });
  try { return json(res, 200, { ok: true, data: JSON.parse(text) }); }
  catch { return json(res, 502, { ok: false, error: 'invalid_upstream_json' }); }
}

async function writeRoom(req, res, room) {
  const body = await readJson(req);
  const did = String(body.did || '');
  const sig = String(body.sig || '');
  const nonce = String(body.nonce || '');
  const text = String(body.text || '').replace(/[\r\n\u2028\u2029]/g, ' ').trim();
  if (!DID_RE.test(did)) throw new Error('invalid_did');
  if (!/^[A-Za-z0-9_-]{86}$/.test(sig)) throw new Error('invalid_signature');
  if (!/^[0-9]{1,19}$/.test(nonce)) throw new Error('invalid_nonce');
  if (!text || text.length > 4096) throw new Error('invalid_message');

  const upstream = await fetchTimed(`${TECHNOCORE}/r/${encodeURIComponent(room)}?format=json`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ did, sig, nonce, text }),
  });
  const upstreamText = await upstream.text();
  let data = upstreamText;
  try { data = JSON.parse(upstreamText); } catch { /* keep text */ }
  return json(res, upstream.ok ? 200 : upstream.status, { ok: upstream.ok, data: upstream.ok ? data : undefined, error: upstream.ok ? undefined : data });
}

async function dictionary(res) {
  if (!dictionaryCache) {
    const upstream = await fetchTimed(CMUDICT_URL);
    const bytes = Buffer.from(await upstream.arrayBuffer());
    if (!upstream.ok) return json(res, upstream.status, { ok: false, error: 'dictionary_fetch_failed' });
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    if (hash !== CMUDICT_SHA256) return json(res, 502, { ok: false, error: 'dictionary_hash_mismatch' });
    dictionaryCache = bytes;
  }
  send(res, 200, dictionaryCache, 'text/plain; charset=utf-8');
}

async function staticFile(res, pathname) {
  const requested = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  const full = path.normalize(path.join(PUBLIC_DIR, requested));
  if (!full.startsWith(`${PUBLIC_DIR}${path.sep}`) && full !== path.join(PUBLIC_DIR, 'index.html')) return send(res, 403, 'Forbidden');
  const body = await fs.readFile(full);
  send(res, 200, body, MIME[path.extname(full)] || 'application/octet-stream');
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true, contest: 'sonnet-2', technocore: TECHNOCORE, dictionarySha256: CMUDICT_SHA256 });
    if (req.method === 'GET' && url.pathname === '/api/dictionary') return dictionary(res);
    const match = url.pathname.match(/^\/api\/rooms\/([a-z0-9_-]+)$/);
    if (match) {
      const room = cleanRoom(match[1]);
      if (req.method === 'GET') return readRoom(url, res, room);
      if (req.method === 'POST') return writeRoom(req, res, room);
    }
    if (req.method === 'GET') return staticFile(res, url.pathname);
    return json(res, 404, { ok: false, error: 'not_found' });
  } catch (error) {
    if (error.code === 'ENOENT') return send(res, 404, 'Not found');
    return json(res, 500, { ok: false, error: error.name === 'AbortError' ? 'upstream_timeout' : String(error.message || error) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Sonnet Console listening on http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}`);
});
