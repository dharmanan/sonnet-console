import { identityFromPrivateKey, signRoomMessage, verifyRoomMessage, verifyOfficialRefereeMessage, DID_RE, REFEREE_DID } from './crypto.js';
import {
  CONTEST, ROOMS, GAME_ID_RE, WORD_RE, compact, parseRecord, deepFind, receiptStatus,
  referencedRequestId, registrationRecord, teamRequestRecord, rosterRecord, wordRecord,
  submitRecord, requestId, teamRoom, didAllowsWord, findVerifiedReceipt, verifiedReceipts,
  extractTeamState, validateMembers,
} from './protocol.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const state = {
  privateKey: null,
  did: '',
  registration: null,
  registrationReceipt: null,
  registrationAccepted: false,
  setupVerified: false,
  setupProof: null,
  team: loadTeam(),
  dictionary: null,
  dictionaryReady: false,
  discoveryMessages: [],
  teamMessages: [],
  privateChatMessages: [],
  current: { version: 0, stateHash: '', line: 1, complete: false, lastContributor: '', acceptedWords: [] },
  rosterReady: false,
  memberStatuses: new Map(),
  poem: '',
  poemHash: '',
};


let historicalWriterEvidencePromise = null;

async function historicalWriterEvidenceFor(did) {
  try {
    if (!historicalWriterEvidencePromise) {
      historicalWriterEvidencePromise = fetch(
        '/historical-writer-evidence.json',
        { cache: 'no-store' }
      ).then(async (response) => {
        if (!response.ok) return [];
        const rows = await response.json();
        return Array.isArray(rows) ? rows : [];
      }).catch(() => []);
    }

    const rows = await historicalWriterEvidencePromise;

    return rows.find((row) =>
      row?.participant_did === did &&
      row?.role === 'writer' &&
      row?.watcher_signature_verified === true &&
      row?.authoritative === false
    ) || null;
  } catch {
    return null;
  }
}

function statusLabelTr(status) {
  return {
    accepted: 'KABUL EDİLDİ',
    rejected: 'REDDEDİLDİ',
    pending: 'BEKLEMEDE',
    checking: 'KONTROL EDİLİYOR',
    'not-registered': 'KAYIT BULUNAMADI',
    'history-unavailable': 'GEÇMİŞ BULUNAMADI',
    'historical-accepted': 'GEÇMİŞTE KABUL EDİLDİ',
    'historical-record': 'GEÇMİŞ KAYDI',
    'lookup-unavailable': 'DOĞRULAMA YAPILAMADI',
    'lookup-error': 'KONTROL HATASI'
  }[status] || String(status || '').toUpperCase();
}

