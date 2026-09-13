import test from 'node:test';
import assert from 'node:assert/strict';
import { identityFromPrivateKey, signRoomMessage, verifyRoomMessage, DID_RE } from '../public/crypto.js';

test('64-char seed derives an Ed25519 did:key and signs room bytes', async () => {
  const identity = await identityFromPrivateKey('01'.repeat(32));
  assert.match(identity.did, DID_RE);

  const room = 'mb-sonnet-2-discovery';
  const nonce = '1789300000000';
  const text = '{"type":"test"}';
  const sig = await signRoomMessage(identity.privateKey, identity.did, room, nonce, text);

  assert.equal(await verifyRoomMessage(room, {
    from: identity.did,
    nonce,
    text,
    sig,
  }), true);

  assert.equal(await verifyRoomMessage(room, {
    from: identity.did,
    nonce,
    text: `${text}x`,
    sig,
  }), false);
});
