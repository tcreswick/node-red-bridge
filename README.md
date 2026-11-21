# @tcreswick/node-red-bridge

Securely link two (or more) Node-RED instances: a **remote link-in / link-out** with key-based pairing,
an encrypted WebSocket transport, per-node visibility, live discovery of the remote's node names,
keepalive and automatic reconnect.

- Works through NAT: only the *connect* side dials out; the *listen* side never dials.
- No extra port: the *listen* side serves a WebSocket on Node-RED's own HTTP server (default path `/bridge/ws`). Put TLS (`wss://`) in front with your usual reverse proxy.
- One dependency (`ws`); crypto is Node's built-in `crypto`.

## Nodes

| Node | Purpose |
|---|---|
| **bridge-remote** (config) | One per remote instance. Role (`connect`/`listen`), URL, keepalive/backoff, pairing wizard, live status, exposure matrix, discovered remote nodes. |
| **bridge-out** | Like link-out: sends the whole `msg` to a named **bridge-in** on the remote. Target dropdown is filled from discovery (free text works too). Completes when the remote acknowledged; errors go to Catch. Offline policy: raise error (default) / drop with warning / queue (N msgs, T s). `msg.bridgeTarget` overrides the target. |
| **bridge-in** | Like link-in: emits messages sent by the remote. Adds `msg._bridge = {remote, remoteId, from}`. |
| **bridge-status** | Emits `{payload: 'online'\|'offline', remote, reason, since}` on connect / disconnect / auth failure (all remotes or one; optional emit on deploy). |
| **bridge-call** / **bridge-reply** | Request/response: a call sends to a remote bridge-in and waits (timeout) for the msg that a **bridge-reply** returns (the msg must still carry `msg._bridge`). |

All bridge nodes show green (connected) / yellow (connecting, waiting) / red (offline, auth failed, unpaired) status.

## Pairing walkthrough

1. **Listen side** (the one reachable by the other): add a *bridge-remote*, role **listen**, set *Public URL* to what the other side can reach (e.g. `wss://nodered.example.com/bridge/ws` or `ws://192.168.1.10:1880/bridge/ws`). Deploy. Click **Create pairing code**.
2. **Connect side**: add a *bridge-remote*, role **connect**, deploy, paste the code and click **Pair**. The URL is taken from the code.
3. Both configs turn green. Both show the key fingerprints: compare them out of band if you want certainty.
4. Add bridge-in / bridge-out nodes and tick which remotes may see them (see below), deploy.

The pairing code (base64url JSON: URL, public key, one-time token, expiry) is single use and valid for 10 minutes. After pairing the token is gone and both sides authenticate by key at every (re)connect. **Unpair / revoke** on either side removes the trust on both sides (the remote is told if online).

Admin HTTP API used by the editor (needs the usual `bridge-remote.read` / `.write` permission): `GET /bridge/:id/state`, `POST /bridge/:id/code`, `POST /bridge/:id/pair`, `POST /bridge/:id/unpair`.

## Visibility (opt-in, per direction)

A bridge-in / bridge-out node is advertised to and usable by a remote only if it is **ticked** for that remote: either in the node's editor ("remotes allowed to see this node") or in the config node's exposure matrix (same data, editing either updates the other). New nodes have nothing ticked. A config node can instead be set to **share all** nodes. Remotes only see names they are allowed to see; sending to a hidden or unknown name fails with an error that reaches your Catch node.

## Security notes

- Each instance has an Ed25519 identity key, stored with mode 0600 in `<userDir>/bridge-identity.json` together with the trusted peer keys (not in flows, not in credentials; **back it up with your userDir**, and keep it out of repos). Losing it means re-pairing.
- Handshake: both sides sign a transcript (nonces + ephemeral X25519 keys); the dialing side pins the listener's key from the pairing code, the listener only accepts paired keys. Session keys come from X25519 + HKDF (forward secret), each direction has its own key; frames are AES-256-GCM with a strictly increasing counter (replay / reorder protection). Plain `ws://` over a LAN is therefore not cleartext, but use `wss://` across the internet anyway for a second layer and to hide metadata.
- The pairing token is never sent in clear; it is proven with an HMAC over the handshake transcript. Treat the pairing code like a password for 10 minutes.
- The WebSocket endpoint is **not** behind Node-RED adminAuth (the remote has no editor login); it only speaks the key-authenticated protocol and drops everything else after a 10 s handshake timeout.
- A paired remote can send messages to every bridge-in you ticked for it, so only tick what you intend to expose. Messages are not otherwise validated: treat incoming `msg` as untrusted input.
- Limits: max message size (default 10 MB, configurable), `req`/`res` are removed, functions dropped with a warning, Buffers are preserved (base64 with a type tag), other values go through JSON.

## Reliability

Application-level ping/pong (default every 15 s, offline after 45 s without traffic). The connect side reconnects with exponential backoff (default 1 s doubling up to 60 s, jittered; authentication failures retry at the cap). Node lists are exchanged on every (re)connect and pushed live when you redeploy.

## Tests

```
npm test                   # unit tests: handshake, framing/replay, token single use, keepalive, ACL, serialisation, store
npm run test:integration   # starts TWO real Node-RED runtimes (installs node-red into $BRIDGE_IT_DIR, default <tmp>/nr-bridge-it)
```

The integration test pairs the instances, sends messages both ways, checks that hidden nodes are not reachable, exercises call/reply, kills and restarts both sides (auto-reconnect without re-pairing) and unpairs.

## Examples

`examples/bridge-listen-side.json` and `examples/bridge-connect-side.json` (import one on each instance and pair).

## Licence

MIT
