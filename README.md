# 🎲 Liar's Dice

Real-time multiplayer Liar's Dice (Swindlestones-style), server-authoritative, room-based, with reconnect support.

**Live demo:** https://liar-s-dice-game.onrender.com
*(free-tier host — spins down after ~15 min idle; first request after that takes ~30-50s to cold-start)*

## Rules, briefly

Each player rolls a hidden hand of dice at the start of a round. On your turn you either **raise** the standing bid — "at least N dice showing face F exist across every hand at the table" — or **call** it a bluff. A raise must strictly increase the quantity, or keep the quantity and increase the face. A call reveals every hand; if the bid holds (actual count ≥ claimed), the bidder wins and the caller loses a die, and vice versa. Eliminated players (0 dice) are skipped in turn order; last player with dice remaining wins. Full walkthrough is in the app's in-game "How to Play" panel, illustrated with the same dice components used in play.

## Stack

- **Node.js + Express** — process host, serves `public/` as static assets
- **Socket.IO** — WebSocket transport (falls back to HTTP long-polling) for all game events
- **Vanilla JS / HTML / CSS**, no build step, no frontend framework — the client is a thin renderer over server-pushed state, so there was nothing complex enough client-side to justify one

## Design

### Server-authoritative state, not client-trusted state

The server holds the only copy of every player's dice (`gameState.hands`). Clients never receive it. Instead, on every state change the server fans out a *personalized* payload per socket:

```js
room.players.forEach((player, playerIndex) => {
    io.to(player.socketId).emit('stateUpdate', {
        ...publicFields,
        myHand: gameState.hands[playerIndex],   // only this player's own dice
        myIndex: playerIndex
    });
});
```

This isn't "hide it in the UI and hope" — opponents' hands are simply never serialized into a packet this client's socket subscribes to, so there's nothing to find by inspecting network traffic or bypassing the DOM.

The same distrust applies to every mutating action. The client disables buttons when it isn't your turn, but that's UX, not enforcement — the server independently checks `senderIndex === gameState.currentPlayer` on every `raise`/`call`, re-validates bid legality via the same pure `isValidRaise()` the rules engine uses, and range-checks bid quantity/face against what's physically possible (`quantity ≤ totalDiceOnTable`, `face ≤ numFaces`) before touching state. A malicious client emitting raw Socket.IO events with no UI at all gets the same enforcement as the real client.

### Rooms

The server hosts many concurrent, fully isolated games rather than one global game:

```js
rooms: Map<roomCode, { players: [...], gameState: null | {...} }>
socketRoom: Map<socket.id, roomCode>   // O(1) "which room is this socket in"
```

Joining with no code generates a fresh 4-character code (`ABCDEFGHJKLMNPQRSTUVWXYZ23456789` — ambiguous glyphs `0/O/1/I` excluded) and creates a room; joining with a code attaches to it if it exists and isn't mid-game. Broadcasts are scoped via Socket.IO's own room primitive (`socket.join(roomCode)`, `io.to(roomCode).emit(...)`), so one room's traffic never reaches another's sockets. Empty rooms (`players.length === 0`) are deleted immediately rather than accumulating.

### Reconnection

`socket.id` is per-connection and changes on every reconnect — it can't be the player's persistent identity. Each player instead gets a server-generated opaque `token` at join time, stored client-side in `localStorage` alongside their room code. On disconnect, the server does **not** remove the player or touch `gameState` — it marks them `connected: false` and starts a grace timer (`DISCONNECT_GRACE_MS`, default 30s, overridable via env var). If a socket presents that token + room code before the timer fires, the player's existing seat is reattached (`socketId` updated in place, position in `room.players` unchanged) and they receive a fresh `stateUpdate` with their actual current hand and dice count — indistinguishable from having never left.

The reason the seat is *reattached* rather than the player being rejoined fresh: player array index is load-bearing. Once a game starts, `gameState.hands`, `gameState.playerDiceCounts`, and `gameState.currentPlayer` are all indexed positionally against `room.players`. Splicing a disconnected player out mid-game would silently shift every later player's index against state that assumes fixed positions. So a mid-game disconnect either resolves via reconnect-in-place, or — if the grace period lapses — the game is ended outright (`gameAborted`) rather than attempting a renumbering that the rest of the state model isn't built to support. A lobby-phase (pre-game) disconnect has no such constraint and is removed cleanly on timeout.

