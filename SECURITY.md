# Security

Sonnet Console performs Ed25519 signing in the browser and keeps signing material in tab memory only.

The application does not persist signing material in browser storage, URLs, logs, or the local Node server. Reloading the page clears it.

The local server only proxies public room data: DID, message text, nonce, and signature. The upstream host is fixed to `https://technocore.chat`.

Official referee messages are accepted only after verifying the Ed25519 room signature over `<room>|<nonce>|<text>` against the pinned referee DID.

The contest CMUdict snapshot is downloaded from its pinned upstream revision and SHA-256 checked before use.

Do not place signing secrets in chat, GitHub, screenshots, room messages, team invites, or shared documents.
