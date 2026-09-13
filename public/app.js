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
  team: loadTeam(),
  dictionary: null,
  dictionaryReady: false,
  discoveryMessages: [],
  teamMessages: [],
  current: { version: 0, stateHash: '', line: 1, complete: false, lastContributor: '', acceptedWords: [] },
  rosterReady: false,
  memberStatuses: new Map(),
  poem: '',
  poemHash: '',
};

function esc(v) {
  return String(v ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
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
  if (!state.privateKey || !state.did) throw new Error('Connect your private key first.');
  const text = singleLine(typeof recordOrText === 'string' ? recordOrText : compact(recordOrText));
  const nonce = nextNonce(room);
  const sig = await signRoomMessage(state.privateKey, state.did, room, nonce, text);
  return api(`/api/rooms/${encodeURIComponent(room)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ did: state.did, nonce, sig, text }),
  });
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
  const byDid = await readRoom(ROOMS.registration, state.did);
  const registrations = (byDid.messages || []).filter((m) => {
    const r = parseRecord(m.text);
    return m.from === state.did && r?.type === 'sonnet.register.v1' && r?.contest_id === CONTEST.id;
  });
  state.registration = registrations.at(-1) || null;
  state.registrationReceipt = null;
  state.registrationAccepted = false;
  const record = parseRecord(state.registration?.text);
  if (!record?.request_id) return;
  const byRequest = await readRoom(ROOMS.registration, record.request_id);
  const merged = [...byDid.messages, ...byRequest.messages].filter((m, i, arr) => arr.findIndex((x) => String(x.seq) === String(m.seq)) === i);
  const found = await findVerifiedReceipt(ROOMS.registration, merged, record.request_id);
  state.registrationReceipt = found?.message || null;
  state.registrationAccepted = receiptStatus(found?.record) === 'accepted' && record.role === 'writer';
}

async function registerWriter() {
  if (!state.did) return toast('Connect your private key first.', 'bad');
  const handle = $('#xHandle').value.trim().replace(/^@/, '');
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) return toast('Enter a valid X handle.', 'bad');
  const existing = parseRecord(state.registration?.text);
  const record = existing || registrationRecord(`https://x.com/${handle}`, requestId('register'));
  try {
    await postSigned(ROOMS.registration, record);
    await refreshRegistration();
    render();
    toast('Registration posted. Waiting for a verified referee receipt.');
  } catch (error) { toast(error.message, 'bad'); }
}

async function memberRegistrationStatus(did) {
  try {
    const byDid = await readRoom(ROOMS.registration, did);
    const reg = [...byDid.messages].reverse().find((m) => {
      const r = parseRecord(m.text);
      return m.from === did && r?.type === 'sonnet.register.v1' && r?.contest_id === CONTEST.id;
    });
    if (!reg) return { status: 'not-found', role: '' };
    const rr = parseRecord(reg.text);
    const byReq = await readRoom(ROOMS.registration, rr.request_id);
    const merged = [...byDid.messages, ...byReq.messages];
    const receipt = await findVerifiedReceipt(ROOMS.registration, merged, rr.request_id);
    return { status: receipt ? receiptStatus(receipt.record) : 'pending', role: rr.role || '', requestId: rr.request_id };
  } catch {
    return { status: 'unknown', role: '' };
  }
}

async function refreshMembers() {
  const map = new Map();
  for (const did of state.team.members) map.set(did, await memberRegistrationStatus(did));
  state.memberStatuses = map;
}

async function refreshDiscovery() {
  if (!state.team.gameId) { state.discoveryMessages = []; return; }
  const room = await readRoom(ROOMS.discovery, state.team.gameId);
  state.discoveryMessages = room.messages || [];
  const receipts = await verifiedReceipts(ROOMS.discovery, state.discoveryMessages);
  for (const { record } of receipts) {
    if (deepFind(record, ['game_id']) !== state.team.gameId || receiptStatus(record) !== 'accepted') continue;
    const assigned = deepFind(record, ['poem_room', 'room']);
    const generation = Number(deepFind(record, ['room_generation', 'generation']));
    if (assigned === teamRoom(state.team.gameId) && Number.isSafeInteger(generation) && generation > 0) state.team.generation = generation;
  }
  state.rosterReady = receipts.some(({ record }) => deepFind(record, ['game_id']) === state.team.gameId && record.roster_ready === true && receiptStatus(record) === 'accepted');
  saveTeam();
}

async function refreshTeamRoom() {
  if (!state.team.gameId || !state.team.generation) { state.teamMessages = []; return; }
  const roomName = teamRoom(state.team.gameId);
  const room = await readRoom(roomName, state.team.gameId);
  state.teamMessages = room.messages || [];
  state.current = await extractTeamState(state.teamMessages, roomName);
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
  const did = $('#memberDid').value.trim();
  try {
    if (!DID_RE.test(did)) throw new Error('Enter a valid Ed25519 did:key.');
    if (state.team.members.includes(did)) throw new Error('That DID is already in the roster.');
    if (state.team.members.length >= 8) throw new Error('A roster can contain at most 8 writers.');
    state.team.members.push(did);
    $('#memberDid').value = '';
    saveTeam();
    refreshMembers().then(render);
    render();
  } catch (error) { toast(error.message, 'bad'); }
}

function setGameId() {
  const gameId = $('#gameId').value.trim().toLowerCase();
  if (gameId && !GAME_ID_RE.test(gameId)) return toast('Team ID must be 1–16 lowercase letters, digits, - or _.', 'bad');
  state.team.gameId = gameId;
  state.team.generation = 0;
  state.rosterReady = false;
  saveTeam();
  render();
}

async function requestRoom() {
  try {
    validateMembers(state.team.members);
    if (!state.registrationAccepted) throw new Error('Your writer registration is not verified as accepted.');
    if (!GAME_ID_RE.test(state.team.gameId)) throw new Error('Choose a valid team ID first.');
    const allAccepted = state.team.members.every((did) => {
      const s = state.memberStatuses.get(did);
      return s?.status === 'accepted' && s?.role === 'writer';
    });
    if (!allAccepted) throw new Error('Every roster member must have a verified accepted writer registration.');
    await postSigned(ROOMS.discovery, teamRequestRecord(state.team.gameId, requestId('room')));
    await refreshDiscovery();
    render();
    toast('Team room request posted. Waiting for verified referee setup receipt.');
  } catch (error) { toast(error.message, 'bad'); }
}

async function signRoster() {
  try {
    validateMembers(state.team.members);
    if (!state.team.members.includes(state.did)) throw new Error('Your DID is not in this roster.');
    if (!state.team.generation) throw new Error('Wait for the verified team room setup receipt first.');
    await postSigned(ROOMS.discovery, rosterRecord(state.team.gameId, state.team.generation, state.team.members, requestId('roster')));
    await refreshDiscovery();
    render();
    toast('Roster consent posted. Every listed writer must sign the identical roster.');
  } catch (error) { toast(error.message, 'bad'); }
}

async function loadDictionary() {
  if (state.dictionaryReady) return;
  const response = await fetch('/api/dictionary');
  if (!response.ok) throw new Error('Official CMUdict could not be loaded.');
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
  state.poem = reconstructLines(state.current.acceptedWords || []);
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
  $('#wordMeta').textContent = word ? `${letters ? 'letters ✓' : 'letters ✕'} · ${syllables || '?'} syllable(s) · ${fits ? 'fits ✓' : 'fits ✕'} · ${turn ? 'turn ✓' : 'turn ✕'}` : '';
  $('#sendWord').disabled = !(state.rosterReady && state.team.generation && syntax && letters && syllables && fits && turn && /^[a-f0-9]{64}$/i.test(state.current.stateHash || ''));
  renderSuggestions();
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

async function sendWord() {
  try {
    const record = wordRecord(state.team.gameId, state.team.generation, state.current.version, state.current.stateHash, $('#word').value.trim(), requestId('word'));
    await postSigned(teamRoom(state.team.gameId), record);
    $('#word').value = '';
    await refreshTeamRoom();
    render();
    toast('Word proposal posted. It is not accepted until a verified referee receipt says so.');
  } catch (error) { toast(error.message, 'bad'); }
}

async function sendPlanningMessage() {
  const text = $('#planning').value.trim();
  if (!text) return;
  try {
    await postSigned(teamRoom(state.team.gameId), text);
    $('#planning').value = '';
    await refreshTeamRoom();
    render();
  } catch (error) { toast(error.message, 'bad'); }
}

function parsePostIds(value) {
  return String(value).split(/\s+/).map((item) => item.match(/status\/(\d{5,30})/)?.[1] || item.match(/^\d{5,30}$/)?.[0] || '').filter(Boolean);
}

async function submitPoem() {
  try {
    if (!state.current.complete) throw new Error('The referee has not marked the poem complete.');
    if (state.current.lastContributor !== state.did) throw new Error('Only the final contributor can submit the poem.');
    if (!state.poem || !state.poemHash) throw new Error('Canonical poem could not be reconstructed.');
    const ids = parsePostIds($('#xPosts').value);
    const record = submitRecord(state.team.gameId, state.team.generation, state.current.version, state.poemHash, ids, requestId('submit'));
    await postSigned(ROOMS.submissions, record);
    toast('Submission posted. Wait for the official verified referee receipt.');
  } catch (error) { toast(error.message, 'bad'); }
}

function memberLabel(did) {
  const s = state.memberStatuses.get(did);
  if (!s) return 'checking';
  if (s.role && s.role !== 'writer') return s.role;
  return s.status;
}

function renderIdentity() {
  $('#connectPanel').classList.toggle('hidden', Boolean(state.did));
  $('#identityPanel').classList.toggle('hidden', !state.did);
  $('#did').textContent = state.did || '—';
}

function renderRegistration() {
  const record = parseRecord(state.registration?.text);
  const receipt = parseRecord(state.registrationReceipt?.text);
  const status = state.registrationReceipt ? receiptStatus(receipt) : state.registration ? 'pending' : 'not-registered';
  $('#registrationStatus').textContent = status;
  $('#registrationStatus').className = `badge ${status}`;
  $('#registrationRequest').textContent = record?.request_id || '—';
  $('#registerWriter').disabled = !state.did || state.registrationAccepted;
  $('#xHandle').disabled = Boolean(state.registration);
  if (record?.x_account_url && !$('#xHandle').value) $('#xHandle').value = record.x_account_url.split('/').filter(Boolean).at(-1) || '';
  const reason = deepFind(receipt, ['reason', 'reason_code', 'error', 'detail']);
  $('#registrationNote').textContent = status === 'accepted' ? 'Verified official referee receipt.' : status === 'rejected' ? `Rejected: ${reason || 'no reason supplied'}` : status === 'pending' ? 'Registration exists; no verified referee decision found yet.' : 'Writer registration not found in retained room history.';
}

function renderTeam() {
  $('#gameId').value = state.team.gameId;
  $('#generation').textContent = String(state.team.generation || '—');
  $('#memberCount').textContent = `${state.team.members.length} / 8`;
  $('#members').innerHTML = state.team.members.map((did) => `<div class="member"><code title="${esc(did)}">${esc(shortDid(did))}</code><span>${esc(memberLabel(did))}</span><button type="button" data-remove="${esc(did)}" ${did === state.did ? 'disabled' : ''}>×</button></div>`).join('') || '<p class="muted">No members yet.</p>';
  let rosterValid = false;
  try { validateMembers(state.team.members); rosterValid = true; } catch { /* invalid */ }
  const allAccepted = rosterValid && state.team.members.every((did) => {
    const s = state.memberStatuses.get(did);
    return s?.status === 'accepted' && s?.role === 'writer';
  });
  $('#requestRoom').disabled = !(state.registrationAccepted && GAME_ID_RE.test(state.team.gameId) && allAccepted && !state.team.generation);
  $('#signRoster').disabled = !(state.registrationAccepted && rosterValid && allAccepted && state.team.generation && state.team.members.includes(state.did));
  $('#rosterState').textContent = state.rosterReady ? 'READY' : state.team.generation ? 'WAITING FOR ALL CONSENTS' : 'NOT READY';
  $('#rosterState').className = `badge ${state.rosterReady ? 'accepted' : 'pending'}`;
}

function renderWorkspace() {
  $('#workspaceLocked').classList.toggle('hidden', state.rosterReady);
  $('#workspace').classList.toggle('hidden', !state.rosterReady);
  if (!state.rosterReady) return;
  $('#teamRoom').textContent = teamRoom(state.team.gameId);
  $('#version').textContent = String(state.current.version || 0);
  $('#line').textContent = `${state.current.line || 1} / 14`;
  $('#stateHash').textContent = state.current.stateHash || '—';
  $('#lastContributor').textContent = shortDid(state.current.lastContributor);
  $('#poem').textContent = state.poem || 'Accepted words will appear here.';
  $('#completeBadge').textContent = state.current.complete ? 'COMPLETE' : 'WRITING';
  $('#completeBadge').className = `badge ${state.current.complete ? 'accepted' : 'pending'}`;
  $('#submitPanel').classList.toggle('hidden', !(state.current.complete && state.current.lastContributor === state.did));
  $('#poemHash').textContent = state.poemHash || '—';
  $('#roomFeed').innerHTML = state.teamMessages.slice(-40).map((m) => {
    const official = m.from === REFEREE_DID;
    return `<article class="message ${official ? 'official' : m.from === state.did ? 'mine' : ''}"><div><span>${official ? 'referee' : esc(shortDid(m.from))}</span><time>${esc(new Date(m.ts).toLocaleTimeString())}</time></div><pre>${esc(m.text)}</pre></article>`;
  }).join('');
  validateWord();
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
  $('#planningSend').addEventListener('click', sendPlanningMessage);
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