The client mirrors this: `joinedRoom` persists `{roomCode, token, name}` to `localStorage`; on every fresh socket connection (including the very first page load after a refresh) it immediately attempts `join` with whatever's stored, before the user does anything. A rejected reconnect (expired token, room gone) clears the stored session so it doesn't keep retrying a dead one.

### Concurrency / persistence model

All state is in-process memory — no database, no Redis. This is a deliberate scope decision, not an oversight, with real consequences worth being explicit about:

- **Single instance only.** Horizontal scaling would require moving `rooms`/`socketRoom` into a shared store (Redis) and adding the Socket.IO Redis adapter for cross-instance pub/sub, since a WebSocket connection is pinned to whichever instance accepted it.
- **A process restart drops every in-progress game.** No persistence layer to recover from.
- **Bounded by available memory**, though a Liar's Dice room's state footprint is trivial (a handful of small arrays per room) — this would only matter at a scale far beyond what this deployment targets.

For this project's scope (small group, ephemeral games, single Render instance) this tradeoff buys a simpler system with no infra dependency, at the cost of not surviving a restart or scaling past one process.

## Event protocol

| Direction | Event | Payload | Notes |
|---|---|---|---|
| C→S | `join` | `{ name, roomCode?, token? }` | `roomCode` empty → create new room. `token` present → reconnect attempt first, falls back to fresh join if it doesn't match. |
| C→S | `startGame` | `{ startingDice, numFaces }` | Server clamps to `[1,10]` / `[2,20]` regardless of client input. |
| C→S | `raise` | `{ bidQuantity, bidFace }` | Rejected silently (`invalidRaise`) unless it's the sender's turn and the raise is legal. |
| C→S | `call` | — | Requires an existing bid and it being the sender's turn. |
| C→S | `rollNextRound` | — | Only valid while `awaitingRoll` is true (i.e. after a call resolved, before the next round). |
| S→C | `joinedRoom` | `{ roomCode, token }` | Sent once, to the joining/reconnecting socket only. |
| S→C | `lobbyUpdate` | `[{ name, connected }]` | Broadcast to the room on any membership/connection change. |
| S→C | `stateUpdate` | see below | Sent per-socket, personalized (own hand only). |
| S→C | `roundResult` / `gameOver` | `{ hands, bidQuantity, bidFace, loserIndex, winnerRoundIndex, winnerIndex? }` | Full reveal — safe to broadcast room-wide since the round/game is already decided. |
| S→C | `playerDisconnected` / `playerReconnected` | `name` | Room-wide status notices, don't affect game state. |
| S→C | `gameAborted` | `message` | Fired when a mid-game disconnect's grace period lapses. |
| S→C | `invalidRaise` / `notYourTurn` / `joinRejected` | `message?` | Sent only to the offending socket. |

`stateUpdate` shape:
```js
{
  playerNames, playerDiceCounts, playerConnected,  // public, array-parallel to player index
  numFaces, currentPlayer, currentBidQuantity, currentBidFace, awaitingRoll,
  myHand,   // this recipient's dice only
  myIndex   // this recipient's position in the arrays above
}
```

## File layout

```
server.js            Authoritative game server: rooms, connection lifecycle, turn/rule enforcement
public/
  rules.js            Pure game-rule functions (rolling, bid validation, call resolution, turn advancement) -
                       zero I/O, shared verbatim between server.js (via require) and the browser (via <script>)
  game.js              Client: renders whatever state the server last pushed, forwards user intent as socket
                       events, owns no game logic of its own
  index.html           Page structure + how-to-play modal markup
  style.css            Theming, the die-tile component, reveal cards, modal
```

`rules.js` is dual-environment by design (`module.exports` guarded by `typeof module !== 'undefined'`) so the identical rule logic runs both inside the trusted server process and, harmlessly, in the browser as the source for the rules-modal illustrations — there's exactly one implementation of the rules, not two that could drift.

## Running locally

```bash
npm install
npm start        # or: DISCONNECT_GRACE_MS=5000 node server.js  to shorten the reconnect grace window for testing
```

Open `http://localhost:3000` in two browser tabs (or share your LAN IP) to play against yourself, or with someone else on the same network.

## Known limitations / natural extensions

- No persistence — see Concurrency section above.
- No spectator mode; you're either a seated player or not in the room.
- No auth — a name is not an identity, anyone with a room code can claim any seat that isn't currently occupied by joining fresh (this is fine for a "share a code with friends" trust model, not for anything adversarial).
- Free-tier hosting cold-start (~30-50s) after idle — a paid tier or a different host removes this, not a code constraint.
