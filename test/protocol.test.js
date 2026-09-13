import test from 'node:test';
import assert from 'node:assert/strict';
import {
  registrationRecord,
  teamRequestRecord,
  rosterRecord,
  wordRecord,
  submitRecord,
  didAllowsWord,
  validateMembers,
} from '../public/protocol.js';

const A = 'did:key:z6Mkn7LCcVgptpXz141Fk58UUhfho77Toer96cfqf3wVVxE4';
const B = 'did:key:z6MkwXcPRtbEfirbuJCs6fLNGbP2Sbwg7CnuGBWQC1ysaE66';
const C = 'did:key:z6MkqVVzeyxRLQRXWdTTPrue4wgDdvhUwJuSRkEA8shUy6pE';
const D = 'did:key:z6MkejoBvUkYrccxz3MACYVBkCSqzoAU5AzztrVsgxZNE1Mt';

const HASH = 'a'.repeat(64);

test('writer registration shape matches sonnet-2', () => {
  assert.deepEqual(registrationRecord('https://x.com/KohenEric', 'r1'), {
    type: 'sonnet.register.v1',
    contest_id: 'sonnet-2',
    role: 'writer',
    x_account_url: 'https://x.com/KohenEric',
    request_id: 'r1',
  });
});

test('team request shape matches sonnet-2', () => {
  assert.deepEqual(teamRequestRecord('alpha_1', 'room-1'), {
    type: 'sonnet.team-request.v1',
    contest_id: 'sonnet-2',
    game_id: 'alpha_1',
    request_id: 'room-1',
  });
});

test('roster requires 4-8 unique DIDs and preserves order', () => {
  const members = [A, B, C, D];
  assert.deepEqual(validateMembers(members), members);
  assert.equal(rosterRecord('alpha', 3, members, 'roster-1').poem_room, 'd-sonnet-2-team-alpha');
  assert.throws(() => validateMembers([A, B, C]));
  assert.throws(() => validateMembers([A, B, C, A]));
});

test('word proposal includes current version and previous state hash', () => {
  assert.deepEqual(wordRecord('alpha', 3, 7, HASH, 'light,', 'word-1'), {
    type: 'sonnet.word.v1',
    contest_id: 'sonnet-2',
    game_id: 'alpha',
    room_generation: 3,
    version: 7,
    previous_state_hash: HASH,
    word: 'light,',
    request_id: 'word-1',
  });
});

test('submission packet contains frozen poem hash and X post ids', () => {
  assert.deepEqual(submitRecord('alpha', 3, 98, HASH, ['1234567890123456789'], 'submit-1'), {
    type: 'sonnet.submit.v1',
    contest_id: 'sonnet-2',
    game_id: 'alpha',
    poem_room: 'd-sonnet-2-team-alpha',
    room_generation: 3,
    final_version: 98,
    poem_sha256: HASH,
    x_post_ids: ['1234567890123456789'],
    request_id: 'submit-1',
  });
});

test('DID letter rule is checked per contributor', () => {
  assert.equal(didAllowsWord(A, 'key'), true);
  assert.equal(didAllowsWord(A, 'banana'), false);
});
