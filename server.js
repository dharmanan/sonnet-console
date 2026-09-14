import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { get, put } from '@vercel/blob';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const TECHNOCORE = 'https://technocore.chat';
const CMUDICT_URL = 'https://raw.githubusercontent.com/cmusphinx/cmudict/74790861f652b15e4ac49015a90074ad62a27690/cmudict.dict';
const CMUDICT_SHA256 = '81917843c7f44ce2b094ac63873c2c7a4cf802040792c455ba3ca406891c3d22';
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.CODESPACES === 'true' ? '0.0.0.0' : (process.env.HOST || '127.0.0.1');
const SITE_PASSWORD = String(process.env.SITE_PASSWORD || '');
const AUTH_SECRET = String(process.env.AUTH_SECRET || '');
const AUTH_COOKIE = 'sonnet_console_auth';
const AUTH_MAX_AGE = 12 * 60 * 60;
const IS_VERCEL = Boolean(process.env.VERCEL);
const ROOM_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const DID_RE = /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/;
const REFEREE_DID = 'did:key:z6MkowHQwsx9xr84WbWN3YCnKutyBnBXkT1ChKY4uEAAMzte';
const CONTEST_STATUS_TTL_MS = 5 * 60 * 1000;

let dictionaryCache = null;
let contestStatusCache = null;
let contestStatusExpiresAt = 0;
let contestStatusPromise = null;
const publicKeyCache = new Map();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function securityHeaders(type, allowForm = false) {
  return {
    'content-type': type,
    'cache-control': 'no-store',
    'content-security-policy': `default-src 'self'; connect-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; form-action ${allowForm ? "'self'" : "'none'"}; frame-ancestors 'none'`,
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  };
}

function send(
  res,
  status,
  body,
  type = 'text/plain; charset=utf-8',
  extraHeaders = {},
  allowForm = false
) {
  res.writeHead(
    status,
    {
      ...securityHeaders(type, allowForm),
      ...extraHeaders
    }
  );
  res.end(body);
}

function json(res, status, value) {
  send(res, status, JSON.stringify(value), 'application/json; charset=utf-8');
}

function authConfigured() {
  return (
    SITE_PASSWORD.length >= 10 &&
    AUTH_SECRET.length >= 32
  );
}

function hashText(value) {
  return crypto
    .createHash('sha256')
    .update(String(value || ''), 'utf8')
    .digest();
}

function safeEqualText(a, b) {
  return crypto.timingSafeEqual(
    hashText(a),
    hashText(b)
  );
}

function expectedAuthToken() {
  if (!authConfigured()) return '';

  return crypto
    .createHmac('sha256', AUTH_SECRET)
    .update(`sonnet-console-session:${SITE_PASSWORD}`)
    .digest('base64url');
}

function cookieValue(req, name) {
  const raw = String(req.headers.cookie || '');

  for (const part of raw.split(';')) {
    const index = part.indexOf('=');

    if (index === -1) continue;

    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();

    if (key === name) {
      return value;
    }
  }

  return '';
}

function authenticated(req) {
  if (!authConfigured()) {
    return !IS_VERCEL;
  }

  const actual = cookieValue(req, AUTH_COOKIE);
  const expected = expectedAuthToken();

  return Boolean(
    actual &&
    expected &&
    safeEqualText(actual, expected)
  );
}

function sessionCookie() {
  const secure = IS_VERCEL
    ? '; Secure'
    : '';

  return [
    `${AUTH_COOKIE}=${expectedAuthToken()}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${AUTH_MAX_AGE}`
  ].join('; ') + secure;
}

