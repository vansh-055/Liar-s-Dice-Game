# 🎲 Liar's Dice

A real-time multiplayer Liar's Dice (Swindlestones-style) game. Create a room, share the code, bluff your friends.

**Live demo:** https://liar-s-dice-game.onrender.com

## How it works

Each player rolls a hidden hand of dice. On your turn you either raise the standing bid ("at least N dice showing face F, across everyone's hands") or call it a bluff — at which point every hand is revealed and whoever was wrong loses a die. Last player with dice left wins. Full walkthrough is in the in-app "How to Play" panel.

## Stack

- **Node.js + Express** — serves the static client and hosts the game server
- **Socket.IO** — real-time bidirectional communication between server and clients
- **Vanilla JS, HTML, CSS** — no frontend framework or build step

## Architecture

The server is the sole source of truth. Every player's dice are rolled and held server-side; each client is sent a *personalized* view of the game state containing only their own hand — opponents' dice are never transmitted, so there's nothing to find even by inspecting network traffic. Every action (raise, call) is re-validated server-side regardless of what the UI allows client-side, since a browser client can never be trusted to enforce its own rules.

The server hosts multiple independent games at once via a room system — each room has its own isolated player list and game state, addressed by a short shareable code.

```
server.js          Authoritative game server: rooms, turn order, rule enforcement
public/
  rules.js          Pure game-rule functions (no I/O) - shared logic, also usable from Node directly
  game.js            Client: renders server state, forwards user actions as socket events
  index.html         Page structure
  style.css          Styling, dice rendering, rules-modal illustrations
cli.js               Standalone terminal version for testing rules.js in isolation (not deployed)
```

## Running locally

```bash
npm install
npm start
```

Then open `http://localhost:3000` in a couple of browser tabs (or share your local network IP with someone else on the same network) to play.