function esc(v) {
  return String(v ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

const WRITER_NAMES = new Map([
  ['did:key:z6Mkn7LCcVgptpXz141Fk58UUhfho77Toer96cfqf3wVVxE4', 'Kohen'],
  ['did:key:z6MkqfXdajyL1TDEhunq3xuQMfembaa4apiErvPxQQz3wtSg', 'Echo'],
  ['did:key:z6MkoqwwuoAVWbWpcirCfCRxCaMQTFvDrwrFCxaquXWXdm5G', 'memosr'],
  ['did:key:z6MkejoBvUkYrccxz3MACYVBkCSqzoAU5AzztrVsgxZNE1Mt', 'Sekuler']
]);

function writerName(did) {
  return WRITER_NAMES.get(did) || 'Yazar';
}

function shortDid(did) {
  return did ? `${did.slice(0, 16)}…${did.slice(-8)}` : '—';
}

function toast(message, tone = '') {
  const box = $('#toast');
  box.textContent = message;
  box.className = `toast show ${tone}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { box.className = 'toast'; }, 4200);
}


function privateChatKey() {
  return `sonnet-console-private-chat:${state.team?.gameId || 'no-team'}`;
}

function loadPrivateChat() {
  try {
    const rows = JSON.parse(
      localStorage.getItem(privateChatKey()) || '[]'
    );

    state.privateChatMessages =
      Array.isArray(rows) ? rows : [];
  } catch {
    state.privateChatMessages = [];
  }
}

function savePrivateChat() {
  try {
    localStorage.setItem(
      privateChatKey(),
      JSON.stringify(
        state.privateChatMessages.slice(-200)
      )
    );
  } catch {
    // Yerel sohbet kaydı isteğe bağlıdır.
  }
}


let privateWorkspaceBusy = false;

function applySharedPrivateWorkspace(workspace) {
  if (
    !workspace ||
    typeof workspace !== 'object'
  ) return;

  state.privateChatMessages =
    Array.isArray(workspace.chat)
      ? workspace.chat.map((message) => ({
          ...message,
          name: writerName(message.did)
        }))
      : [];

  savePrivateChat();

  if (typeof workspace.draft === 'string') {
    savePoemDraft(workspace.draft);
  }
}

async function privateWorkspaceRequest(
  method,
  body = null
) {
  if (!state.team?.gameId) {
    throw new Error(
      'Önce takım çalışma alanı oluşturulmalı.'
    );
  }

  const options = {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: {}
  };

  let url =
    '/api/private-workspace';

  if (method === 'GET') {
    url +=
      `?game_id=${encodeURIComponent(state.team.gameId)}`;
  } else {
    options.headers['content-type'] =
      'application/json';

    options.body = JSON.stringify({
      game_id: state.team.gameId,
      ...body
    });
  }

  const response =
    await fetch(url, options);

  if (response.status === 401) {
    location.assign('/login');

    throw new Error(
      'Console oturumu sona erdi.'
    );
  }

  const data =
    await response.json()
      .catch(() => null);

  if (
    !response.ok ||
    !data?.ok ||
    !data.workspace
  ) {
    throw new Error(
      data?.error === 'private_storage_unavailable'
        ? 'Özel takım çalışma alanına şu anda ulaşılamıyor.'
        : 'Özel takım çalışma alanı güncellenemedi.'
    );
  }

  return data.workspace;
}

async function refreshPrivateWorkspace({
  quiet = true
} = {}) {
  if (
    privateWorkspaceBusy ||
    !state.did ||
    !state.team?.gameId
  ) return;

  privateWorkspaceBusy = true;

  try {
    const workspace =
      await privateWorkspaceRequest(
        'GET'
      );

    applySharedPrivateWorkspace(
      workspace
    );

    renderWorkspace();
    renderPoemDraft();
  } catch (error) {
    if (!quiet) {
      toast(
        error.message,
        'bad'
      );
    }
  } finally {
    privateWorkspaceBusy = false;
  }
}

async function saveSharedDraft(draft) {
  const workspace =
    await privateWorkspaceRequest(
      'POST',
      {
        action: 'draft.set',
        did: state.did,
        draft
      }
    );

  applySharedPrivateWorkspace(
    workspace
  );

  renderWorkspace();
  renderPoemDraft();
}

async function clearSharedDraft() {
  const workspace =
    await privateWorkspaceRequest(
      'POST',
      {
        action: 'draft.clear',
        did: state.did
      }
    );

  applySharedPrivateWorkspace(
    workspace
  );

  renderWorkspace();
  renderPoemDraft();
}

function loadTeam() {
  try {
    const parsed = JSON.parse(localStorage.getItem('sonnet-console-team') || 'null');
    if (parsed && typeof parsed === 'object') return { gameId: parsed.gameId || '', generation: Number(parsed.generation || 0), members: Array.isArray(parsed.members) ? parsed.members : [] };
  } catch { /* ignore */ }
  return { gameId: '', generation: 0, members: [] };
}

function saveTeam() {
  localStorage.setItem('sonnet-console-team', JSON.stringify(state.team));
}


const TEAM_PROOF_CACHE = 'sonnet-console-team-proof-v1';
const REGISTRATION_MESSAGE_CACHE = 'sonnet-console-registration-message-v1';

function registrationMessageKey(did) {
  return `${REGISTRATION_MESSAGE_CACHE}:${did}`;
}

function saveOwnRegistrationMessage(message) {
  if (!state.did || message?.from !== state.did) return;
  try {
    localStorage.setItem(registrationMessageKey(state.did), JSON.stringify(message));
  } catch {
    // Cache loss never changes official registration state.
  }
}

async function loadOwnRegistrationMessage(did) {
  try {
    const message = JSON.parse(
      localStorage.getItem(registrationMessageKey(did)) || 'null'
    );

    if (!message || message.from !== did) return null;
    if (!(await verifyRoomMessage(ROOMS.registration, message))) return null;

    const record = parseRecord(message.text);
    if (
      record?.type !== 'sonnet.register.v1' ||
      record?.contest_id !== CONTEST.id ||
      !record?.request_id
    ) return null;

    return message;
  } catch {
    return null;
  }
}

function teamProofKey(kind, gameId) {
  return `${TEAM_PROOF_CACHE}:${kind}:${gameId}`;
}

function saveTeamProof(kind, message) {
  if (!state.team.gameId || !message) return;
  try {
    localStorage.setItem(
      teamProofKey(kind, state.team.gameId),
      JSON.stringify(message)
    );
  } catch {
    // Public proof caching is optional.
  }
}

async function loadTeamProof(kind) {
  if (!state.team.gameId) return null;

  try {
    const message = JSON.parse(
      localStorage.getItem(
        teamProofKey(kind, state.team.gameId)
      ) || 'null'
    );

    if (!message) return null;

    if (!(await verifyOfficialRefereeMessage(ROOMS.discovery, message))) {
      return null;
    }

    const record = parseRecord(message.text);

    if (
      !record ||
      record.contest_id !== CONTEST.id ||
      deepFind(record, ['game_id']) !== state.team.gameId ||
      receiptStatus(record) !== 'accepted'
    ) {
      return null;
    }

    return { message, record };
  } catch {
    return null;
  }
}

function nextNonce(room) {
  const key = `sonnet-console-nonce:${state.did}:${room}`;
  const prev = BigInt(localStorage.getItem(key) || '0');
  const now = BigInt(Date.now());
  const value = now > prev ? now : prev + 1n;
  localStorage.setItem(key, value.toString());
  return value.toString();
}

function singleLine(text) {
  return String(text).replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\u2028\u2029]/gu, ' ').replace(/\s+/g, ' ').trim();
}

async function api(path, options = {}) {
  const response = await fetch(path, options);
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); } catch { throw new Error(`Unexpected local response (${response.status}).`); }
  if (!response.ok || payload.ok === false) throw new Error(typeof payload.error === 'string' ? payload.error : JSON.stringify(payload.error || payload));
  return payload;
}

async function readRoom(room, searches = []) {
  const query = new URLSearchParams();
  const values = Array.isArray(searches) ? searches : searches ? [searches] : [];
  for (const value of values) query.append('search', value);
  if (!values.length) query.set('limit', '200');
  const result = await api(`/api/rooms/${encodeURIComponent(room)}?${query}`);
  if (values.length) return { room, generation: Number(result.generation || 0), messages: result.messages || [] };
  const data = result.data || {};
  return { room, generation: Number(data.generation || result.generation || 0), messages: data.messages || [] };
}


async function postSigned(room, recordOrText) {
  if (!state.privateKey || !state.did) {
    throw new Error('Connect your private key first.');
  }

  const text = singleLine(
    typeof recordOrText === 'string'
      ? recordOrText
      : compact(recordOrText)
  );

  const nonce = nextNonce(room);
  const sig = await signRoomMessage(
    state.privateKey,
    state.did,
    room,
    nonce,
    text
  );

  const response = await api(
    `/api/rooms/${encodeURIComponent(room)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        did: state.did,
        nonce,
        sig,
        text
      }),
    }
  );

  return {
    response,
    message: {
      from: state.did,
      nonce,
      sig,
      text,
      ts: new Date().toISOString()
    }
  };
}

async function connectPrivateKey() {
  const seed = $('#privateKey').value.trim();
  const button = $('#connectButton');
  button.disabled = true;
  try {
    const identity = await identityFromPrivateKey(seed);
    state.privateKey = identity.privateKey;
    state.did = identity.did;
    $('#privateKey').value = '';
    if (!state.team.members.length) state.team.members = [state.did];
    saveTeam();
    await refreshAll();
    toast('DID connected. Private key remains only in this browser tab.', 'ok');
  } catch (error) {
    toast(error.message, 'bad');
  } finally {
    button.disabled = false;
    render();
  }
}

function disconnect() {
  state.privateKey = null;
  state.did = '';
  state.registration = null;
  state.registrationReceipt = null;
  state.registrationAccepted = false;
  render();
  toast('Private key removed from browser memory.');
}


async function refreshRegistration() {
  if (!state.did) return;

  const byDid = await readRoom(
    ROOMS.registration,
    state.did
  );

  const registrations = [];

  for (const message of byDid.messages || []) {
    const record = parseRecord(message.text);

    if (
      message.from !== state.did ||
      record?.type !== 'sonnet.register.v1' ||
      record?.contest_id !== CONTEST.id
    ) continue;

    if (await verifyRoomMessage(ROOMS.registration, message)) {
      registrations.push(message);
    }
  }

  if (!registrations.length) {
    const remembered = await loadOwnRegistrationMessage(state.did);
    if (remembered) registrations.push(remembered);
  }

  state.registration = registrations.at(-1) || null;
  state.registrationReceipt = null;
  state.registrationAccepted = false;

  const record = parseRecord(state.registration?.text);
  if (!record?.request_id) return;

  saveOwnRegistrationMessage(state.registration);

  const byRequest = await readRoom(
    ROOMS.registration,
    record.request_id
  );

  const merged = [
    ...(byDid.messages || []),
    ...(byRequest.messages || []),
    state.registration
  ].filter(
    (message, index, all) =>
      all.findIndex(
        (candidate) =>
          candidate &&
          String(candidate.seq ?? candidate.sig) ===
          String(message?.seq ?? message?.sig)
      ) === index
  );

  const found = await findVerifiedReceipt(
    ROOMS.registration,
    merged,
    record.request_id
  );

  state.registrationReceipt = found?.message || null;
  state.registrationAccepted =
    receiptStatus(found?.record) === 'accepted' &&
    record.role === 'writer';
}


