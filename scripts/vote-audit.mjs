const REFEREE =
  'did:key:z6MkowHQwsx9xr84WbWN3YCnKutyBnBXkT1ChKY4uEAAMzte';

import fs from 'node:fs/promises';

const FILES = {
  submissions: '/tmp/sonnet-submissions.jsonl',
  votes: '/tmp/sonnet-votes.jsonl'
};

async function readJsonl(path) {
  const text = await fs.readFile(path, 'utf8');

  return text
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
    .map(message => {
      let record = null;

      try {
        record = JSON.parse(message.text);
      } catch {}

      return { message, record };
    });
}

function collectAcceptedSubmissions(rows) {
  const proposalsByRequest = new Map();

  for (const { message, record } of rows) {
    if (
      record?.type !== 'sonnet.submit.v1' ||
      record?.contest_id !== 'sonnet-2' ||
      !record?.request_id
    ) {
      continue;
    }

    if (!proposalsByRequest.has(record.request_id)) {
      proposalsByRequest.set(record.request_id, []);
    }

    proposalsByRequest.get(record.request_id).push({
      seq: message.seq,
      ts: message.ts,
      sender_did: message.from,
      record
    });
  }

  const accepted = [];
  const unmatched = [];

  for (const { message, record } of rows) {
    if (
      message.from !== REFEREE ||
      record?.type !== 'sonnet.receipt.v1' ||
      record?.contest_id !== 'sonnet-2' ||
      record?.status !== 'accepted' ||
      !record?.entry_id ||
      !record?.request_id
    ) {
      continue;
    }

    const candidates = (
      proposalsByRequest.get(record.request_id) || []
    ).filter(proposal =>
      proposal.seq < message.seq &&
      proposal.sender_did === record.sender_did
    );

    const proposal = candidates
      .sort((a, b) => b.seq - a.seq)[0];

    if (!proposal) {
      unmatched.push({
        entry_id: record.entry_id,
        receipt_seq: message.seq,
        request_id: record.request_id,
        sender_did: record.sender_did
      });

      continue;
    }

    accepted.push({
      entry_id: record.entry_id,
      game_id: proposal.record.game_id,
      poem_room: proposal.record.poem_room,
      room_generation: proposal.record.room_generation,
      final_version: proposal.record.final_version,
      poem_sha256: proposal.record.poem_sha256,
      x_post_ids: proposal.record.x_post_ids || [],
      submitter_did: proposal.sender_did,
      proposal_seq: proposal.seq,
      proposal_ts: proposal.ts,
      receipt_seq: message.seq,
      receipt_ts: message.ts,
      request_id: record.request_id
    });
  }

  return {
    accepted,
    unmatched,
    duplicateRequestIds: [...proposalsByRequest.entries()]
      .filter(([, list]) => list.length > 1)
      .map(([request_id, list]) => ({
        request_id,
        count: list.length
      }))
  };
}

function collectVotes(rows) {
  const ballotsByRequest = new Map();

  for (const { message, record } of rows) {
    if (
      record?.type !== 'sonnet.ballot.v1' ||
      record?.contest_id !== 'sonnet-2' ||
      !record?.request_id
    ) {
      continue;
    }

    const ballot = {
      ballot_seq: message.seq,
      ballot_ts: message.ts,
      sender_did: message.from,
      voter_did: record.voter_did,
      entry_id: record.entry_id,
      request_id: record.request_id
    };

    if (!ballotsByRequest.has(ballot.request_id)) {
      ballotsByRequest.set(ballot.request_id, []);
    }

    ballotsByRequest.get(ballot.request_id).push(ballot);
  }

  const acceptedReceipts = [];
  const rejectedReceipts = [];

  for (const { message, record } of rows) {
    if (
      message.from !== REFEREE ||
      record?.type !== 'sonnet.receipt.v1' ||
      record?.contest_id !== 'sonnet-2' ||
      !record?.request_id ||
      !record?.sender_did
    ) {
      continue;
    }

    if (record.status === 'rejected') {
      rejectedReceipts.push({
        receipt_seq: message.seq,
        receipt_ts: message.ts,
        voter_did: record.sender_did,
        entry_id: record.entry_id ?? null,
        request_id: record.request_id,
        reason: record.reason || ''
      });

      continue;
    }

    if (
      record.status !== 'accepted' ||
      !record.entry_id
    ) {
      continue;
    }

    const candidates = (
      ballotsByRequest.get(record.request_id) || []
    ).filter(ballot =>
      ballot.ballot_seq < message.seq &&
      ballot.sender_did === record.sender_did &&
      ballot.voter_did === record.sender_did &&
      ballot.entry_id === record.entry_id
    );

    const ballot = candidates
      .sort((a, b) => b.ballot_seq - a.ballot_seq)[0];

    /*
     * The official referee receipt is authoritative.
     *
     * A ballot may already have fallen outside the retained room window
     * while its receipt is still present. In that case we still retain
     * the accepted vote, but mark the ballot as unavailable.
     */
    acceptedReceipts.push({
      voter_did: record.sender_did,
      entry_id: record.entry_id,
      request_id: record.request_id,
      receipt_seq: message.seq,
      receipt_ts: message.ts,
      ballot_seq: ballot?.ballot_seq ?? null,
      ballot_ts: ballot?.ballot_ts ?? null,
      ballot_matched: Boolean(ballot)
    });
  }

  /*
   * Canonical vote:
   * one vote per voter DID, using that voter's latest ACCEPTED receipt.
   */
  const latestByVoter = new Map();

  for (const vote of acceptedReceipts) {
    const previous = latestByVoter.get(vote.voter_did);

    if (
      !previous ||
      vote.receipt_seq > previous.receipt_seq
    ) {
      latestByVoter.set(vote.voter_did, vote);
    }
  }

  return {
    acceptedReceipts,
    rejectedReceipts,
    canonicalVotes: [...latestByVoter.values()],
    duplicateBallotRequestIds: [...ballotsByRequest.entries()]
      .filter(([, list]) => list.length > 1)
      .map(([request_id, list]) => ({
        request_id,
        count: list.length
      }))
  };
}

