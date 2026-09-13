import { findVerifiedReceipt, parseRecord, receiptStatus, ROOMS } from './protocol.js';

const CACHE_KEY = 'sonnet-console-registration-proof-v1';
let lastDid = '';
let running = false;
let applying = false;
let authoritativeView = null;

function $(selector) {
  return document.querySelector(selector);
}

function connectedDid() {
  const did = String($('#did')?.textContent || '').trim();
  return did.startsWith('did:key:z6Mk') ? did : '';
}

function applyAuthoritativeView() {
  if (!authoritativeView || applying) return;
  const badge = $('#registrationStatus');
  const message = $('#registrationNote');
  const request = $('#registrationRequest');
  const register = $('#registerWriter');
  if (!badge || !message || !request || !register) return;

  applying = true;
  try {
    const { status, note, requestId } = authoritativeView;
    badge.dataset.recoveryOwned = 'true';
    badge.textContent = status;
    badge.className = `badge ${status === 'accepted' ? 'accepted' : status === 'rejected' ? 'rejected' : 'pending'}`;
    message.textContent = note;
    request.textContent = requestId || '—';
    if (status === 'history-unavailable' || status === 'accepted' || status === 'rejected') register.disabled = true;
  } finally {
    applying = false;
  }
}

function setStatus(status, note, requestId = '') {
  authoritativeView = { status, note, requestId };
  applyAuthoritativeView();
}

async function api(path) {
  const response = await fetch(path, { cache: 'no-store' });
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); }
  catch { throw new Error(`Unexpected local response (${response.status}).`); }
  if (!response.ok || payload.ok === false) throw new Error(typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`);
  return payload;
}

async function readBySearch(room, value) {
  const query = new URLSearchParams();
  query.append('search', value);
  const payload = await api(`/api/rooms/${encodeURIComponent(room)}?${query}`);
  return payload.messages || [];
}

function loadCachedProof(did) {
  try {
    const value = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    if (value?.did === did && value.registration && value.receipt) return value;
  } catch { /* ignore invalid local cache */ }
  return null;
}

function saveCachedProof(did, registration, receipt) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ did, registration, receipt, savedAt: new Date().toISOString() }));
  } catch { /* local cache is optional */ }
}

async function verifyCachedProof(did) {
  const cached = loadCachedProof(did);
  if (!cached) return null;
  const record = parseRecord(cached.registration.text);
  if (cached.registration.from !== did || record?.type !== 'sonnet.register.v1' || !record?.request_id) return null;
  const found = await findVerifiedReceipt(ROOMS.registration, [cached.registration, cached.receipt], record.request_id);
  if (!found) return null;
  return { registration: cached.registration, record, receipt: found.message, receiptRecord: found.record };
}

async function lookupDid(did) {
  const cached = await verifyCachedProof(did);
  if (cached) {
    const status = receiptStatus(cached.receiptRecord);
    if (status === 'accepted' || status === 'rejected') {
      setStatus(status, status === 'accepted' ? 'Verified official referee receipt recovered from this browser’s local proof cache.' : 'Verified official referee rejection recovered from this browser’s local proof cache.', cached.record.request_id);
      return;
    }
  }

  const byDid = await readBySearch(ROOMS.registration, did);
  const registrations = byDid.filter((message) => {
    const record = parseRecord(message.text);
    return message.from === did && record?.type === 'sonnet.register.v1' && record?.contest_id === 'sonnet-2' && record?.request_id;
  });

  if (!registrations.length) {
    setStatus(
      'history-unavailable',
      'No retained registration record is currently available for this DID. This is not a rejection and does not mean the DID is unregistered; older records can fall out of Technocore rolling history.'
    );
    return;
  }

  const registration = registrations.at(-1);
  const record = parseRecord(registration.text);
  const byRequest = await readBySearch(ROOMS.registration, record.request_id);
  const merged = [...byDid, ...byRequest].filter((message, index, all) => all.findIndex((candidate) => String(candidate.seq) === String(message.seq)) === index);
  const found = await findVerifiedReceipt(ROOMS.registration, merged, record.request_id);

  if (!found) {
    setStatus('pending', 'Registration found by DID, but no matching cryptographically verified referee receipt is retained right now.', record.request_id);
    return;
  }

  const status = receiptStatus(found.record);
  if (status === 'accepted' || status === 'rejected') {
    saveCachedProof(did, registration, found.message);
    setStatus(status, status === 'accepted' ? 'Verified official referee receipt found by DID.' : 'Verified official referee rejection found by DID.', record.request_id);
    return;
  }

  setStatus('pending', 'A verified referee receipt was found, but it does not contain a final accepted/rejected status.', record.request_id);
}

async function run(force = false) {
  if (running) return;
  const did = connectedDid();
  if (!did) {
    lastDid = '';
    authoritativeView = null;
    return;
  }

  if (!force && did === lastDid && authoritativeView) {
    applyAuthoritativeView();
    return;
  }

  running = true;
  lastDid = did;
  try {
    await lookupDid(did);
  } catch (error) {
    setStatus('lookup-error', `DID lookup could not complete: ${String(error?.message || error)}`);
  } finally {
    running = false;
  }
}

// Keep the DID-derived status stable without observing our own DOM writes.

setInterval(() => run(false), 500);
window.addEventListener('focus', () => run(true));
$('#refresh')?.addEventListener('click', () => setTimeout(() => run(true), 250));
setTimeout(() => run(true), 400);