async function registerWriter() {
  if (!state.did) {
    return toast('Connect your private key first.', 'bad');
  }

  const handle = $('#xHandle')
    .value
    .trim()
    .replace(/^@/, '');

  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) {
    return toast('Enter a valid X handle.', 'bad');
  }

  const existing = parseRecord(state.registration?.text);

  const record =
    existing ||
    registrationRecord(
      `https://x.com/${handle}`,
      requestId('register')
    );

  try {
    const posted = await postSigned(
      ROOMS.registration,
      record
    );

    saveOwnRegistrationMessage(posted.message);

    await refreshRegistration();
    render();

    toast(
      'Kayıt gönderildi. Doğrulanmış hakem receipt’i bekleniyor.'
    );
  } catch (error) {
    toast(error.message, 'bad');
  }
}


async function memberRegistrationStatus(did) {
  try {
    const byDid = await readRoom(
      ROOMS.registration,
      did
    );

    let registration = null;

    for (const message of [...(byDid.messages || [])].reverse()) {
      const record = parseRecord(message.text);

      if (
        message.from !== did ||
        record?.type !== 'sonnet.register.v1' ||
        record?.contest_id !== CONTEST.id
      ) continue;

      if (await verifyRoomMessage(ROOMS.registration, message)) {
        registration = message;
        break;
      }
    }

    if (!registration) {
      const historical = await historicalWriterEvidenceFor(did);

      if (historical) {
        return {
          status:
            historical.status === 'accepted'
              ? 'historical-accepted'
              : 'historical-record',
          role: historical.role || '',
          requestId: historical.request_id || '',
          source: historical.source || 'watcher-cache'
        };
      }

      return {
        status: 'history-unavailable',
        role: ''
      };
    }

    const record = parseRecord(registration.text);

    const byRequest = await readRoom(
      ROOMS.registration,
      record.request_id
    );

    const receipt = await findVerifiedReceipt(
      ROOMS.registration,
      [
        ...(byDid.messages || []),
        ...(byRequest.messages || [])
      ],
      record.request_id
    );

    return {
      status: receipt
        ? receiptStatus(receipt.record)
        : 'pending',
      role: record.role || '',
      requestId: record.request_id
    };
  } catch {
    return {
      status: 'lookup-unavailable',
      role: ''
    };
  }
}

async function refreshMembers() {
  const map = new Map();
  for (const did of state.team.members) map.set(did, await memberRegistrationStatus(did));
  state.memberStatuses = map;
}


async function refreshDiscovery() {
  state.setupVerified = false;
  state.setupProof = null;
  state.rosterReady = false;

  if (!state.team.gameId) {
    state.discoveryMessages = [];
    return;
  }

  const room = await readRoom(
    ROOMS.discovery,
    state.team.gameId
  );

  state.discoveryMessages = room.messages || [];

  const receipts = await verifiedReceipts(
    ROOMS.discovery,
    state.discoveryMessages
  );

  const expectedRoom = teamRoom(state.team.gameId);

  let teamRoomGeneration = 0;

  try {
    const teamRoomProbe = await readRoom(
      expectedRoom,
      state.team.gameId
    );

    const probedGeneration = Number(
      teamRoomProbe?.generation || 0
    );

    if (
      Number.isSafeInteger(probedGeneration) &&
      probedGeneration > 0
    ) {
      teamRoomGeneration = probedGeneration;
    }
  } catch {
    // A missing/unavailable team room must not manufacture a generation.
  }

  const setupMatches = ({ record }) => {
    if (
      deepFind(record, ['game_id']) !== state.team.gameId ||
      receiptStatus(record) !== 'accepted'
    ) return false;

    const requestId = String(
      deepFind(record, ['request_id']) || ''
    );

    const assigned = deepFind(
      record,
      ['poem_room', 'room']
    );

    const rawGeneration = deepFind(
      record,
      ['room_generation', 'generation']
    );

    const generation = Number(rawGeneration);

    const explicitAllocation =
      assigned === expectedRoom &&
      Number.isSafeInteger(generation) &&
      generation > 0;

    const canonicalSetupReceipt =
      requestId === `setup-${state.team.gameId}` &&
      (!assigned || assigned === expectedRoom) &&
      Number.isSafeInteger(teamRoomGeneration) &&
      teamRoomGeneration > 0 &&
      (
        rawGeneration == null ||
        rawGeneration === '' ||
        (
          Number.isSafeInteger(generation) &&
          generation > 0 &&
          generation === teamRoomGeneration
        )
      );

    return explicitAllocation || canonicalSetupReceipt;
  };

  let setup = [...receipts]
    .reverse()
    .find(setupMatches);

  if (setup) {
    saveTeamProof('setup', setup.message);
  } else {
    const cached = await loadTeamProof('setup');

    if (cached && setupMatches(cached)) {
      setup = cached;
    }
  }

  if (setup) {
    const receiptGeneration = Number(
      deepFind(setup.record, [
        'room_generation',
        'generation'
      ])
    );

    const verifiedGeneration =
      Number.isSafeInteger(receiptGeneration) &&
      receiptGeneration > 0
        ? receiptGeneration
        : teamRoomGeneration;

    if (
      Number.isSafeInteger(verifiedGeneration) &&
      verifiedGeneration > 0
    ) {
      state.setupVerified = true;
      state.team.generation = verifiedGeneration;

      state.setupProof = {
        status: receiptStatus(setup.record),
        requestId: String(
          deepFind(setup.record, ['request_id']) || ''
        ),
        refereeDid: String(
          setup.message?.from || ''
        ),
        signatureVerified: true,
        roomSeq:
          setup.message?.seq ??
          setup.message?.room_seq ??
          '',
        generation: verifiedGeneration,
        generationSource: 'Technocore oda verisi'
      };

      saveTeam();
    }
  }

  const rosterMatches = ({ record }) => {
    if (
      !state.setupVerified ||
      deepFind(record, ['game_id']) !== state.team.gameId ||
      receiptStatus(record) !== 'accepted' ||
      record.roster_ready !== true
    ) return false;

    const assigned = deepFind(
      record,
      ['poem_room', 'room']
    );

    if (assigned && assigned !== expectedRoom) {
      return false;
    }

    const generation = deepFind(
      record,
      ['room_generation', 'generation']
    );

    if (
      generation !== undefined &&
      Number(generation) !== Number(state.team.generation)
    ) {
      return false;
    }

    return true;
  };

  let ready = [...receipts]
    .reverse()
    .find(rosterMatches);

  if (ready) {
    saveTeamProof('roster-ready', ready.message);
  } else {
    const cached = await loadTeamProof('roster-ready');

    if (cached && rosterMatches(cached)) {
      ready = cached;
    }
  }

  state.rosterReady = Boolean(ready);

  saveTeam();
}


async function refreshTeamRoom() {
  if (
    !state.team.gameId ||
    !state.setupVerified ||
    !state.team.generation
  ) {
    state.teamMessages = [];
    return;
  }

  const roomName = teamRoom(state.team.gameId);

  const room = await readRoom(
    roomName,
    state.team.gameId
  );

  state.teamMessages = room.messages || [];

  state.current = await extractTeamState(
    state.teamMessages,
    roomName
  );

  await rebuildPoem();
}

