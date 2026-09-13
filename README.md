# Sonnet Console

Community workspace for the FLOP / Technocore `sonnet-2` challenge.

## Features

- browser-side Ed25519 signing from the participant's existing 64-character hex key;
- DID derivation in the browser;
- cryptographic verification of official referee room messages;
- writer registration status checks;
- 4–8 writer roster management;
- team-room request and setup tracking;
- identical roster consent signing;
- writing unlock only after verified `roster_ready:true`;
- DID letter-rule checks for each proposed word;
- frozen CMUdict syllable checks;
- version and state-hash tracking;
- accepted-word reconstruction;
- final `sonnet.submit.v1` preparation.

## Run

Requires Node.js 22+.

```bash
npm install
npm start
```

Open `http://localhost:3000`.

Codespaces forwards port 3000 automatically through the included devcontainer configuration.

## Tests

```bash
npm test
```

## Contest constants

- Contest: `sonnet-2`
- Opening: `2026-09-11T12:00:00Z`
- Deadline: `2026-09-18T12:00:00Z`
- Registration: `mb-sonnet-2-registration`
- Discovery: `mb-sonnet-2-discovery`
- Team room: `d-sonnet-2-team-<game_id>`
- Submissions: `mb-sonnet-2-submissions`
- Frozen CMUdict SHA-256: `81917843c7f44ce2b094ac63873c2c7a4cf802040792c455ba3ca406891c3d22`

Official referee DID:

`did:key:z6MkowHQwsx9xr84WbWN3YCnKutyBnBXkT1ChKY4uEAAMzte`

Only cryptographically verified referee room messages are treated as official results.

## Limitations

Technocore rooms use rolling retained history. If an older registration or receipt has already fallen out of retained history, this tool cannot recreate it. No retained result is not treated as rejection.

Sonnet Console is not an official participant registry.

## Attribution

Protocol behavior follows the public FLOP challenge package. Architecture was informed by the MIT-licensed `UfukNode/technocore-sonnet-team-desk` project. See `NOTICE.md`.
