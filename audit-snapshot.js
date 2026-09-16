import fs from 'node:fs/promises';

const TECHNOCORE = 'https://technocore.chat';
const CONTEST_ID = 'sonnet-2';
const REFEREE_DID =
  'did:key:z6MkowHQwsx9xr84WbWN3YCnKutyBnBXkT1ChKY4uEAAMzte';

const SUBMISSIONS_ROOM = 'mb-sonnet-2-submissions';
const VOTES_ROOM = 'mb-sonnet-2-votes';

const BASELINE_URL =
  new URL(
    './data/sonnet-vote-baseline.json',
    import.meta.url
  );

async function readBaseline() {
  const text = await fs.readFile(
    BASELINE_URL,
    'utf8'
  );

  return JSON.parse(text);
}

function parseRecord(message) {
  try {
    const value = JSON.parse(message?.text || '');

    return value &&
      typeof value === 'object' &&
      !Array.isArray(value)
      ? value
      : null;
  } catch {
    return null;
  }
}

async function fetchExport(room) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    15000
  );

  try {
    const response = await fetch(
      `${TECHNOCORE}/r/${encodeURIComponent(room)}/export`,
      {
        headers: {
          accept: 'application/x-ndjson,text/plain,*/*'
        },
        signal: controller.signal
      }
    );

    const text = await response.text();

    if (!response.ok) {
      throw new Error(
        `audit_export_${room}_${response.status}`
      );
    }

    return text
      .split('\n')
      .filter(Boolean)
      .map(line => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } finally {
    clearTimeout(timer);
  }
}

function requestFamily(requestId) {
  const id = String(requestId || '');

  if (
    /^vote-\d{8}_\d{6}-\d+-[A-Za-z0-9]{8}$/.test(id)
  ) {
    return 'counter-did8';
  }

  if (/^ballot-acc\d+-\d+$/.test(id)) {
    return 'ballot-acc';
  }

  if (/^vote-\d+-quire$/.test(id)) {
    return 'quire-vote';
  }

  if (/^fleet-vote-\d+-\d+$/.test(id)) {
    return 'fleet-vote';
  }

  if (/^def-ballot-/.test(id)) {
    return 'def-ballot';
  }

  if (/^prim-ballot-/.test(id)) {
    return 'prim-ballot';
  }

  if (/^vote-\d+$/.test(id)) {
    return 'numeric-vote';
  }

  return 'other';
}

