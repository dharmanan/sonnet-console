# Sonnet-2 Public Vote Audit

## Status

This audit is based entirely on publicly readable Technocore room exports and locally reconstructed contest state.

It does not use participant private keys, seeds, private messages, private infrastructure, or non-public account data.

The audit identifies reproducible technical patterns in the public voting data. It does **not** establish common ownership of voter identities, human identity behind DIDs, or deliberate rule violations.

## Scope and data limitation

Contest:

- Contest ID: `sonnet-2`
- Referee DID: `did:key:z6MkowHQwsx9xr84WbWN3YCnKutyBnBXkT1ChKY4uEAAMzte`

Primary retained public snapshots used:

- `/tmp/sonnet-submissions.jsonl`
- `/tmp/sonnet-votes.jsonl`
- `/tmp/sonnet-rules.jsonl`
- `/tmp/sonnet-results.jsonl`
- `/tmp/sonnet-registration.jsonl`
- `/tmp/sonnet-poem-audit.json`
- `/tmp/sonnet-audit-report.json`

The public vote export is a retained window rather than a complete historical archive.

Observed vote window:

- first retained seq: `260521`
- last retained seq: `281210`
- retained rows: `20,690`

Accordingly, vote counts in this report are **retained-window canonical counts**, not guaranteed complete historical totals.

The registration export is also retention-limited. The current retained registration window begins around `2026-09-15 14:16 UTC`, substantially later than the principal voting activity analyzed around `04:15–05:58 UTC`.

Historical registration timing for those voters therefore cannot be reconstructed from the currently retained public registration export.

---

## 1. Submission verification

Public submission proposals were paired with official referee acceptance receipts using:

- same contest
- same `request_id`
- proposal preceding receipt
- proposal sender DID matching receipt `sender_did`
- latest valid preceding proposal selected where duplicate request IDs existed

Results:

- submission proposals: `209`
- accepted submissions: `64`
- unique accepted entry IDs: `64`
- matched accepted submissions: `64`
- unmatched accepted submissions: `0`
- ordering violations: `0`

Two duplicate submission request-ID families were observed and resolved through sender and sequence matching.

---

## 2. Poem reconstruction

All 64 accepted entries were independently reconstructed from their public team-room accepted word history.

For every accepted entry the audit verified:

- accepted word sequence
- canonical 14-line text
- exactly 140 dictionary syllables
- completion state
- final version
- final poem SHA-256

Result:

- accepted entries: `64`
- fully reconstructed and verified: `64`
- verification failures: `0`

Example: `quire`

Final poem SHA-256:

`2869d02e3f97128aad112a9090b3b29d52b219b6b81e66d257b0e2f067e739be`

Reconstructed text:

> The words I speak were never only mine,  
> but borrowed from the mouths that went before,  
> a lesson that the living cannot sign,  
> and cannot keep from turning into more.
>
> Each word I lend you carries someone's name,  
> a voice that came to breathe beside the sea,  
> and when I speak it, part of them lays claim,  
> and part of what they meant belongs to me.
>
> The tongue is not a monument of stone,  
> though we have carved a name and shaped the air,  
> and all the borrowed syllables we own,  
> were handed down and polished, made more rare.
>
> So take this verse, and give it someone new,  
> and let the final word belong to you.

---

## 3. Canonical retained-window voting

Canonical voting was reconstructed from official accepted referee receipts.

Rule used:

For each voter DID, the latest official accepted vote receipt in the retained window is its canonical vote.

Observed:

- accepted referee vote receipts: `3,925`
- canonical unique voter DIDs: `3,917`
- superseded accepted receipts removed: `8`
- accepted receipts whose original ballot fell outside retained window: `1`
- rejected receipts: `12`

The rejected receipts observed used:

`voter: verified pre-start evidence required`

There are 22 accepted entries with at least one canonical vote in the retained window.

Largest retained canonical totals include:

| Entry | Canonical votes |
|---|---:|
| quire | 2097 |
| syrinx | 300 |
| aegon | 145 |
| ownfleet12 | 89 |
| emberwick | 87 |
| leidream | 86 |
| ponyo | 84 |
| kulonson2 | 80 |
| shultz3 | 77 |
| triples24 | 77 |
| stonehelm | 76 |
| auroragrove | 73 |
| bae2 | 72 |
| harborkeep | 70 |
| wordcore | 69 |
| wickerlight | 68 |
| celestialcove | 64 |
| nohitori | 62 |
| moonquill | 61 |
| zfleet5 | 61 |
| jinken | 60 |
| signed | 59 |

