import { DID_RE, REFEREE_DID, verifyOfficialRefereeMessage } from './crypto.js';

export const CONTEST = Object.freeze({
  id: 'sonnet-2',
  opening: '2026-09-11T12:00:00Z',
  deadline: '2026-09-18T12:00:00Z',
  refereeDid: REFEREE_DID,
  dictionarySha256: '81917843c7f44ce2b094ac63873c2c7a4cf802040792c455ba3ca406891c3d22',
});

export const ROOMS = Object.freeze({
  registration: 'mb-sonnet-2-registration',
  discovery: 'mb-sonnet-2-discovery',
  submissions: 'mb-sonnet-2-submissions',
  results: 'd-sonnet-2-results',
});

export const GAME_ID_RE = /^[a-z0-9][a-z0-9_-]{0,15}$/;
export const WORD_RE = /^[A-Za-z]+(?:'[A-Za-z]+)*[,.;:!?]?$/;

export function teamRoom(gameId) {
  if (!GAME_ID_RE.test(String(gameId || ''))) throw new Error('Team ID must be 1–16 lowercase letters, digits, - or _.');
  return `d-sonnet-2-team-${gameId}`;
}

export function requestId(prefix) {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  const suffix = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${prefix}-${Date.now()}-${suffix}`;
}

export function compact(value) {
  return JSON.stringify(value);
}

export function parseRecord(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

export function deepFind(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const key of keys) if (obj[key] !== undefined) return obj[key];
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object') {
      const found = deepFind(value, keys);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

export function receiptStatus(record) {
  if (!record) return 'unknown';
  const raw = String(deepFind(record, ['status', 'result', 'decision']) || '').toLowerCase();
  const accepted = deepFind(record, ['accepted']);
  if (accepted === true || ['accepted', 'ready', 'ok', 'success', 'registered'].includes(raw)) return 'accepted';
  if (accepted === false || ['rejected', 'invalid', 'denied', 'failed', 'error'].includes(raw)) return 'rejected';
  return 'unknown';
}

export function referencedRequestId(record) {
  return String(deepFind(record, ['for_request_id', 'request_id']) || '');
}

export function registrationRecord(xAccountUrl, reqId) {
  return {
    type: 'sonnet.register.v1',
    contest_id: CONTEST.id,
    role: 'writer',
    x_account_url: xAccountUrl,
    request_id: reqId,
  };
}

export function teamRequestRecord(gameId, reqId) {
  if (!GAME_ID_RE.test(gameId)) throw new Error('Invalid team ID.');
  return { type: 'sonnet.team-request.v1', contest_id: CONTEST.id, game_id: gameId, request_id: reqId };
}

export function rosterRecord(gameId, generation, members, reqId) {
  const exact = validateMembers(members);
  return {
    type: 'sonnet.roster.v1',
    contest_id: CONTEST.id,
    game_id: gameId,
    poem_room: teamRoom(gameId),
    room_generation: Number(generation),
    members: exact,
    request_id: reqId,
  };
}

export function wordRecord(gameId, generation, version, previousStateHash, word, reqId) {
  if (!WORD_RE.test(word)) throw new Error('Word format is invalid.');
  if (!/^[a-f0-9]{64}$/i.test(previousStateHash || '')) throw new Error('A 64-character previous state hash is required.');
  return {
    type: 'sonnet.word.v1',
    contest_id: CONTEST.id,
    game_id: gameId,
    room_generation: Number(generation),
    version: Number(version),
    previous_state_hash: previousStateHash,
    word,
    request_id: reqId,
  };
}

export function submitRecord(gameId, generation, finalVersion, poemSha256, xPostIds, reqId) {
  if (!/^[a-f0-9]{64}$/i.test(poemSha256 || '')) throw new Error('Poem hash is invalid.');
  if (!Array.isArray(xPostIds) || !xPostIds.length || xPostIds.some((v) => !/^\d{5,30}$/.test(String(v)))) throw new Error('Valid X post IDs are required.');
  return {
    type: 'sonnet.submit.v1',
    contest_id: CONTEST.id,
    game_id: gameId,
    poem_room: teamRoom(gameId),
    room_generation: Number(generation),
    final_version: Number(finalVersion),
    poem_sha256: poemSha256,
    x_post_ids: xPostIds.map(String),
    request_id: reqId,
  };
}

export function validateMembers(members) {
  if (!Array.isArray(members) || members.length < 4 || members.length > 8) throw new Error('Roster must contain 4–8 writers.');
  const clean = members.map((v) => String(v).trim());
  if (new Set(clean).size !== clean.length || clean.some((did) => !DID_RE.test(did))) throw new Error('Roster contains an invalid or duplicate DID.');
  return clean;
}

export function didAllowsWord(did, word) {
  if (!DID_RE.test(did) || !WORD_RE.test(word)) return false;
  const source = did.toLowerCase();
  const bare = word.replace(/[,.;:!?]$/, '').toLowerCase();
  return [...bare].every((c) => c === "'" || source.includes(c));
}

export async function verifiedReceipts(room, messages) {
  const out = [];
  for (const message of messages || []) {
    if (message?.from !== REFEREE_DID) continue;
    const record = parseRecord(message.text);
    if (!record || record.contest_id !== CONTEST.id || !/^sonnet\.(?:receipt|receipts)\.v1$/.test(String(record.type || ''))) continue;
    if (await verifyOfficialRefereeMessage(room, message)) out.push({ message, record });
  }
  return out;
}

export async function findVerifiedReceipt(room, messages, requestIdValue) {
  const receipts = await verifiedReceipts(room, messages);
  const req = String(requestIdValue || '');
  return [...receipts].reverse().find(({ record }) => referencedRequestId(record) === req || JSON.stringify(record).includes(req)) || null;
}

export async function extractTeamState(messages, room) {
  const proposals = new Map();
  for (const message of messages || []) {
    const record = parseRecord(message.text);
    if (record?.type === 'sonnet.word.v1' && record.request_id) proposals.set(record.request_id, { message, record });
  }

  const receipts = await verifiedReceipts(room, messages || []);
  let version = 0;
  let stateHash = '';
  let line = 1;
  let complete = false;
  let lastContributor = '';
  const acceptedWords = [];
  const acceptedByRequest = new Set();

  for (const { record } of receipts) {
    if (receiptStatus(record) !== 'accepted') continue;

    const nextVersion = Number(deepFind(record, ['version', 'next_version', 'accepted_version']));
    if (Number.isSafeInteger(nextVersion) && nextVersion >= version) version = nextVersion;
    const hash = deepFind(record, ['state_hash', 'next_state_hash', 'accepted_state_hash', 'poem_state_hash']);
    if (/^[a-f0-9]{64}$/i.test(String(hash || ''))) stateHash = String(hash);
    const currentLine = Number(deepFind(record, ['line', 'line_number', 'current_line']));
    if (Number.isInteger(currentLine) && currentLine >= 1 && currentLine <= 14) line = currentLine;
    if (record.complete === true) complete = true;

    const req = referencedRequestId(record);
    const proposal = proposals.get(req);
    if (!proposal || acceptedByRequest.has(req)) continue;
    acceptedByRequest.add(req);
    acceptedWords.push(String(proposal.record.word));
    lastContributor = proposal.message.from;
  }

  return { version, stateHash, line, complete, lastContributor, acceptedWords, receipts };
}
