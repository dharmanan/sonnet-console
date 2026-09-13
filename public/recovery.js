import { deepFind, findVerifiedReceipt, parseRecord, receiptStatus, ROOMS } from './protocol.js';
import { REFEREE_DID, verifyOfficialRefereeMessage, verifyRoomMessage } from './crypto.js';

const CACHE_KEY = 'sonnet-console-registration-proof-v1';
const REGISTRATION_MESSAGE_CACHE = 'sonnet-console-registration-message-v1';
let lastDid = '';
let running = false;
let applying = false;
let authoritativeView = null;

function statusLabelTr(status) {
  return {
    accepted: 'KABUL EDİLDİ',
    rejected: 'REDDEDİLDİ',
    pending: 'BEKLEMEDE',
    checking: 'KONTROL EDİLİYOR',
    'history-unavailable': 'GEÇMİŞ BULUNAMADI',
    'historical-accepted': 'GEÇMİŞTE KABUL EDİLDİ',
    'lookup-error': 'KONTROL HATASI'
  }[status] || String(status || '').toUpperCase();
}

function $(selector) {
  return document.querySelector(selector);
}


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
    badge.textContent = statusLabelTr(status);
    badge.className = `badge ${status === 'accepted' ? 'accepted' : status === 'rejected' ? 'rejected' : 'pending'}`;
    message.textContent = note;
    request.textContent = requestId || '—';
    if (status === 'history-unavailable' || status === 'historical-accepted' || status === 'accepted' || status === 'rejected') register.disabled = true;
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


async function loadRememberedRegistration(did) {
  try {
    const message = JSON.parse(
      localStorage.getItem(
        `${REGISTRATION_MESSAGE_CACHE}:${did}`
      ) || 'null'
    );

    if (!message || message.from !== did) return null;

    if (!(await verifyRoomMessage(ROOMS.registration, message))) {
      return null;
    }

    const record = parseRecord(message.text);

    if (
      record?.type !== 'sonnet.register.v1' ||
      record?.contest_id !== 'sonnet-2' ||
      !record?.request_id
    ) return null;

    return message;
  } catch {
    return null;
  }
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
  if (
    cached.registration.from !== did ||
    record?.type !== 'sonnet.register.v1' ||
    !record?.request_id ||
    !(await verifyRoomMessage(ROOMS.registration, cached.registration))
  ) return null;
  const found = await findVerifiedReceipt(ROOMS.registration, [cached.registration, cached.receipt], record.request_id);
  if (!found) return null;
  return { registration: cached.registration, record, receipt: found.message, receiptRecord: found.record };
}