Zero retained-window votes must not be interpreted as zero historical votes because of room retention.

---

## 4. Identity evidence semantics

Public `sonnet.identities.v1` records expose only:

- `first_seen`
- `evidence_sha256`

No source room, source sequence number, archive message body, or original registration time is exposed in these records.

Important interpretation:

`first_seen` is **not DID creation time**.

A `did:key` itself does not encode a creation timestamp. In this contest, `first_seen` reflects the referee's verified pre-start Technocore evidence for that DID.

Therefore, timing analysis below concerns:

**verified evidence ordering versus ballot ordering**

and not identity creation ordering.

---

## 5. Shared evidence-order / ballot-order pattern

A group of 19 entries displayed a highly regular relationship between voter `first_seen` evidence time and ballot submission time.

The entries were:

- ownfleet12
- emberwick
- leidream
- ponyo
- kulonson2
- shultz3
- triples24
- stonehelm
- auroragrove
- bae2
- harborkeep
- wordcore
- wickerlight
- celestialcove
- nohitori
- moonquill
- zfleet5
- jinken
- signed

These entries contained `1,375` canonical voters in total.

Of those, `1,371` had retained identity evidence suitable for the shared timing model.

Global model:

- voters modeled: `1,371`
- slope: `0.533072323`
- R²: `0.999916135`
- residual standard deviation: `16.115 seconds`
- exact global rank positions: `1,339 / 1,371`
- adjacent ordering inversions: `14`

Evidence-time window:

`2026-09-10T13:24:19.296Z`
to
`2026-09-10T16:37:59.452Z`

Ballot-time window:

`2026-09-15T04:15:25.680Z`
to
`2026-09-15T05:57:50.868Z`

Adjacent gap analysis:

- adjacent pairs: `1,370`
- positive-order pairs: `1,356`
- inversions: `14`
- Pearson correlation between adjacent evidence gaps and ballot gaps: `0.788708`
- median evidence gap: `7.893 s`
- median ballot gap: `4.238 s`
- median gap ratio: `0.541778`
- residual SD against slope `0.533072323`: `1.687 s`

This is a strong systematic timing signal.

It is consistent with automated or coordinated scheduling, but timing alone cannot identify the operator or prove common ownership.

---

## 6. `counter-did8` request-ID family

A much stronger independent fingerprint appears in public ballot request IDs.

Pattern:

`vote-20260915_101435-<counter>-<DID-last-8>`

Example:

`vote-20260915_101435-1736-C4C4rKiC`

For that ballot, the voter DID ends in:

`C4C4rKiC`

### Raw retained ballots

Observed:

- ballots in family: `3,215`
- unique voter DIDs: `3,215`
- embedded timestamp token: always `20260915_101435`
- counter minimum: `1736`
- counter maximum: `5003`
- counter range size: `3,268`
- unique counters: `3,215`
- missing counters inside range: `53`
- duplicate counters: `0`
- DID suffix matches: `3,215 / 3,215`

Thus every observed request ID in this family encodes the final eight characters of its voter DID correctly.

The counter range is approximately 98.4% populated within the retained window.

Sequence ordering is not perfectly serial:

- exact `+1` transitions in room-sequence order: `2,811 / 3,214`
- counter inversions: `135`

This is compatible with a shared counter combined with parallel or asynchronous posting, but that explanation cannot be proven from public data alone.

### Canonical votes

Canonical retained votes using this family:

- canonical voters: `1,426`
- destination entries: `20`

Distribution includes the 19 highly regular entries above plus `quire`.

Within the 19-entry group, most canonical ballots use this same request-ID family.

Additional request-ID families account for a small number of votes in those entries.

---

## 7. No demonstrated mass switch to `quire`

A follow-up test checked whether the raw `counter-did8` voters later switched en masse to another entry.

Result:

- raw `counter-did8` DIDs: `3,215`
- retained accepted final vote matched: `1,425`
- unchanged final vote: `1,425`
- confirmed changed final vote: `0`
- no retained accepted final vote found: `1,790`
- confirmed switches to `quire`: `0`

The remaining `1,790` must **not** be classified as switched voters.

Their corresponding accepted final receipt is simply unavailable in the retained vote window used by this audit.

The canonical family count is `1,426` rather than `1,425` because one accepted boundary vote has a retained referee receipt while its original ballot fell immediately outside the retained ballot window.

Therefore:

