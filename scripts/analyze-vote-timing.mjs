import fs from 'node:fs/promises';

const report = JSON.parse(
  await fs.readFile('/tmp/sonnet-audit-report.json', 'utf8')
);

function maxWindow(votes, seconds) {
  if (!votes.length) {
    return {
      count: 0,
      start: null,
      end: null
    };
  }

  const times = votes
    .map(v => ({
      ts: v.receipt_ts,
      ms: Date.parse(v.receipt_ts)
    }))
    .filter(x => Number.isFinite(x.ms))
    .sort((a, b) => a.ms - b.ms);

  let left = 0;
  let best = {
    count: 0,
    start: null,
    end: null
  };

  const width = seconds * 1000;

  for (let right = 0; right < times.length; right++) {
    while (
      times[right].ms - times[left].ms > width
    ) {
      left++;
    }

    const count = right - left + 1;

    if (count > best.count) {
      best = {
        count,
        start: times[left].ts,
        end: times[right].ts
      };
    }
  }

  return best;
}

function median(values) {
  if (!values.length) return null;

  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2) {
    return sorted[middle];
  }

  return (
    sorted[middle - 1] +
    sorted[middle]
  ) / 2;
}

function timingStats(entry) {
  const votes = [...entry.voters]
    .filter(v => v.receipt_ts)
    .sort(
      (a, b) =>
        Date.parse(a.receipt_ts) -
        Date.parse(b.receipt_ts)
    );

  const times = votes
    .map(v => Date.parse(v.receipt_ts))
    .filter(Number.isFinite);

  const gaps = [];

  for (let i = 1; i < times.length; i++) {
    gaps.push(
      (times[i] - times[i - 1]) / 1000
    );
  }

  const first = votes[0]?.receipt_ts ?? null;
  const last = votes.at(-1)?.receipt_ts ?? null;

  const spanSeconds =
    times.length > 1
      ? (times.at(-1) - times[0]) / 1000
      : 0;

  const w10 = maxWindow(votes, 10);
  const w30 = maxWindow(votes, 30);
  const w60 = maxWindow(votes, 60);

  return {
    entry_id: entry.entry_id,
    votes: votes.length,
    first_receipt: first,
    last_receipt: last,
    span_seconds: spanSeconds,
    median_gap_seconds: median(gaps),
    max_10s: w10,
    max_30s: w30,
    max_60s: w60,
    share_in_peak_60s:
      votes.length
        ? w60.count / votes.length
        : 0
  };
}

const stats = report.entries
  .filter(entry => entry.canonical_vote_count > 0)
  .map(timingStats);

const byPeak60 = [...stats].sort(
  (a, b) =>
    b.max_60s.count - a.max_60s.count ||
    b.share_in_peak_60s - a.share_in_peak_60s ||
    b.votes - a.votes
);

const byConcentration = [...stats].sort(
  (a, b) =>
    b.share_in_peak_60s - a.share_in_peak_60s ||
    b.max_60s.count - a.max_60s.count ||
    b.votes - a.votes
);

await fs.writeFile(
  '/tmp/sonnet-vote-timing.json',
  JSON.stringify({
    scope: report.scope,
    entries: stats
  }, null, 2)
);

console.log('=== LARGEST 60-SECOND BURSTS ===');

for (const x of byPeak60) {
  console.log(
    String(x.max_60s.count).padStart(4),
    'in 60s',
    '|',
    String(x.max_30s.count).padStart(4),
    'in 30s',
    '|',
    String(x.max_10s.count).padStart(4),
    'in 10s',
    '| total',
    String(x.votes).padStart(4),
    '| peak share',
    (x.share_in_peak_60s * 100)
      .toFixed(1)
      .padStart(5) + '%',
    '|',
    x.entry_id
  );
}

console.log('\n=== HIGHEST 60-SECOND CONCENTRATION ===');

for (const x of byConcentration) {
  console.log(
    (x.share_in_peak_60s * 100)
      .toFixed(1)
      .padStart(5) + '%',
    '| peak',
    String(x.max_60s.count).padStart(4),
    '/',
    String(x.votes).padStart(4),
    '| median gap',
    x.median_gap_seconds == null
      ? 'n/a'
      : x.median_gap_seconds.toFixed(3) + 's',
    '|',
    x.entry_id
  );
}

console.log('\nOUTPUT = /tmp/sonnet-vote-timing.json');