async function lookupDid(did) {
  const cached = await verifyCachedProof(did);

  if (cached) {
    const status = receiptStatus(cached.receiptRecord);

    if (
      status === 'accepted' ||
      status === 'rejected'
    ) {
      setStatus(
        status,
        status === 'accepted'
          ? 'Resmi hakem receipt’i bu tarayıcının yerel kanıt önbelleğinden doğrulanarak geri getirildi.'
          : 'Resmi hakem reddi bu tarayıcının yerel kanıt önbelleğinden doğrulanarak geri getirildi.',
        cached.record.request_id
      );

      return;
    }
  }

  const byDid = await readBySearch(
    ROOMS.registration,
    did
  );

  /*
   * A referee receipt can itself name the participant DID.
   * In that case the original registration message is not needed
   * to establish the referee's signed conclusion.
   */
  for (const message of [...byDid].reverse()) {
    if (message?.from !== REFEREE_DID) continue;

    const record = parseRecord(message.text);

    if (
      !record ||
      record.contest_id !== 'sonnet-2' ||
      !/^sonnet\.(?:receipt|receipts)\.v1$/.test(
        String(record.type || '')
      )
    ) continue;

    const participantDid = deepFind(
      record,
      ['participant_did', 'sender_did']
    );

    if (participantDid !== did) continue;

    if (!(
      await verifyOfficialRefereeMessage(
        ROOMS.registration,
        message
      )
    )) continue;

    const status = receiptStatus(record);

    if (
      status === 'accepted' ||
      status === 'rejected'
    ) {
      setStatus(
        status,
        status === 'accepted'
          ? 'DID üzerinden doğrudan doğrulanmış resmi hakem receipt’i bulundu.'
          : 'DID üzerinden doğrudan doğrulanmış resmi hakem reddi bulundu.',
        String(
          deepFind(
            record,
            ['for_request_id', 'request_id']
          ) || ''
        )
      );

      return;
    }
  }

  const registrations = [];

  for (const message of byDid) {
    const record = parseRecord(message.text);

    if (
      message.from !== did ||
      record?.type !== 'sonnet.register.v1' ||
      record?.contest_id !== 'sonnet-2' ||
      !record?.request_id
    ) continue;

    if (
      await verifyRoomMessage(
        ROOMS.registration,
        message
      )
    ) {
      registrations.push(message);
    }
  }

  if (!registrations.length) {
    const remembered =
      await loadRememberedRegistration(did);

    if (remembered) {
      registrations.push(remembered);
    }
  }

  if (!registrations.length) {
    const historical = await historicalWriterEvidenceFor(did);

    if (
      historical?.status === 'accepted'
    ) {
      setStatus(
        'historical-accepted',
        'Geçmiş watcher kaydı, bu yazarın yakalandığı sırada doğrulanmış bir hakem receipt’i ile kabul edildiğini gösteriyor. Bu geçmiş kayıt yalnızca bilgilendirme amaçlıdır ve şu anda yeniden doğrulanabilen bir hakem mesajının yerine kullanılmaz.',
        historical.request_id || ''
      );

      return;
    }

    setStatus(
      'history-unavailable',
      'Bu DID için yerel kayıt geçmişi bulunamıyor. Bu bir ret değildir. İmzalı takım işlemleri işlendiğinde takım uygunluğuna resmi hakem karar verir.'
    );

    return;
  }

  const registration = registrations.at(-1);
  const record = parseRecord(registration.text);

  const byRequest = await readBySearch(
    ROOMS.registration,
    record.request_id
  );

  const merged = [
    ...byDid,
    ...byRequest,
    registration
  ].filter(
    (message, index, all) =>
      all.findIndex(
        (candidate) =>
          String(candidate.seq ?? candidate.sig) ===
          String(message.seq ?? message.sig)
      ) === index
  );

  const found = await findVerifiedReceipt(
    ROOMS.registration,
    merged,
    record.request_id
  );

  if (!found) {
    setStatus(
      'pending',
      'İmzalı kayıt isteği biliniyor ancak şu anda eşleşen kriptografik olarak doğrulanmış hakem receipt’i bulunmuyor. Bu durum takım kurulumunu engellemez; son karar resmi hakemdedir.',
      record.request_id
    );

    return;
  }

  const status = receiptStatus(found.record);

  if (
    status === 'accepted' ||
    status === 'rejected'
  ) {
    saveCachedProof(
      did,
      registration,
      found.message
    );

    setStatus(
      status,
      status === 'accepted'
        ? 'Doğrulanmış resmi hakem receipt’i bulundu.'
        : 'Doğrulanmış resmi hakem reddi bulundu.',
      record.request_id
    );

    return;
  }

  setStatus(
    'pending',
    'Kriptografik olarak doğrulanmış hakem receipt’i bulundu ancak nihai kabul/ret durumu içermiyor.',
    record.request_id
  );
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
    setStatus('lookup-error', `DID kontrolü tamamlanamadı: ${String(error?.message || error)}`);
  } finally {
    running = false;
  }
}

// Keep the DID-derived status stable without observing our own DOM writes.

setInterval(() => run(false), 500);
window.addEventListener('focus', () => run(true));
$('#refresh')?.addEventListener('click', () => setTimeout(() => run(true), 250));
setTimeout(() => run(true), 400);