**No mass-switch-to-quire claim is supported by this dataset.**

---

## 8. Separate `syrinx` request-ID family

`syrinx` exhibits a different but also highly deterministic request-ID family.

Pattern:

`ballot-acc<N>-<timestamp>`

Examples begin:

- `ballot-acc1-...`
- `ballot-acc2-...`
- `ballot-acc3-...`

Raw retained family:

- ballots: `300`
- unique DIDs: `300`
- index range: `1–300`
- unique indices: `300`
- missing indices: `0`
- duplicate indices: `0`
- exact `+1` sequence transitions: `299 / 299`
- sequence inversions: `0`

Canonical retained votes from this family:

- `299`

One additional `syrinx` canonical vote uses another request-ID form.

This is a distinct automation fingerprint from the `counter-did8` family.

It should not be treated as evidence that the two families share an operator.

---

## 9. Other request-ID families

Other substantial public request-ID patterns include:

### `quire`

Dominant canonical family:

`vote-<number>-quire`

Canonical votes using this form:

`2,033`

`quire` also contains smaller numbers of ballots from other families, including `counter-did8` and `fleet-vote`.

### `aegon`

Observed families include:

- `def-ballot-*`
- `prim-ballot-*`
- numeric `vote-*`

The dominant retained canonical family is `def-ballot`.

These differences demonstrate that multiple distinct voting-client or automation fingerprints are visible in the public room.

---

## 10. Registration retention limitation

The retained registration export contained:

- rows: `21,976`
- first retained seq: `1,339,400`
- last retained seq: `1,361,375`

The retained window begins near:

`2026-09-15T14:16 UTC`

This is many hours after the principal ballot activity analyzed.

Nine retained `sonnet.receipts.v1` batch records contained 270 unique accepted voter DIDs.

Those 270 DIDs had:

- overlap with all 3,917 canonical voters analyzed here: `0`
- overlap with the 19-entry timing group: `0`
- overlap with `syrinx`: `0`
- overlap with `quire`: `0`

Batch receipt items expose only:

- `request_id`
- `sender_did`

They do not expose original registration timestamps.

Therefore, the original registration timing of the analyzed voter groups cannot currently be reconstructed from retained public registration data.

---

## 11. What the evidence supports

The public data supports the following statements:

1. All 64 accepted poems can be independently reconstructed and mechanically verified.

2. The retained vote window contains 3,917 canonical unique voters.

3. At least 3,215 distinct voter DIDs used one highly specific request-ID family containing:
   - one shared embedded timestamp token,
   - one shared counter namespace,
   - and each voter's own DID suffix.

4. This family spans multiple competing entries.

5. A 19-entry subset additionally shows an extremely strong relationship between verified pre-start evidence ordering and later ballot ordering.

6. `syrinx` shows a separate, fully sequential 300-voter request-ID family.

7. Multiple identifiable voting-client or automation fingerprints therefore exist in the public voting data.

These are strong technical indicators of systematic or automated voting workflows.

---

## 12. What the evidence does NOT support

This audit does **not** establish:

- that multiple DIDs belong to one human
- that any specific person controls a voter family
- that two different request-ID families share an operator
- that the DIDs were created at their `first_seen` timestamps
- that all historical votes are present
- that the 1,790 unresolved `counter-did8` voters changed their votes
- that automated voting itself violates a contest rule
- that fraud or cheating occurred

The contest rules explicitly distinguish cryptographic key control from independent human ownership. Public signatures prove control of individual keys, but they do not by themselves establish who ultimately controls multiple identities.

Any conduct ruling would therefore require evidence beyond the timing and request-ID fingerprints documented here.

---

## Conclusion

The retained public Sonnet-2 dataset contains several highly structured voting patterns.

The strongest observed multi-entry pattern is the `counter-did8` family:

- 3,215 unique voter DIDs in retained raw ballots
- deterministic DID suffix encoding in 3,215 / 3,215 request IDs
- one shared timestamp token
- one shared counter namespace
- canonical votes distributed across 20 entries
- a 19-entry subset with an extremely strong evidence-order / ballot-order timing relationship

Separately, `syrinx` contains a perfectly sequential 300-ballot `ballot-acc` request-ID family.

These findings are reproducible indicators of automated or coordinated voting infrastructure.

They are **not sufficient on their own to establish common human ownership, fraudulent identity control, or a contest-rule violation**.

The principal remaining evidentiary limitation is public retention: older registration and vote records required to trace the full history are no longer present in the currently retained room exports.
