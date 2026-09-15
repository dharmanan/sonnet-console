import fs from 'node:fs/promises';
import crypto from 'node:crypto';

const REFEREE =
  'did:key:z6MkowHQwsx9xr84WbWN3YCnKutyBnBXkT1ChKY4uEAAMzte';

const SUBMISSIONS_FILE = '/tmp/sonnet-submissions.jsonl';
const OUTPUT_FILE = '/tmp/sonnet-poem-audit.json';

function parseJsonl(text) {
  return text
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(JSON.parse)
    .map(message => {
      let record = null;
      try { record = JSON.parse(message.text); } catch {}
      return { message, record };
    });
}

function acceptedSubmissions(rows) {
  const proposalsByRequest = new Map();

  for (const { message, record } of rows) {
    if (
      record?.type !== 'sonnet.submit.v1' ||
      record?.contest_id !== 'sonnet-2' ||
      !record?.request_id
    ) continue;

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

  for (const { message, record } of rows) {
    if (
      message.from !== REFEREE ||
      record?.type !== 'sonnet.receipt.v1' ||
      record?.contest_id !== 'sonnet-2' ||
      record?.status !== 'accepted' ||
      !record?.entry_id ||
      !record?.request_id
    ) continue;

    const proposal = (
      proposalsByRequest.get(record.request_id) || []
    )
      .filter(x =>
        x.seq < message.seq &&
        x.sender_did === record.sender_did
      )
      .sort((a, b) => b.seq - a.seq)[0];

    if (!proposal) continue;

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
      receipt_seq: message.seq
    });
  }

  return accepted;
}

async function fetchRoom(room) {
  const url =
    `https://technocore.chat/r/${encodeURIComponent(room)}/export`;

  let lastError;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(15000)
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      return parseJsonl(await response.text());
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

function reconstruct(submission, rows) {
  const proposalsByRequest = new Map();

  for (const { message, record } of rows) {
    if (
      record?.type !== 'sonnet.word.v1' ||
      record?.contest_id !== 'sonnet-2' ||
      record?.game_id !== submission.game_id ||
      record?.room_generation !== submission.room_generation ||
      !record?.request_id
    ) continue;

    if (!proposalsByRequest.has(record.request_id)) {
      proposalsByRequest.set(record.request_id, []);
    }

    proposalsByRequest.get(record.request_id).push({
      proposal_seq: message.seq,
      proposal_ts: message.ts,
      sender_did: message.from,
      word_version: record.version,
      word: record.word,
      request_id: record.request_id
    });
  }

  const accepted = [];

  for (const { message, record } of rows) {
    if (
      message.from !== REFEREE ||
      record?.type !== 'sonnet.receipt.v1' ||
      record?.contest_id !== 'sonnet-2' ||
      record?.status !== 'accepted' ||
      !record?.request_id ||
      !Number.isInteger(record?.version)
    ) continue;

    const proposal = (
      proposalsByRequest.get(record.request_id) || []
    )
      .filter(x =>
        x.proposal_seq < message.seq &&
        x.sender_did === record.sender_did
      )
      .sort((a, b) => b.proposal_seq - a.proposal_seq)[0];

    if (!proposal) continue;

    accepted.push({
      ...proposal,
      state_version: record.version,
      receipt_seq: message.seq,
      receipt_ts: message.ts,
      syllables: record.syllables ?? null,
      complete: record.complete ?? false
    });
  }

  accepted.sort(
    (a, b) =>
      a.state_version - b.state_version ||
      a.receipt_seq - b.receipt_seq
  );

  const lines = [];
  let currentLine = [];

  for (const word of accepted) {
    currentLine.push(word.word);

    if (
      Number.isInteger(word.syllables) &&
      word.syllables > 0 &&
      word.syllables % 10 === 0
    ) {
      lines.push(currentLine.join(' '));
      currentLine = [];
    }
  }

  if (currentLine.length) {
    lines.push(currentLine.join(' '));
  }

  let canonical = null;

  if (lines.length === 14) {
    canonical =
      lines.slice(0, 4).join('\n') + '\n\n' +
      lines.slice(4, 8).join('\n') + '\n\n' +
      lines.slice(8, 12).join('\n') + '\n\n' +
      lines.slice(12, 14).join('\n');
  }

  const calculatedHash = canonical
    ? crypto
        .createHash('sha256')
        .update(canonical, 'utf8')
        .digest('hex')
    : null;

  const last = accepted.at(-1);

  return {
    ...submission,
    accepted_words: accepted.length,
    reconstructed_lines: lines.length,
    final_state_version: last?.state_version ?? null,
    final_syllables: last?.syllables ?? null,
    complete: last?.complete ?? false,
    final_version_match:
      last?.state_version === submission.final_version,
    hash_match:
      calculatedHash === submission.poem_sha256,
    calculated_poem_sha256: calculatedHash,
    poem: canonical,
    lines
  };
}

const submissionRows = parseJsonl(
  await fs.readFile(SUBMISSIONS_FILE, 'utf8')
);

const submissions = acceptedSubmissions(submissionRows);

console.log(
  `Accepted submissions to audit: ${submissions.length}`
);

const results = new Array(submissions.length);
let nextIndex = 0;

async function worker() {
  while (true) {
    const index = nextIndex++;
    if (index >= submissions.length) return;

    const submission = submissions[index];

    process.stdout.write(
      `[${index + 1}/${submissions.length}] ` +
      `${submission.entry_id} ... `
    );

    try {
      const roomRows = await fetchRoom(submission.poem_room);
      const result = reconstruct(submission, roomRows);

      results[index] = result;

      console.log(
        result.hash_match &&
        result.final_version_match &&
        result.complete &&
        result.reconstructed_lines === 14
          ? 'VERIFIED'
          : 'CHECK'
      );
    } catch (error) {
      results[index] = {
        ...submission,
        fetch_error: String(error?.message || error)
      };

      console.log('FETCH ERROR');
    }
  }
}

await Promise.all(
  Array.from({ length: 6 }, () => worker())
);

await fs.writeFile(
  OUTPUT_FILE,
  JSON.stringify(results, null, 2)
);

const verified = results.filter(x =>
  !x.fetch_error &&
  x.hash_match === true &&
  x.final_version_match === true &&
  x.complete === true &&
  x.reconstructed_lines === 14
);

const checks = results.filter(x =>
  !x.fetch_error &&
  !verified.includes(x)
);

const failures = results.filter(x => x.fetch_error);

console.log('\n=== POEM AUDIT SUMMARY ===');
console.log('accepted submissions =', submissions.length);
console.log('fully verified =', verified.length);
console.log('needs check =', checks.length);
console.log('fetch failures =', failures.length);
console.log('output =', OUTPUT_FILE);

if (checks.length) {
  console.log('\n=== NEEDS CHECK ===');

  for (const x of checks) {
    console.log(
      x.entry_id,
      JSON.stringify({
        lines: x.reconstructed_lines,
        syllables: x.final_syllables,
        complete: x.complete,
        final_version_match: x.final_version_match,
        hash_match: x.hash_match
      })
    );
  }
}

if (failures.length) {
  console.log('\n=== FETCH FAILURES ===');

  for (const x of failures) {
    console.log(x.entry_id, '|', x.fetch_error);
  }
}
