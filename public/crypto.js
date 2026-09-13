const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_INDEX = new Map([...BASE58].map((c, i) => [c, i]));

export const REFEREE_DID = 'did:key:z6MkowHQwsx9xr84WbWN3YCnKutyBnBXkT1ChKY4uEAAMzte';
export const DID_RE = /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/;

function bytesToBase64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlToBytes(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function base58Encode(bytes) {
  let n = 0n;
  for (const byte of bytes) n = n * 256n + BigInt(byte);
  let out = '';
  while (n > 0n) {
    out = BASE58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = `1${out}`;
  }
  return out || '1';
}

function base58Decode(value) {
  let n = 0n;
  for (const c of value) {
    const d = BASE58_INDEX.get(c);
    if (d == null) throw new Error('invalid_base58');
    n = n * 58n + BigInt(d);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  let bytes = hex ? Uint8Array.from(hex.match(/../g).map((pair) => parseInt(pair, 16))) : new Uint8Array();
  const leading = value.length - value.replace(/^1+/, '').length;
  if (leading) bytes = new Uint8Array([...new Uint8Array(leading), ...bytes]);
  return bytes;
}

function seedHexToBytes(seedHex) {
  const value = String(seedHex || '').trim();
  if (!/^[0-9a-fA-F]{64}$/.test(value)) throw new Error('Private key must be exactly 64 hexadecimal characters.');
  return Uint8Array.from(value.match(/../g).map((pair) => parseInt(pair, 16)));
}

async function privateKeyFromSeed(seed) {
  const pkcs8 = new Uint8Array(48);
  pkcs8.set([0x30,0x2e,0x02,0x01,0x00,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x04,0x22,0x04,0x20]);
  pkcs8.set(seed, 16);
  return crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, true, ['sign']);
}

export async function identityFromPrivateKey(seedHex) {
  const seed = seedHexToBytes(seedHex);
  const privateKey = await privateKeyFromSeed(seed);
  const jwk = await crypto.subtle.exportKey('jwk', privateKey);
  if (!jwk.x) throw new Error('Browser could not derive the Ed25519 public key.');
  const rawPublic = base64urlToBytes(jwk.x);
  const prefixed = new Uint8Array(34);
  prefixed.set([0xed, 0x01]);
  prefixed.set(rawPublic, 2);
  const did = `did:key:z${base58Encode(prefixed)}`;
  if (!DID_RE.test(did)) throw new Error('Derived DID is invalid.');
  return { did, privateKey };
}

export async function signRoomMessage(privateKey, did, room, nonce, text) {
  if (!privateKey || !DID_RE.test(did)) throw new Error('Private key is not connected.');
  const canonical = `${room}|${nonce}|${text}`;
  const signature = await crypto.subtle.sign('Ed25519', privateKey, new TextEncoder().encode(canonical));
  return bytesToBase64url(new Uint8Array(signature));
}

async function publicKeyFromDid(did) {
  if (!DID_RE.test(did)) throw new Error('invalid_did');
  const decoded = base58Decode(did.slice('did:key:z'.length));
  if (decoded.length !== 34 || decoded[0] !== 0xed || decoded[1] !== 0x01) throw new Error('unsupported_did');
  return crypto.subtle.importKey('raw', decoded.slice(2), { name: 'Ed25519' }, false, ['verify']);
}

export async function verifyRoomMessage(room, message) {
  if (!message?.from || !message?.sig || message?.nonce == null || typeof message?.text !== 'string') return false;
  try {
    const key = await publicKeyFromDid(message.from);
    const canonical = `${room}|${message.nonce}|${message.text}`;
    return crypto.subtle.verify('Ed25519', key, base64urlToBytes(message.sig), new TextEncoder().encode(canonical));
  } catch {
    return false;
  }
}

export async function verifyOfficialRefereeMessage(room, message) {
  return message?.from === REFEREE_DID && verifyRoomMessage(room, message);
}
