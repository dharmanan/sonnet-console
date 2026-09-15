import fs from 'node:fs/promises';

const REFEREE =
  'did:key:z6MkowHQwsx9xr84WbWN3YCnKutyBnBXkT1ChKY4uEAAMzte';

const poemAudit = JSON.parse(
  await fs.readFile('/tmp/sonnet-poem-audit.json', 'utf8')
);

const voteRows = (await fs.readFile('/tmp/sonnet-votes.jsonl', 'utf8'))
  .trim()
  .split('\n')
  .filter(Boolean)
  .map(JSON.parse)
  .map(message => {
    let record = null;
    try { record = JSON.parse(message.text); } catch {}
    return { message, record };
  });

const ballotsByRequest = new Map();

for (const { message, record } of voteRows) {
  if (
    record?.type !== 'sonnet.ballot.v1' ||
    record?.contest_id !== 'sonnet-2' ||
    !record?.request_id
  ) continue;

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

const accepted = [];

for (const { message, record } of voteRows) {
  if (
    message.from !== REFEREE ||
    record?.type !== 'sonnet.receipt.v1' ||
    record?.contest_id !== 'sonnet-2' ||
    record?.status !== 'accepted' ||
    !record?.sender_did ||
    !record?.entry_id ||
    !record?.request_id
  ) continue;

  const ballot = (
    ballotsByRequest.get(record.request_id) || []
  )
    .filter(x =>
      x.ballot_seq < message.seq &&
      x.sender_did === record.sender_did &&
      x.voter_did === record.sender_did &&
      x.entry_id === record.entry_id
    )
    .sort((a, b) => b.ballot_seq - a.ballot_seq)[0];

  accepted.push({
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
 * One canonical vote per voter DID:
 * latest ACCEPTED referee receipt in retained window.
 */
const latestByVoter = new Map();

for (const vote of accepted) {
  const previous = latestByVoter.get(vote.voter_did);

  if (
    !previous ||
    vote.receipt_seq > previous.receipt_seq
  ) {
    latestByVoter.set(vote.voter_did, vote);
  }
}

const canonicalVotes = [...latestByVoter.values()];

const votesByEntry = new Map();

for (const vote of canonicalVotes) {
  if (!votesByEntry.has(vote.entry_id)) {
    votesByEntry.set(vote.entry_id, []);
  }

  votesByEntry.get(vote.entry_id).push(vote);
}

const report = poemAudit
  .map(entry => {
    const votes = (votesByEntry.get(entry.entry_id) || [])
      .sort((a, b) =>
        a.receipt_seq - b.receipt_seq
      );

    return {
      entry_id: entry.entry_id,
      game_id: entry.game_id,
      poem_room: entry.poem_room,
      room_generation: entry.room_generation,
      final_version: entry.final_version,
      poem_sha256: entry.poem_sha256,
      poem_verified:
        entry.hash_match === true &&
        entry.final_version_match === true &&
        entry.complete === true &&
        entry.reconstructed_lines === 14,
      poem: entry.poem,
      canonical_vote_count: votes.length,
      voters: votes.map(v => ({
        voter_did: v.voter_did,
        receipt_ts: v.receipt_ts,
        ballot_ts: v.ballot_ts,
        receipt_seq: v.receipt_seq,
        ballot_seq: v.ballot_seq,
        ballot_matched: v.ballot_matched
      }))
    };
  })
  .sort((a, b) =>
    b.canonical_vote_count - a.canonical_vote_count ||
    a.entry_id.localeCompare(b.entry_id)
  );

await fs.writeFile(
  '/tmp/sonnet-audit-report.json',
  JSON.stringify({
    scope: {
      contest_id: 'sonnet-2',
      vote_window_first_seq: voteRows[0]?.message?.seq ?? null,
      vote_window_last_seq: voteRows.at(-1)?.message?.seq ?? null,
      retained_vote_rows: voteRows.length,
      canonical_voters: canonicalVotes.length,
      note:
        'Vote counts are canonical within the currently retained public vote window only.'
    },
    entries: report
  }, null, 2)
);

console.log('=== COMBINED AUDIT REPORT ===');
console.log('entries =', report.length);
console.log(
  'verified poems =',
  report.filter(x => x.poem_verified).length
);
console.log(
  'canonical voters =',
  canonicalVotes.length
);
console.log(
  'entries with votes =',
  report.filter(x => x.canonical_vote_count > 0).length
);

console.log('\n=== RANKING IN RETAINED WINDOW ===');

for (const [index, entry] of report.entries()) {
  console.log(
    String(index + 1).padStart(2),
    '|',
    String(entry.canonical_vote_count).padStart(5),
    '|',
    entry.entry_id
  );
}

console.log('\nOUTPUT = /tmp/sonnet-audit-report.json');