function countByEntry(votes) {
  const counts = new Map();

  for (const vote of votes) {
    counts.set(
      vote.entry_id,
      (counts.get(vote.entry_id) || 0) + 1
    );
  }

  return counts;
}

const [submissionRows, voteRows] = await Promise.all([
  readJsonl(FILES.submissions),
  readJsonl(FILES.votes)
]);

const submissions = collectAcceptedSubmissions(submissionRows);
const votes = collectVotes(voteRows);

const acceptedEntryIds = new Set(
  submissions.accepted.map(entry => entry.entry_id)
);

const rawCounts = countByEntry(votes.acceptedReceipts);
const canonicalCounts = countByEntry(votes.canonicalVotes);

const entries = new Set([
  ...rawCounts.keys(),
  ...canonicalCounts.keys()
]);

const table = [...entries]
  .map(entry_id => ({
    entry_id,
    accepted_submission: acceptedEntryIds.has(entry_id),
    raw_accepted: rawCounts.get(entry_id) || 0,
    canonical_votes: canonicalCounts.get(entry_id) || 0,
    removed_duplicates_or_changes:
      (rawCounts.get(entry_id) || 0) -
      (canonicalCounts.get(entry_id) || 0)
  }))
  .sort((a, b) =>
    b.canonical_votes - a.canonical_votes ||
    b.raw_accepted - a.raw_accepted ||
    a.entry_id.localeCompare(b.entry_id)
  );

const unmatchedBallots = votes.acceptedReceipts
  .filter(vote => !vote.ballot_matched);

console.log('=== SONNET-2 PUBLIC VOTE AUDIT ===');

console.log('\nSUBMISSIONS');
console.log(
  'accepted submissions =',
  submissions.accepted.length
);
console.log(
  'unique entry ids =',
  acceptedEntryIds.size
);
console.log(
  'unmatched accepted submission receipts =',
  submissions.unmatched.length
);
console.log(
  'duplicate submission request ids =',
  submissions.duplicateRequestIds.length
);

console.log('\nVOTE WINDOW');
console.log(
  'first seq =',
  voteRows[0]?.message?.seq
);
console.log(
  'last seq =',
  voteRows.at(-1)?.message?.seq
);
console.log(
  'retained rows =',
  voteRows.length
);

console.log('\nVOTES');
console.log(
  'accepted referee receipts =',
  votes.acceptedReceipts.length
);
console.log(
  'canonical unique voters =',
  votes.canonicalVotes.length
);
console.log(
  'accepted duplicates/changes removed =',
  votes.acceptedReceipts.length -
    votes.canonicalVotes.length
);
console.log(
  'accepted receipts without retained ballot =',
  unmatchedBallots.length
);
console.log(
  'rejected receipts =',
  votes.rejectedReceipts.length
);
console.log(
  'duplicate ballot request ids =',
  votes.duplicateBallotRequestIds.length
);

console.log('\n=== CANONICAL ENTRY COUNTS ===');

for (const row of table) {
  console.log(
    String(row.canonical_votes).padStart(5),
    '| raw',
    String(row.raw_accepted).padStart(5),
    '| removed',
    String(row.removed_duplicates_or_changes).padStart(3),
    '| submitted',
    row.accepted_submission ? 'yes' : 'NO ',
    '|',
    row.entry_id
  );
}

console.log('\n=== ACCEPTED RECEIPTS WITHOUT RETAINED BALLOT ===');

for (const vote of unmatchedBallots) {
  console.log(JSON.stringify(vote));
}

console.log('\nNOTE');
console.log(
  'Canonical counts describe the currently retained public vote window.'
);
console.log(
  'Older vote-room messages that have fallen outside the retained ring cannot be reconstructed from this snapshot alone.'
);