async function refreshAll() {
  if (!state.did) return render();
  try {
    await refreshRegistration();
    await refreshMembers();
    await refreshDiscovery();
    await refreshTeamRoom();
    render();
  } catch (error) {
    toast(error.message, 'bad');
  }
}


function addMember() {
  if (state.rosterReady) {
    return toast(
      'Hakem bu takım listesini zaten sabitledi.',
      'bad'
    );
  }

  const did = $('#memberDid').value.trim();

  try {
    if (!DID_RE.test(did)) {
      throw new Error(
        'Enter a valid Ed25519 did:key.'
      );
    }

    if (state.team.members.includes(did)) {
      throw new Error(
        'That DID is already in the roster.'
      );
    }

    if (state.team.members.length >= 8) {
      throw new Error(
        'Bir takım listesinde en fazla 8 yazar olabilir.'
      );
    }

    state.team.members.push(did);
    $('#memberDid').value = '';

    saveTeam();

    refreshMembers().then(render);
    render();
  } catch (error) {
    toast(error.message, 'bad');
  }
}


function setGameId() {
  if (state.setupVerified || state.rosterReady) {
    $('#gameId').value = state.team.gameId;

    return toast(
      'Doğrulanmış kurulum receipt’inden sonra Takım ID değiştirilemez.',
      'bad'
    );
  }

  const gameId = $('#gameId')
    .value
    .trim()
    .toLowerCase();

  if (gameId && !GAME_ID_RE.test(gameId)) {
    return toast(
      'Takım ID 1–16 karakter olmalı; yalnızca küçük harf, rakam, - veya _ kullanılabilir.',
      'bad'
    );
  }

  state.team.gameId = gameId;
  state.team.generation = 0;
  state.setupVerified = false;
  state.rosterReady = false;

  saveTeam();
  render();
}


async function requestRoom() {
  try {
    validateMembers(state.team.members);

    if (!GAME_ID_RE.test(state.team.gameId)) {
      throw new Error(
        'Choose a valid team ID first.'
      );
    }

    if (state.setupVerified) {
      throw new Error(
        'This team already has a cryptographically verified setup receipt.'
      );
    }

    await postSigned(
      ROOMS.discovery,
      teamRequestRecord(
        state.team.gameId,
        requestId('room')
      )
    );

    await refreshDiscovery();
    render();

    toast(
      'Takım odası isteği gönderildi. Hakem uygunluğu kontrol edip imzalı kurulum receipt’i döndürecek.'
    );
  } catch (error) {
    toast(error.message, 'bad');
  }
}


async function signRoster() {
  try {
    validateMembers(state.team.members);

    if (!state.team.members.includes(state.did)) {
      throw new Error(
        'DID’in bu takım listesinde bulunmuyor.'
      );
    }

    if (
      !state.setupVerified ||
      !state.team.generation
    ) {
      throw new Error(
        'Önce kriptografik olarak doğrulanmış hakem kurulum receipt’ini bekle.'
      );
    }

    if (state.rosterReady) {
      throw new Error(
        'Hakem bu takım listesini zaten hazır olarak işaretledi.'
      );
    }

    await postSigned(
      ROOMS.discovery,
      rosterRecord(
        state.team.gameId,
        state.team.generation,
        state.team.members,
        requestId('roster')
      )
    );

    await refreshDiscovery();
    render();

    toast(
      'Takım listesi onayın gönderildi. Listelenen her yazar aynı sıralı listeyi imzalamalı. Doğrulanmış hakem receipt’i roster_ready:true bildirene kadar gerçek şiir gönderimi kilitli kalır.'
    );
  } catch (error) {
    toast(error.message, 'bad');
  }
}