export async function buildAuditSnapshot() {
  const baseline =
    await readBaseline();

  // Accepted entry listesi baseline içinde zaten doğrulanmış 64 entry.
  // Audit ekranı submissions export'una bağımlı olmasın.
  const submissionMessages = [];

  let voteMessages = [];
  let liveVoteError = '';

  try {
    voteMessages =
      await fetchExport(VOTES_ROOM);
  } catch (error) {
    // Technocore export geçici timeout olursa audit tamamen boş kalmasın.
    // Doğrulanmış baseline gösterilmeye devam eder.
    liveVoteError =
      String(error?.message || error);
  }

  const acceptedEntries =
    new Map(
      (baseline.entries || []).map(
        entry => [
          entry.entryId,
          {
            entryId: entry.entryId,
            gameId:
              entry.gameId ||
              entry.entryId,
            seq: 0
          }
        ]
      )
    );

  for (const message of submissionMessages) {
    if (message?.from !== REFEREE_DID) {
      continue;
    }

    const record = parseRecord(message);

    if (
      record?.type !== 'sonnet.receipt.v1' ||
      record?.contest_id !== CONTEST_ID ||
      record?.status !== 'accepted' ||
      !record?.entry_id
    ) {
      continue;
    }

    const seq = Number(message.seq || 0);
    const previous =
      acceptedEntries.get(record.entry_id);

    if (
      !previous ||
      seq > previous.seq
    ) {
      acceptedEntries.set(record.entry_id, {
        entryId: record.entry_id,
        gameId:
          record.game_id ||
          record.entry_id,
        seq
      });
    }
  }

  let firstVoteSeq = null;
  let lastVoteSeq = null;

  const latestByVoter =
    new Map();

  for (const voter of baseline.voters || []) {
    latestByVoter.set(
      voter.did,
      {
        did: voter.did,
        entryId: voter.entryId,
        requestId: '',
        seq: Number(
          voter.receiptSeq || 0
        ),
        source: 'baseline'
      }
    );
  }

  const liveLatestByVoter =
    new Map();

  for (const message of voteMessages) {
    const seq = Number(message?.seq || 0);

    if (seq > 0) {
      if (
        firstVoteSeq == null ||
        seq < firstVoteSeq
      ) {
        firstVoteSeq = seq;
      }

      if (
        lastVoteSeq == null ||
        seq > lastVoteSeq
      ) {
        lastVoteSeq = seq;
      }
    }

    if (message?.from !== REFEREE_DID) {
      continue;
    }

    const record = parseRecord(message);

    if (
      record?.type !== 'sonnet.receipt.v1' ||
      record?.contest_id !== CONTEST_ID ||
      record?.status !== 'accepted' ||
      !record?.sender_did ||
      !record?.entry_id
    ) {
      continue;
    }

    const vote = {
      did: record.sender_did,
      entryId: record.entry_id,
      requestId: String(
        record.request_id || ''
      ),
      seq
    };

    const livePrevious =
      liveLatestByVoter.get(vote.did);

    if (
      !livePrevious ||
      vote.seq > livePrevious.seq
    ) {
      liveLatestByVoter.set(
        vote.did,
        vote
      );
    }

    const previous =
      latestByVoter.get(vote.did);

    if (
      !previous ||
      vote.seq > previous.seq
    ) {
      latestByVoter.set(
        vote.did,
        {
          ...vote,
          source: 'live'
        }
      );
    }
  }

  const votesByEntry = new Map();

  for (const vote of latestByVoter.values()) {
    if (!votesByEntry.has(vote.entryId)) {
      votesByEntry.set(
        vote.entryId,
        []
      );
    }

    votesByEntry
      .get(vote.entryId)
      .push(vote);
  }

  const liveVotesByEntry =
    new Map();

  for (const vote of liveLatestByVoter.values()) {
    if (!liveVotesByEntry.has(vote.entryId)) {
      liveVotesByEntry.set(
        vote.entryId,
        []
      );
    }

    liveVotesByEntry
      .get(vote.entryId)
      .push(vote);
  }

  const entries =
    [...acceptedEntries.values()]
      .map(entry => {
        const votes =
          votesByEntry.get(entry.entryId) ||
          [];

        const liveVotes =
          liveVotesByEntry.get(entry.entryId) ||
          [];

        const familyCounts = new Map();

        for (const vote of liveVotes) {
          const family =
            requestFamily(
              vote.requestId
            );

          familyCounts.set(
            family,
            (familyCounts.get(family) || 0) + 1
          );
        }

        const families =
          [...familyCounts.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([family, count]) => ({
              family,
              count
            }));

        return {
          entryId: entry.entryId,
          gameId: entry.gameId,
          votes: votes.length,
          families
        };
      })
      .sort(
        (a, b) =>
          b.votes - a.votes ||
          a.entryId.localeCompare(
            b.entryId
          )
      );

  return {
    generatedAt:
      new Date().toISOString(),

    live: {
      available:
        liveVoteError === '',
      error:
        liveVoteError || null
    },

    retained: {
      voteRows: voteMessages.length,
      firstVoteSeq,
      lastVoteSeq
    },

    counts: {
      acceptedEntries:
        acceptedEntries.size,

      baselineCanonicalVoters:
        Number(
          baseline.canonicalVoters || 0
        ),

      liveRetainedCanonicalVoters:
        liveLatestByVoter.size,

      canonicalVoters:
        latestByVoter.size
    },

    baseline: {
      maxReceiptSeq:
        Math.max(
          0,
          ...(baseline.voters || [])
            .map(
              voter =>
                Number(
                  voter.receiptSeq || 0
                )
            )
        )
    },

    entries
  };
}