function expiredSessionCookie() {
  const secure = IS_VERCEL
    ? '; Secure'
    : '';

  return [
    `${AUTH_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=0'
  ].join('; ') + secure;
}

function redirect(res, location, extraHeaders = {}) {
  send(
    res,
    303,
    '',
    'text/plain; charset=utf-8',
    {
      location,
      ...extraHeaders
    }
  );
}

async function readForm(req) {
  let raw = '';

  for await (const chunk of req) {
    raw += chunk.toString('utf8');

    if (raw.length > 8192) {
      throw new Error('request_too_large');
    }
  }

  return new URLSearchParams(raw);
}

function loginPage(res, invalid = false) {
  const error = invalid
    ? '<p class="login-error">Şifre doğru değil.</p>'
    : '';

  const body = `<!doctype html>
<html lang="tr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Sonnet Console · Giriş</title>
  <link rel="stylesheet" href="/login.css">
</head>
<body>
  <main class="login-shell">
    <section class="login-card">
      <div class="eyebrow">FLOP / TECHNOCORE · SONNET-2</div>
      <h1>Sonnet Console</h1>
      <p class="intro">Bu çalışma alanı özel erişimle korunuyor.</p>

      ${error}

      <form method="post" action="/auth/login">
        <label for="password">Erişim şifresi</label>
        <input
          id="password"
          name="password"
          type="password"
          autocomplete="current-password"
          autofocus
          required
        >
        <button type="submit">Console'a gir</button>
      </form>

      <p class="security">
        Bu şifre yalnızca Console erişimini korur.
        Seed veya özel anahtar değildir.
      </p>
    </section>
  </main>
</body>
</html>`;

  send(
    res,
    invalid ? 401 : 200,
    body,
    'text/html; charset=utf-8',
    {},
    true
  );
}

function authConfigurationError(res) {
  send(
    res,
    503,
    'Sonnet Console access protection is not configured.',
    'text/plain; charset=utf-8'
  );
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


const BASE58_ALPHABET =
  '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

const BASE58_INDEX = new Map(
  [...BASE58_ALPHABET].map((c, i) => [c, i])
);

function decodeBase58(value) {
  let n = 0n;

  for (const c of String(value || '')) {
    const d = BASE58_INDEX.get(c);
    if (d == null) throw new Error('invalid_base58');
    n = n * 58n + BigInt(d);
  }

  let hex = n.toString(16);
  if (hex.length % 2) hex = `0${hex}`;

  let bytes = hex
    ? Uint8Array.from(
        hex.match(/../g).map((pair) => parseInt(pair, 16))
      )
    : new Uint8Array();

  const input = String(value || '');
  const leading =
    input.length - input.replace(/^1+/, '').length;

  if (leading) {
    bytes = new Uint8Array([
      ...new Uint8Array(leading),
      ...bytes
    ]);
  }

  return bytes;
}

async function publicKeyFromDid(did) {
  if (!DID_RE.test(did)) {
    throw new Error('invalid_did');
  }

  if (publicKeyCache.has(did)) {
    return publicKeyCache.get(did);
  }

  const decoded =
    decodeBase58(did.slice('did:key:z'.length));

  if (
    decoded.length !== 34 ||
    decoded[0] !== 0xed ||
    decoded[1] !== 0x01
  ) {
    throw new Error('unsupported_did');
  }

  const key = await crypto.webcrypto.subtle.importKey(
    'raw',
    decoded.slice(2),
    { name: 'Ed25519' },
    false,
    ['verify']
  );

  publicKeyCache.set(did, key);
  return key;
}

async function verifyTechnocoreMessage(room, message) {
  if (
    !message?.from ||
    !message?.sig ||
    message?.nonce == null ||
    typeof message?.text !== 'string'
  ) {
    return false;
  }

  try {
    const key = await publicKeyFromDid(message.from);

    const canonical =
      `${room}|${message.nonce}|${message.text}`;

    return await crypto.webcrypto.subtle.verify(
      'Ed25519',
      key,
      Buffer.from(message.sig, 'base64url'),
      new TextEncoder().encode(canonical)
    );
  } catch {
    return false;
  }
}

function parseJsonObject(text) {
  try {
    const value = JSON.parse(text);

    return (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value)
    )
      ? value
      : null;
  } catch {
    return null;
  }
}

async function fetchRoomExport(room) {
  const response = await fetchTimed(
    `${TECHNOCORE}/r/${encodeURIComponent(room)}/export`
  );

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `room_export_${room}_${response.status}`
    );
  }

  return {
    text,
    generation:
      Number(
        response.headers.get('x-room-generation') || 0
      )
  };
}

async function readOfficialContestTeamCount() {
  const room = 'd-sonnet-2-rules';
  const { text } = await fetchRoomExport(room);

  let latest = null;

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;

    let message;

    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }

    if (message.from !== REFEREE_DID) continue;

    if (
      !(await verifyTechnocoreMessage(room, message))
    ) {
      continue;
    }

    const record = parseJsonObject(message.text);

    if (
      record?.type === 'sonnet.notice.v1' &&
      record?.subject === 'referee status' &&
      Number.isSafeInteger(Number(record.teams))
    ) {
      latest = {
        teams: Number(record.teams),
        seq:
          message.seq ??
          message.room_seq ??
          null,
        ts: message.ts || ''
      };
    }
  }

  if (!latest) {
    throw new Error('official_team_status_unavailable');
  }

  return latest;
}

async function inspectContestTeamRoom(room) {
  const { text, generation } =
    await fetchRoomExport(room);

  const proposals = new Map();
  const receipts = [];

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;

    let message;

    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }

    const record =
      parseJsonObject(message.text);

    if (!record) continue;

    if (
      record.type === 'sonnet.word.v1' &&
      record.contest_id === 'sonnet-2' &&
      record.request_id &&
      Number(record.room_generation) === generation &&
      await verifyTechnocoreMessage(room, message)
    ) {
      proposals.set(
        String(record.request_id),
        record
      );
    }

    if (
      message.from === REFEREE_DID &&
      record.type === 'sonnet.receipt.v1' &&
      record.contest_id === 'sonnet-2' &&
      record.status === 'accepted' &&
      await verifyTechnocoreMessage(room, message)
    ) {
      receipts.push(record);
    }
  }

  let acceptedWords = 0;
  let complete = false;

  for (const receipt of receipts) {
    const requestId =
      String(
        receipt.for_request_id ||
        receipt.request_id ||
        ''
      );

    if (!proposals.has(requestId)) continue;

    acceptedWords += 1;

    if (receipt.complete === true) {
      complete = true;
    }
  }

  return {
    started: acceptedWords > 0,
    complete
  };
}

async function buildContestStatus() {
  const [
    official,
    allowResponse
  ] = await Promise.all([
    readOfficialContestTeamCount(),
    fetchTimed(`${TECHNOCORE}/kv/room-allow`)
  ]);

  const allowText =
    await allowResponse.text();

  if (!allowResponse.ok) {
    throw new Error(
      `room_allow_${allowResponse.status}`
    );
  }

  const rooms = allowText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) =>
      line.startsWith(
        '/kv/room-allow/d-sonnet-2-team-'
      )
    )
    .map((line) =>
      line.replace('/kv/room-allow/', '')
    );

  const queue = [...rooms];
  const results = [];

  const workers = Array.from(
    { length: 6 },
    async () => {
      while (queue.length) {
        const room = queue.shift();
        if (!room) continue;

        try {
          results.push({
            room,
            ...(await inspectContestTeamRoom(room))
          });
        } catch (error) {
          results.push({
            room,
            error: String(error)
          });
        }
      }
    }
  );

  await Promise.all(workers);

  const errors =
    results.filter((item) => item.error);

  return {
    ok: true,
    fetchedAt: new Date().toISOString(),
    officialTeams: official.teams,
    officialStatusSeq: official.seq,
    officialStatusAt: official.ts,
    roomsOpened: rooms.length,
    started:
      results.filter((item) => item.started).length,
    completed:
      results.filter((item) => item.complete).length,
    errors: errors.length
  };
}

async function getContestStatus() {
  const now = Date.now();

  if (
    contestStatusCache &&
    now < contestStatusExpiresAt
  ) {
    return contestStatusCache;
  }

  if (contestStatusPromise) {
    return contestStatusPromise;
  }

  contestStatusPromise =
    buildContestStatus()
      .then((value) => {
        contestStatusCache = value;
        contestStatusExpiresAt =
          Date.now() + CONTEST_STATUS_TTL_MS;

        return value;
      })
      .finally(() => {
        contestStatusPromise = null;
      });

  return contestStatusPromise;
}

async function contestStatus(res) {
  try {
    return json(
      res,
      200,
      await getContestStatus()
    );
  } catch (error) {
    return json(
      res,
      502,
      {
        ok: false,
        error: 'contest_status_unavailable',
        detail: String(error)
      }
    );
  }
}


function privateWorkspacePath(gameId) {
  return `sonnet-console/private/${gameId}/workspace.json`;
}

function localPrivateWorkspacePath(gameId) {
  return path.join(
    __dirname,
    'data',
    'private-workspace',
    `${gameId}.json`
  );
}

const CANONICAL_TEAM_ROSTERS = new Map([
  [
    'kohen-sonnet',
    [
      'did:key:z6Mkn7LCcVgptpXz141Fk58UUhfho77Toer96cfqf3wVVxE4',
      'did:key:z6MkqfXdajyL1TDEhunq3xuQMfembaa4apiErvPxQQz3wtSg',
      'did:key:z6MkoqwwuoAVWbWpcirCfCRxCaMQTFvDrwrFCxaquXWXdm5G',
      'did:key:z6MkejoBvUkYrccxz3MACYVBkCSqzoAU5AzztrVsgxZNE1Mt'
    ]
  ]
]);

function canonicalTeamRoster(gameId) {
  return [
    ...(CANONICAL_TEAM_ROSTERS.get(gameId) || [])
  ];
}

function emptyPrivateWorkspace(gameId) {
  return {
    version: 1,
    gameId,
    members: canonicalTeamRoster(gameId),
    chat: [],
    draft: '',
    draftUpdatedBy: '',
    updatedAt: 0
  };
}

function normalizePrivateWorkspace(value, gameId) {
  const source =
    value && typeof value === 'object'
      ? value
      : {};

  const chat = Array.isArray(source.chat)
    ? source.chat
        .filter((item) =>
          item &&
          typeof item === 'object' &&
          typeof item.id === 'string' &&
          DID_RE.test(String(item.did || '')) &&
          typeof item.text === 'string' &&
          Number.isSafeInteger(Number(item.ts))
        )
        .map((item) => ({
          id: String(item.id).slice(0, 100),
          did: String(item.did),
          text: String(item.text).slice(0, 1000),
          ts: Number(item.ts)
        }))
        .slice(-200)
    : [];

  const canonicalMembers =
    canonicalTeamRoster(gameId);

  const storedMembers =
    Array.isArray(source.members)
      ? source.members
          .map((did) => String(did || ''))
          .filter((did) => DID_RE.test(did))
      : [];

  const uniqueStoredMembers =
    [...new Set(storedMembers)];

  const members =
    canonicalMembers.length
      ? canonicalMembers
      : (
          uniqueStoredMembers.length >= 4 &&
          uniqueStoredMembers.length <= 8
            ? uniqueStoredMembers
            : []
        );

  return {
    version: 1,
    gameId,
    members,
    chat,
    draft:
      typeof source.draft === 'string'
        ? source.draft.slice(0, 20000)
        : '',
    draftUpdatedBy:
      DID_RE.test(String(source.draftUpdatedBy || ''))
        ? String(source.draftUpdatedBy)
        : '',
    updatedAt:
      Number.isSafeInteger(Number(source.updatedAt))
        ? Number(source.updatedAt)
        : 0
  };
}

async function blobStreamText(stream) {
  if (!stream) return '';

  return await new Response(stream).text();
}

async function readBlobPrivateWorkspace(gameId) {
  const result = await get(
    privateWorkspacePath(gameId),
    {
      access: 'private',
      useCache: false
    }
  );

  if (!result || result.statusCode !== 200) {
    return {
      workspace: emptyPrivateWorkspace(gameId),
      etag: null
    };
  }

  const text = await blobStreamText(result.stream);

  let parsed = null;

  try {
    parsed = text
      ? JSON.parse(text)
      : null;
  } catch {
    parsed = null;
  }

  return {
    workspace: normalizePrivateWorkspace(
      parsed,
      gameId
    ),
    etag: result.blob.etag || null
  };
}

async function writeBlobPrivateWorkspace(
  gameId,
  mutate
) {
  const pathname =
    privateWorkspacePath(gameId);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const current =
      await readBlobPrivateWorkspace(gameId);

    const next =
      normalizePrivateWorkspace(
        mutate(
          structuredClone(current.workspace)
        ),
        gameId
      );

    next.updatedAt = Date.now();

    const options = {
      access: 'private',
      contentType: 'application/json',
      cacheControlMaxAge: 60
    };

    if (current.etag) {
      options.allowOverwrite = true;
      options.ifMatch = current.etag;
    }

    try {
      await put(
        pathname,
        JSON.stringify(next),
        options
      );

      return next;
    } catch (error) {
      const message =
        String(error?.message || error);

      const concurrent =
        /precondition|already exists|already.*exist|409|412/i
          .test(message);

      if (concurrent && attempt < 4) {
        continue;
      }

      throw error;
    }
  }

  throw new Error(
    'private_workspace_write_conflict'
  );
}

const localWorkspaceLocks = new Map();

async function readLocalPrivateWorkspace(gameId) {
  try {
    const text = await fs.readFile(
      localPrivateWorkspacePath(gameId),
      'utf8'
    );

    return normalizePrivateWorkspace(
      JSON.parse(text),
      gameId
    );
  } catch (error) {
    if (error.code === 'ENOENT') {
      return emptyPrivateWorkspace(gameId);
    }

    throw error;
  }
}

async function mutateLocalPrivateWorkspace(
  gameId,
  mutate
) {
  const previous =
    localWorkspaceLocks.get(gameId) ||
    Promise.resolve();

  const operation = previous.then(async () => {
    const current =
      await readLocalPrivateWorkspace(gameId);

    const next =
      normalizePrivateWorkspace(
        mutate(structuredClone(current)),
        gameId
      );

    next.updatedAt = Date.now();

    const filename =
      localPrivateWorkspacePath(gameId);

    await fs.mkdir(
      path.dirname(filename),
      {
        recursive: true
      }
    );

    const temporary =
      `${filename}.${crypto.randomUUID()}.tmp`;

    await fs.writeFile(
      temporary,
      JSON.stringify(next, null, 2),
      'utf8'
    );

    await fs.rename(
      temporary,
      filename
    );

    return next;
  });

  localWorkspaceLocks.set(
    gameId,
    operation.catch(() => {})
  );

  return operation;
}

async function readPrivateWorkspace(gameId) {
  if (IS_VERCEL) {
    return (
      await readBlobPrivateWorkspace(gameId)
    ).workspace;
  }

  return readLocalPrivateWorkspace(gameId);
}

async function mutatePrivateWorkspace(
  gameId,
  mutate
) {
  if (IS_VERCEL) {
    return writeBlobPrivateWorkspace(
      gameId,
      mutate
    );
  }

  return mutateLocalPrivateWorkspace(
    gameId,
    mutate
  );
}

async function privateWorkspaceGet(
  res,
  gameId
) {
  try {
    const workspace =
      await readPrivateWorkspace(gameId);

    return json(
      res,
      200,
      {
        ok: true,
        workspace
      }
    );
  } catch {
    return json(
      res,
      503,
      {
        ok: false,
        error: 'private_storage_unavailable'
      }
    );
  }
}

async function privateWorkspacePost(
  req,
  res
) {
  const body = await readJson(req);

  const gameId =
    cleanRoom(body.game_id);

  const action =
    String(body.action || '');

  try {
    const workspace =
      await mutatePrivateWorkspace(
        gameId,
        (current) => {
          if (action === 'chat.append') {
            const did =
              String(body.did || '');

            const text =
              String(body.text || '')
                .replace(/\0/g, '')
                .trim();

            if (!DID_RE.test(did)) {
              throw new Error('invalid_did');
            }

            if (
              !text ||
              text.length > 1000
            ) {
              throw new Error(
                'invalid_chat_message'
              );
            }

            current.chat.push({
              id: crypto.randomUUID(),
              did,
              text,
              ts: Date.now()
            });

            current.chat =
              current.chat.slice(-200);

            return current;
          }

          if (action === 'draft.set') {
            const did =
              String(body.did || '');

            const draft =
              String(body.draft || '')
                .replace(/\r\n/g, '\n')
                .replace(/\r/g, '\n')
                .trim();

            if (!DID_RE.test(did)) {
              throw new Error('invalid_did');
            }

            if (
              !draft ||
              draft.length > 20000
            ) {
              throw new Error(
                'invalid_draft'
              );
            }

            current.draft = draft;
            current.draftUpdatedBy = did;

            return current;
          }

          if (action === 'draft.clear') {
            const did =
              String(body.did || '');

            if (!DID_RE.test(did)) {
              throw new Error('invalid_did');
            }

            current.draft = '';
            current.draftUpdatedBy = did;

            return current;
          }

          throw new Error(
            'invalid_private_workspace_action'
          );
        }
      );

    return json(
      res,
      200,
      {
        ok: true,
        workspace
      }
    );
  } catch (error) {
    const message =
      String(error?.message || error);

    if (
      message.startsWith('invalid_')
    ) {
      return json(
        res,
        400,
        {
          ok: false,
          error: message
        }
      );
    }

    return json(
      res,
      503,
      {
        ok: false,
        error: 'private_storage_unavailable'
      }
    );
  }
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

export async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    /* Login stylesheet is the only public static asset. */
    if (
      req.method === 'GET' &&
      url.pathname === '/login.css'
    ) {
      return staticFile(res, '/login.css');
    }

    /* Fail closed on Vercel if secrets are missing or too weak. */
    if (IS_VERCEL && !authConfigured()) {
      return authConfigurationError(res);
    }

    if (
      req.method === 'GET' &&
      url.pathname === '/login'
    ) {
      if (authenticated(req)) {
        return redirect(res, '/');
      }

      return loginPage(res);
    }

    if (
      req.method === 'POST' &&
      url.pathname === '/auth/login'
    ) {
      if (!authConfigured()) {
        return authConfigurationError(res);
      }

      const form = await readForm(req);
      const supplied = String(
        form.get('password') || ''
      );

      if (!safeEqualText(supplied, SITE_PASSWORD)) {
        return loginPage(res, true);
      }

      return redirect(
        res,
        '/',
        {
          'set-cookie': sessionCookie()
        }
      );
    }

    if (
      req.method === 'POST' &&
      url.pathname === '/auth/logout'
    ) {
      return redirect(
        res,
        '/login',
        {
          'set-cookie': expiredSessionCookie()
        }
      );
    }

    if (!authenticated(req)) {
      if (url.pathname.startsWith('/api/')) {
        return json(
          res,
          401,
          {
            ok: false,
            error: 'authentication_required'
          }
        );
      }

      return redirect(res, '/login');
    }
    if (
      url.pathname === '/api/private-workspace'
    ) {
      if (req.method === 'GET') {
        const gameId = cleanRoom(
          url.searchParams.get('game_id')
        );

        return privateWorkspaceGet(
          res,
          gameId
        );
      }

      if (req.method === 'POST') {
        return privateWorkspacePost(
          req,
          res
        );
      }

      return json(
        res,
        405,
        {
          ok: false,
          error: 'method_not_allowed'
        }
      );
    }

    if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true, contest: 'sonnet-2', technocore: TECHNOCORE, dictionarySha256: CMUDICT_SHA256 });
    if (req.method === 'GET' && url.pathname === '/api/contest-status') return contestStatus(res);
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
}

export default handler;

if (!IS_VERCEL) {
  const server = http.createServer(handler);

  server.listen(PORT, HOST, () => {
    console.log(
      `Sonnet Console listening on http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}`
    );
  });
}