async function loadDictionary() {
  if (state.dictionaryReady) return;
  const response = await fetch('/api/dictionary');
  if (!response.ok) throw new Error('Resmi CMUdict yüklenemedi.');
  const text = await response.text();
  const map = new Map();
  for (const line of text.split('\n')) {
    const clean = line.split('#', 1)[0].trim();
    if (!clean || clean.startsWith(';;;')) continue;
    const fields = clean.split(/\s+/);
    if (fields.length < 2) continue;
    const word = fields[0].replace(/\(\d+\)$/, '').toLowerCase();
    if (!/^[a-z]+(?:'[a-z]+)*$/.test(word)) continue;
    const count = fields.slice(1).filter((p) => /[012]$/.test(p)).length;
    map.set(word, Math.max(map.get(word) || 0, count));
  }
  state.dictionary = map;
  state.dictionaryReady = true;
}

function bareWord(token) {
  return String(token || '').replace(/[,.;:!?]$/, '').toLowerCase();
}

function syllablesOf(word) {
  return state.dictionary?.get(bareWord(word)) || 0;
}

function reconstructLines(words) {
  if (!state.dictionaryReady) return '';
  const lines = [];
  let current = [];
  let count = 0;
  for (const word of words) {
    const syllables = syllablesOf(word);
    if (!syllables) return '';
    if (count + syllables > 10) return '';
    current.push(word);
    count += syllables;
    if (count === 10) {
      lines.push(current.join(' '));
      current = [];
      count = 0;
    }
  }
  if (current.length) lines.push(current.join(' '));
  return lines.map((line, index) => [3,7,11].includes(index) ? `${line}\n` : line).join('\n');
}

async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function rebuildPoem() {
  await loadDictionary();
  state.poem = reconstructLines(effectiveAcceptedWords());
  state.poemHash = state.poem ? await sha256(state.poem) : '';
}

function currentLineSyllables() {
  if (!state.dictionaryReady) return 0;
  const lines = String(state.poem || '').split('\n').filter((_, i, a) => i < a.length - 1 || a[i]);
  const last = lines.at(-1) || '';
  return last.split(/\s+/).filter(Boolean).reduce((sum, word) => sum + syllablesOf(word), 0);
}

async function validateWord() {
  try { await loadDictionary(); } catch (error) { return toast(error.message, 'bad'); }
  const word = $('#word').value.trim();
  const syntax = WORD_RE.test(word);
  const letters = syntax && didAllowsWord(state.did, word);
  const syllables = syntax ? syllablesOf(word) : 0;
  const used = currentLineSyllables();
  const fits = Boolean(syllables) && used + syllables <= 10;
  const turn = !state.current.lastContributor || state.current.lastContributor !== state.did;
  $('#wordMeta').textContent = word ? `${letters ? 'harfler ✓' : 'harfler ✕'} · ${syllables || '?'} hece · ${fits ? 'sığıyor ✓' : 'sığmıyor ✕'} · ${turn ? 'sıra uygun ✓' : 'sıra uygun değil ✕'}` : '';
  $('#sendWord').disabled = !(state.rosterReady && state.team.generation && syntax && letters && syllables && fits && turn && /^[a-f0-9]{64}$/i.test(state.current.stateHash || ''));
  renderSuggestions();
  renderTeamWordMatrix();
}

function renderTeamWordMatrix() {
  const box = $('#teamWordMatrix');
  const input = $('#teamWordCheck');

  if (!box || !input) return;

  const word = input.value.trim();
  const syntax = WORD_RE.test(word);
  const syllables = syntax
    ? syllablesOf(word)
    : 0;

  if (!word) {
    box.innerHTML =
      '<p class="muted">Dört yazarı karşılaştırmak için bir kelime yaz.</p>';
    return;
  }

  box.innerHTML = state.team.members.map((did) => {
    const allowed =
      syntax &&
      didAllowsWord(did, word);

    return `
      <div class="member">
        <code title="${esc(did)}">
          ${esc(writerName(did))} · ${esc(shortDid(did))}
        </code>
        <span>
          ${allowed ? 'kullanabilir ✓' : 'kullanamaz ✕'}
          ·
          ${syllables || '?'} hece
        </span>
      </div>
    `;
  }).join('');
}

const COMMON = `a i an as at be by do go he if in is it me my no of on or so to up us we all and any are but can day end eye far few for from get had has have her him his how its let like long look made make man may men more most much must new not now off old one only other our out own part put run said same say see she should since small some still such take than that the their them then there these they thing think this those though three time too two under upon use very was way well went were what when where which while who why will with word work world would year yes yet you your after again air always another around away back before being best between black book both bring call came care change close cold come could dark done door down dream each early earth easy even ever every face fall family feel find fire first follow food foot found free friend full gave give given gold gone good got great green ground grow hand happy hard head hear heard heart help here high hold home hope hour house idea into keep kept kind knew know known land large last late learn leave left less life light line little live lost love low mean meet might mind miss moon morning mother move music name near need never next night nothing once open order over page pass past peace people place plant play point poor power rain read ready real red remember rest return right river road rock room rose round school sea second seem seen send sense set shape share ship short show side sight sign silent sing sit sky sleep slow snow soft song soon sound south space speak stand star start state stay step stood stop story street strong sun sure sweet talk teach tell thank thin thought through throw tired today together told took top toward town tree true try turn understand until voice wait walk wall want war warm watch water wave wear week white whole wide wild wind window winter wish wonder wood wrote young`.split(/\s+/);

function renderSuggestions() {
  const box = $('#suggestions');
  if (!state.dictionaryReady || !state.did) { box.innerHTML = ''; return; }
  const used = currentLineSyllables();
  const budget = 10 - used;
  const prefix = $('#word').value.trim().toLowerCase();
  const source = prefix ? [...state.dictionary.keys()].filter((w) => w.startsWith(prefix)).slice(0, 8000) : COMMON;
  const matches = [];
  for (const word of source) {
    const s = syllablesOf(word);
    if (!s || s > budget || !didAllowsWord(state.did, word)) continue;
    matches.push({ word, s });
    if (matches.length >= 30) break;
  }
  box.innerHTML = matches.map((x) => `<button type="button" data-word="${esc(x.word)}">${esc(x.word)} <small>${x.s}</small></button>`).join('');
}




function previewAcceptedKey() {
  return `sonnet-console-preview-words:${state.team?.gameId || 'no-team'}`;
}

function loadPreviewAccepted() {
  try {
    const value = JSON.parse(
      localStorage.getItem(previewAcceptedKey()) || '[]'
    );

    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function savePreviewAccepted(value) {
  try {
    localStorage.setItem(
      previewAcceptedKey(),
      JSON.stringify(Array.isArray(value) ? value.slice(-200) : [])
    );
  } catch {
    // Önizleme verisi yalnızca yereldir.
  }
}

function previewModeActive() {
  return Boolean(
    state.setupVerified &&
    !state.rosterReady
  );
}

function effectiveAcceptedWords() {
  const official = state.current.acceptedWords || [];

  if (!previewModeActive()) {
    return official;
  }

  return [
    ...official,
    ...loadPreviewAccepted().map((item) => item.word)
  ];
}

function poemDraftKey() {
  return `sonnet-console-poem-draft:${state.team?.gameId || 'no-team'}`;
}

function loadPoemDraft() {
  try {
    return localStorage.getItem(poemDraftKey()) || '';
  } catch {
    return '';
  }
}

function savePoemDraft(value) {
  try {
    localStorage.setItem(poemDraftKey(), String(value || ''));
  } catch {
    // Taslak kaydı isteğe bağlı yerel veridir.
  }
}

function normalizeDraftWord(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/^[^a-z]+|[^a-z]+$/g, '');
}

function renderPoemDraft() {
  const preview = $('#draftPreview');
  const progress = $('#draftProgress');
  const meta = $('#draftMeta');
  const warning = $('#draftMismatch');
  const uploadButton = $('#uploadPoemDraft');
  const clearButton = $('#clearPoemDraft');

  if (
    !preview ||
    !progress ||
    !meta ||
    !warning ||
    !uploadButton ||
    !clearButton
  ) return;

  const raw = loadPoemDraft();

  const lines = raw
    ? raw.replace(/\r/g, '').split('\n')
    : [];

  const accepted = effectiveAcceptedWords()
    .map((word) => ({
      raw: String(word),
      norm: normalizeDraftWord(word)
    }))
    .filter((item) => item.norm);

  if (!raw.trim()) {
    preview.innerHTML =
      '<p class="muted">14 dizelik şiir taslağını .txt dosyası olarak yükle.</p>';

    progress.textContent = '0 / 0';
    progress.className = 'badge pending';

    meta.textContent =
      'Taslak henüz yüklenmedi.';

    uploadButton.textContent =
      'TXT taslağı yükle';

    clearButton.classList.add('hidden');

    warning.classList.add('hidden');
    warning.textContent = '';

    return;
  }

  uploadButton.textContent =
    'TXT taslağını değiştir';

  clearButton.classList.remove('hidden');

  let matched = 0;
  let totalWords = 0;
  let conflict = null;
  let globalTokenIndex = 0;

  const renderedLines = lines.map((line) => {
    const words = line.trim()
      ? line.trim().split(/\s+/)
      : [];

    totalWords += words.length;

    const renderedWords = words.map((rawWord) => {
      const norm = normalizeDraftWord(rawWord);
      let cls = 'draft-word';

      if (!conflict && matched < accepted.length) {
        const expected = accepted[matched];

        if (norm === expected.norm) {
          cls += ' done';
          matched += 1;
        } else {
          cls += ' conflict';

          conflict = {
            position: matched + 1,
            accepted: expected.raw,
            draft: rawWord
          };
        }
      } else if (
        !conflict &&
        matched === accepted.length &&
        globalTokenIndex === matched
      ) {
        cls += ' next';
      }

      globalTokenIndex += 1;

      return `<span class="${cls}">${esc(rawWord)}</span>`;
    });

    return `<div class="draft-line">${renderedWords.join(' ')}</div>`;
  });

  preview.innerHTML = renderedLines.join('');

  progress.textContent =
    `${matched} / ${totalWords} kelime`;

  progress.className =
    matched > 0
      ? 'badge accepted'
      : 'badge pending';

  const nonEmptyLines =
    lines.filter((line) => line.trim()).length;

  meta.textContent =
    `${nonEmptyLines} / 14 dize · ${totalWords} kelime · ${accepted.length} kabul edilen kelime`;

  if (conflict) {
    warning.textContent =
      `Taslak resmi şiirle uyuşmuyor. ${conflict.position}. kabul edilen kelime "${conflict.accepted}", taslakta ise "${conflict.draft}" görünüyor.`;

    warning.classList.remove('hidden');
  } else if (nonEmptyLines !== 14) {
    warning.textContent =
      `Taslakta ${nonEmptyLines} dize var. Sonnet için 14 dize olmalı.`;

    warning.classList.remove('hidden');
  } else {
    warning.textContent = '';
    warning.classList.add('hidden');
  }
}

function lastWordAttemptKey() {
  if (!state.team.gameId || !state.did) return '';
  return `sonnet-console-last-word:${state.team.gameId}:${state.did}`;
}

function saveLastWordAttempt(value) {
  const key = lastWordAttemptKey();
  if (!key) return;

  try {
    localStorage.setItem(
      key,
      JSON.stringify(value)
    );
  } catch {
    // Yerel durum kaydı isteğe bağlıdır.
  }
}

function loadLastWordAttempt() {
  const key = lastWordAttemptKey();
  if (!key) return null;

  try {
    const value = JSON.parse(
      localStorage.getItem(key) || 'null'
    );

    return value &&
      value.requestId &&
      value.word
        ? value
        : null;
  } catch {
    return null;
  }
}

function renderLastWordStatus() {
  const box = $('#lastWordStatus');
  if (!box) return;

  const attempt = loadLastWordAttempt();

  if (!attempt) {
    box.classList.add('hidden');
    return;
  }

  box.classList.remove('hidden');

  const receipt = [...(state.current.receipts || [])]
    .reverse()
    .find(({ record }) =>
      referencedRequestId(record) === attempt.requestId ||
      JSON.stringify(record).includes(attempt.requestId)
    );

  const status =
    attempt.preview === true &&
    attempt.previewStatus
      ? attempt.previewStatus
      : receipt
        ? receiptStatus(receipt.record)
        : 'pending';

  const reason = receipt
    ? deepFind(
        receipt.record,
        ['reason', 'reason_code', 'error', 'detail']
      )
    : '';

  $('#lastWordValue').textContent =
    attempt.word;

  $('#lastWordWriter').textContent =
    attempt.writer || writerName(attempt.did);

  $('#lastWordRequest').textContent =
    attempt.requestId;

  const badge = $('#lastWordBadge');

  if (status === 'accepted') {
    badge.textContent = 'KABUL EDİLDİ ✓';
    badge.className = 'badge accepted';

    $('#lastWordResult').textContent =
      'Hakem kelimeyi kabul etti.';
  } else if (status === 'rejected') {
    badge.textContent = 'REDDEDİLDİ ✕';
    badge.className = 'badge rejected';

    $('#lastWordResult').textContent =
      'Hakem kelimeyi reddetti.';
  } else {
    badge.textContent = 'HAKEM BEKLENİYOR';
    badge.className = 'badge pending';

    $('#lastWordResult').textContent =
      'Doğrulanmış hakem receipt’i bekleniyor.';
  }

  const reasonBox = $('#lastWordReason');

  if (status === 'rejected' && reason) {
    reasonBox.textContent =
      `Neden: ${String(reason)}`;

    reasonBox.classList.remove('hidden');
  } else {
    reasonBox.textContent = '';
    reasonBox.classList.add('hidden');
  }
}



async function resetPreviewTestData() {
  if (!previewModeActive()) {
    return;
  }

  if (
    !confirm(
      'Yerel test kelimeleri sıfırlansın mı? Şiir taslağı korunacak.'
    )
  ) return;

  try {
    localStorage.removeItem(
      previewAcceptedKey()
    );

    const attempt = loadLastWordAttempt();

    if (attempt?.preview === true) {
      localStorage.removeItem(
        lastWordAttemptKey()
      );
    }

    await rebuildPoem();
    render();

    toast(
      'Önizleme test verileri sıfırlandı. Şiir taslağı korundu.'
    );
  } catch (error) {
    toast(error.message, 'bad');
  }
}

async function previewWordTest() {
  try {
    if (state.rosterReady) {
      throw new Error(
        'Takım hazır olduğunda test modu kullanılmaz.'
      );
    }

    await loadDictionary();

    const word = $('#word').value.trim();

    if (!WORD_RE.test(word)) {
      throw new Error(
        'Önce geçerli bir İngilizce kelime yaz.'
      );
    }

    if (!didAllowsWord(state.did, word)) {
      throw new Error(
        'Bu kelime senin DID harflerinle kullanılamıyor.'
      );
    }

    const syllables = syllablesOf(word);

    if (!syllables) {
      throw new Error(
        'Kelime sabit CMUdict sözlüğünde bulunamadı.'
      );
    }

    const reqId =
      `preview-word-${Date.now()}`;

    saveLastWordAttempt({
      word,
      requestId: reqId,
      did: state.did,
      writer: writerName(state.did),
      submittedAt: Date.now(),
      preview: true,
      previewStatus: 'pending'
    });

    renderLastWordStatus();
  renderPoemDraft();

    toast(
      'TEST: Kelime gönderildi. Hakem sonucu simüle ediliyor.'
    );

    setTimeout(() => {
      const attempt = loadLastWordAttempt();

      if (
        !attempt ||
        attempt.requestId !== reqId ||
        attempt.preview !== true
      ) return;

      attempt.previewStatus = 'accepted';
      attempt.previewAcceptedAt = Date.now();

      saveLastWordAttempt(attempt);

      const previewWords = loadPreviewAccepted();

      if (
        !previewWords.some(
          (item) => item.requestId === reqId
        )
      ) {
        previewWords.push({
          requestId: reqId,
          word,
          did: state.did,
          writer: writerName(state.did),
          acceptedAt: Date.now()
        });

        savePreviewAccepted(previewWords);
      }

      rebuildPoem().then(() => {
        render();
        renderPoemDraft();
      });

      toast(
        'TEST: Kelime kabul edildi. Taslak ve canlı şiir önizlemesi güncellendi.'
      );
    }, 2000);

  } catch (error) {
    toast(error.message, 'bad');
  }
}

async function sendWord() {
  try {
    const word = $('#word').value.trim();
    const reqId = requestId('word');

    const record = wordRecord(
      state.team.gameId,
      state.team.generation,
      state.current.version,
      state.current.stateHash,
      word,
      reqId
    );

    await postSigned(
      teamRoom(state.team.gameId),
      record
    );

    saveLastWordAttempt({
      word,
      requestId: reqId,
      did: state.did,
      writer: writerName(state.did),
      submittedAt: Date.now()
    });

    $('#word').value = '';

    await refreshTeamRoom();

    render();

    toast(
      'Kelime gönderildi. Hakem sonucu bekleniyor.'
    );
  } catch (error) {
    toast(error.message, 'bad');
  }
}

async function sendPlanningMessage() {
  const input = $('#planning');
  const text = input.value.trim();

  if (!text || !state.did) return;

  try {
    const workspace =
      await privateWorkspaceRequest(
        'POST',
        {
          action: 'chat.append',
          did: state.did,
          text
        }
      );

    applySharedPrivateWorkspace(
      workspace
    );

    input.value = '';

    renderWorkspace();
  } catch (error) {
    toast(
      error.message,
      'bad'
    );
  }
}

function parsePostIds(value) {
  return String(value).split(/\s+/).map((item) => item.match(/status\/(\d{5,30})/)?.[1] || item.match(/^\d{5,30}$/)?.[0] || '').filter(Boolean);
}

async function submitPoem() {
  try {
    if (!state.current.complete) throw new Error('Hakem şiiri henüz tamamlanmış olarak işaretlemedi.');
    if (state.current.lastContributor !== state.did) throw new Error('Şiiri yalnızca son katkıyı yapan yazar gönderebilir.');
    if (!state.poem || !state.poemHash) throw new Error('Kanonik şiir yeniden oluşturulamadı.');
    const ids = parsePostIds($('#xPosts').value);
    const record = submitRecord(state.team.gameId, state.team.generation, state.current.version, state.poemHash, ids, requestId('submit'));
    await postSigned(ROOMS.submissions, record);
    toast('Final gönderimi yapıldı. Resmi doğrulanmış hakem receipt’ini bekle.');
  } catch (error) { toast(error.message, 'bad'); }
}


function memberLabel(did) {
  const status = state.memberStatuses.get(did);

  if (!status) return 'kontrol ediliyor';

  if (
    status.role &&
    status.role !== 'writer'
  ) {
    return status.role;
  }

  if (status.status === 'accepted') {
    return 'kabul edildi';
  }

  if (status.status === 'rejected') {
    return 'reddedildi';
  }

  if (status.status === 'pending') {
    return 'receipt bekleniyor';
  }

  if (status.status === 'historical-accepted') {
    return 'geçmişte kabul edildi';
  }

  if (status.status === 'historical-record') {
    return 'geçmiş kaydı';
  }

  if (
    status.status === 'history-unavailable'
  ) {
    return 'geçmiş bulunamadı';
  }

  return 'doğrulama yapılamadı';
}

function renderIdentity() {
  $('#connectPanel').classList.toggle('hidden', Boolean(state.did));
  $('#identityPanel').classList.toggle('hidden', !state.did);
  $('#did').textContent = state.did || '—';
}

function renderRegistration() {
  const recoveryBadge = $('#registrationStatus');
  if (recoveryBadge?.dataset.recoveryOwned === 'true') return;
  const record = parseRecord(state.registration?.text);
  const receipt = parseRecord(state.registrationReceipt?.text);
  const status = state.registrationReceipt ? receiptStatus(receipt) : state.registration ? 'pending' : state.did ? 'checking' : 'not-registered';
  $('#registrationStatus').textContent = statusLabelTr(status);
  $('#registrationStatus').className = `badge ${status}`;
  $('#registrationRequest').textContent = record?.request_id || '—';
  $('#registerWriter').disabled = !state.did || state.registrationAccepted;
  $('#xHandle').disabled = Boolean(state.registration);
  if (record?.x_account_url && !$('#xHandle').value) $('#xHandle').value = record.x_account_url.split('/').filter(Boolean).at(-1) || '';
  const reason = deepFind(receipt, ['reason', 'reason_code', 'error', 'detail']);
  $('#registrationNote').textContent = status === 'accepted' ? 'Resmi hakem receipt’i doğrulandı.' : status === 'rejected' ? `Reddedildi: ${reason || 'neden belirtilmedi'}` : status === 'pending' ? 'Kayıt mevcut; henüz doğrulanmış hakem kararı bulunamadı.' : status === 'checking' ? 'DID üzerinden kayıt geçmişi kontrol ediliyor…' : 'Saklanan oda geçmişinde yazar kaydı bulunamadı.';
}


function renderTeam() {
  $('#gameId').value = state.team.gameId;

  $('#gameId').disabled =
    state.setupVerified ||
    state.rosterReady;

  $('#generation').textContent =
    state.setupVerified
      ? String(state.team.generation || '—')
      : '—';

  const proof = state.setupProof;
  $('#setupProof').classList.toggle(
    'hidden',
    !proof
  );

  if (proof) {
    $('#setupProofStatus').textContent =
      String(proof.status || '—').toUpperCase();

    $('#setupProofRequest').textContent =
      proof.requestId || '—';

    $('#setupProofReferee').textContent =
      proof.refereeDid
        ? shortDid(proof.refereeDid)
        : '—';

    $('#setupProofReferee').title =
      proof.refereeDid || '';

    $('#setupProofSignature').textContent =
      proof.signatureVerified
        ? 'Doğrulandı'
        : '—';

    $('#setupProofSeq').textContent =
      String(proof.roomSeq || '—');

    $('#setupProofGeneration').textContent =
      proof.generation
        ? `${proof.generation} · ${proof.generationSource}`
        : '—';
  }

  $('#memberCount').textContent =
    `${state.team.members.length} / 8`;

  $('#members').innerHTML =
    state.team.members.map((did) => `
      <div class="member">
        <code title="${esc(did)}">
          ${esc(shortDid(did))}
        </code>
        <span>${esc(memberLabel(did))}</span>
        <button
          type="button"
          data-remove="${esc(did)}"
          ${
            did === state.did ||
            state.rosterReady
              ? 'disabled'
              : ''
          }
        >×</button>
      </div>
    `).join('') ||
    '<p class="muted">No members yet.</p>';

  let rosterValid = false;

  try {
    validateMembers(state.team.members);
    rosterValid = true;
  } catch {
    rosterValid = false;
  }

  $('#memberDid').disabled =
    state.rosterReady;

  $('#addMember').disabled =
    state.rosterReady ||
    state.team.members.length >= 8;

  $('#requestRoom').disabled = !(
    state.did &&
    GAME_ID_RE.test(state.team.gameId) &&
    rosterValid &&
    !state.setupVerified &&
    !state.rosterReady
  );

  $('#signRoster').disabled = !(
    state.did &&
    state.setupVerified &&
    rosterValid &&
    !state.rosterReady &&
    state.team.members.includes(state.did)
  );

  $('#rosterState').textContent =
    state.rosterReady
      ? 'HAZIR'
      : state.setupVerified
        ? 'ODA DOĞRULANDI · TAKIM LİSTESİNİ İMZALA'
        : 'HAZIR DEĞİL';

  $('#rosterState').className =
    `badge ${
      state.rosterReady
        ? 'accepted'
        : 'pending'
    }`;
}

function renderWorkspace() {
  const workspaceAvailable =
    state.setupVerified ||
    state.rosterReady;

  const preview =
    workspaceAvailable &&
    !state.rosterReady;

  $('#workspaceLocked').classList.toggle(
    'hidden',
    workspaceAvailable
  );

  $('#workspace').classList.toggle(
    'hidden',
    !workspaceAvailable
  );

  if (!workspaceAvailable) return;

  $('#previewBanner').classList.toggle(
    'hidden',
    !preview
  );

  $('#previewWordTest').classList.toggle(
    'hidden',
    !preview
  );
  $('#teamRoom').textContent = teamRoom(state.team.gameId);
  $('#version').textContent = String(state.current.version || 0);
  $('#line').textContent = `${state.current.line || 1} / 14`;
  $('#stateHash').textContent = state.current.stateHash || '—';
  $('#lastContributor').textContent = shortDid(state.current.lastContributor);
  $('#poem').textContent = state.poem || 'Kabul edilen kelimeler burada görünecek.';
  $('#completeBadge').textContent = state.current.complete ? 'TAMAMLANDI' : 'YAZILIYOR';
  $('#completeBadge').className = `badge ${state.current.complete ? 'accepted' : 'pending'}`;
  $('#submitPanel').classList.toggle(
    'hidden',
    !state.rosterReady ||
    !(state.current.complete && state.current.lastContributor === state.did)
  );
  $('#poemHash').textContent = state.poemHash || '—';
  loadPrivateChat();

  $('#roomFeed').innerHTML =
    state.privateChatMessages.length
      ? state.privateChatMessages.slice(-80).map((m) => {
          const mine = m.did === state.did;

          return `
            <article class="message ${mine ? 'mine' : ''}">
              <div>
                <span>
                  ${esc(m.name || writerName(m.did))}
                </span>
                <time>
                  ${esc(
                    new Date(m.ts)
                      .toLocaleTimeString(
                        'tr-TR',
                        {
                          hour: '2-digit',
                          minute: '2-digit'
                        }
                      )
                  )}
                </time>
              </div>
              <pre>${esc(m.text)}</pre>
            </article>
          `;
        }).join('')
      : '<p class="muted">Henüz takım mesajı yok.</p>';

  const chatFeed = $('#roomFeed');
  requestAnimationFrame(() => {
    if (chatFeed) {
      chatFeed.scrollTop = chatFeed.scrollHeight;
    }
  });
  validateWord();
  renderLastWordStatus();

  const sender = $('#wordSender');

  if (sender) {
    if (!state.did) {
      sender.textContent = '';
      sender.className = 'word-sender hidden';
    } else if (
      state.current.lastContributor &&
      state.current.lastContributor === state.did
    ) {
      sender.textContent =
        `Gönderen: ${writerName(state.did)} · bağlı kimlik · Bu tur başka bir takım üyesi göndermeli.`;

      sender.className = 'word-sender blocked';
    } else {
      sender.textContent =
        `Gönderen: ${writerName(state.did)} · bağlı kimlik`;

      sender.className = 'word-sender';
    }
  }
}

function render() {
  renderIdentity();
  renderRegistration();
  renderTeam();
  renderWorkspace();
}

function bind() {
  $('#connectButton').addEventListener('click', connectPrivateKey);
  $('#privateKey').addEventListener('keydown', (e) => { if (e.key === 'Enter') connectPrivateKey(); });
  $('#disconnect').addEventListener('click', disconnect);
  $('#refresh').addEventListener('click', refreshAll);
  $('#registerWriter').addEventListener('click', registerWriter);
  $('#gameId').addEventListener('change', setGameId);
  $('#addMember').addEventListener('click', addMember);
  $('#requestRoom').addEventListener('click', requestRoom);
  $('#signRoster').addEventListener('click', signRoster);
  $('#word').addEventListener('input', validateWord);
  $('#sendWord').addEventListener('click', sendWord);
  $('#previewWordTest').addEventListener('click', previewWordTest);
  $('#resetPreviewData').addEventListener('click', resetPreviewTestData);
  $('#planningSend').addEventListener('click', sendPlanningMessage);

  $('#uploadPoemDraft').addEventListener('click', () => {
    $('#poemDraftFile').click();
  });

  $('#poemDraftFile').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];

    if (!file) return;

    if (
      !file.name.toLowerCase().endsWith('.txt') &&
      file.type !== 'text/plain'
    ) {
      event.target.value = '';
      return toast(
        'Şiir taslağı .txt dosyası olmalı.',
        'bad'
      );
    }

    const existing = loadPoemDraft();

    if (
      existing.trim() &&
      !confirm(
        'Mevcut şiir taslağı yeni TXT dosyasıyla değiştirilsin mi?'
      )
    ) {
      event.target.value = '';
      return;
    }

    const text = (await file.text())
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .trim();

    if (!text) {
      event.target.value = '';
      return toast(
        'TXT dosyası boş.',
        'bad'
      );
    }

    try {
      await saveSharedDraft(text);

      event.target.value = '';

      toast(
        'Şiir taslağı takım çalışma alanına yüklendi ve kilitlendi.'
      );
    } catch (error) {
      event.target.value = '';

      toast(
        error.message,
        'bad'
      );
    }
  });

  $('#clearPoemDraft').addEventListener('click', async () => {
    if (
      !confirm(
        'Şiir taslağı takım çalışma alanından kaldırılsın mı?'
      )
    ) return;

    try {
      await clearSharedDraft();

      toast(
        'Şiir taslağı takım çalışma alanından kaldırıldı.'
      );
    } catch (error) {
      toast(
        error.message,
        'bad'
      );
    }
  });

  $('#planning').addEventListener('keydown', (event) => {
    if (
      event.key === 'Enter' &&
      !event.shiftKey
    ) {
      event.preventDefault();
      sendPlanningMessage();
    }
  });

  $('#teamWordCheck').addEventListener(
    'input',
    async () => {
      try {
        await loadDictionary();
        renderTeamWordMatrix();
      } catch (error) {
        toast(error.message, 'bad');
      }
    }
  );
  $('#submitPoem').addEventListener('click', submitPoem);
  $('#suggestions').addEventListener('click', (e) => {
    const button = e.target.closest('[data-word]');
    if (!button) return;
    $('#word').value = button.dataset.word;
    validateWord();
  });
  $('#members').addEventListener('click', (e) => {
    const button = e.target.closest('[data-remove]');
    if (!button) return;
    if (state.rosterReady) return toast('Hakem bu takım listesini zaten sabitledi.', 'bad');
    state.team.members = state.team.members.filter((did) => did !== button.dataset.remove);
    saveTeam();
    render();
  });
  $$('.nav button').forEach((button) => button.addEventListener('click', () => {
    $$('.nav button').forEach((b) => b.classList.toggle('active', b === button));
    $$('.view').forEach((view) => view.classList.toggle('active', view.id === button.dataset.view));
  }));
}

bind();
render();
setInterval(() => { if (state.did) refreshAll(); }, 15000);


const sonnetPrivateWorkspacePoll =
  setInterval(() => {
    if (!document.hidden) {
      void refreshPrivateWorkspace({
        quiet: true
      });
    }
  }, 5000);

window.addEventListener(
  'focus',
  () => {
    void refreshPrivateWorkspace({
      quiet: true
    });
  }
);

setTimeout(
  () => {
    void refreshPrivateWorkspace({
      quiet: true
    });
  },
  750
);
