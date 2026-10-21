const crypto = require('crypto');
const {
    rollAllHands, resolveCall, isValidRaise,
    removeDie, checkWinner, getNextActivePlayer, getPrevActivePlayer
} = require('./public/rules.js');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// How long a dropped connection gets to come back before we treat it as a real
// departure. Covers a refresh, a flaky wifi blip, a phone locking - not someone
// who's actually gone.
const DISCONNECT_GRACE_MS = parseInt(process.env.DISCONNECT_GRACE_MS) || 30000;

// Everything used to be one global game shared by every visitor. Now the server
// hosts many independent games at once, each identified by a short room code.
// player shape: { socketId, name, token, connected, disconnectTimer }
// `token` is a private per-player secret (never shown to other players) that
// survives a reconnect even though `socketId` does not - it's how the server
// recognizes "this new connection is actually seat 2 coming back", not a stranger.
let rooms = new Map();       // roomCode -> { players: [...], gameState: null|{...} }
let socketRoom = new Map();  // socket.id -> roomCode, so any handler can find "my room" in O(1)

const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I - easy to read aloud

function generateRoomCode() {
    let code;
    do {
        code = '';
        for (let i = 0; i < 4; i++) {
            code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
        }
    } while (rooms.has(code));
    return code;
}

function generateToken() {
    return crypto.randomBytes(16).toString('hex');
}

function broadcastLobby(roomCode) {
    let room = rooms.get(roomCode);
    if (!room) return;
    io.to(roomCode).emit('lobbyUpdate', room.players.map(p => ({ name: p.name, connected: p.connected })));
}

// Sends each player in a room their OWN view of that room's game.
// Note what is absent: the full `hands` array. Each browser only ever receives
// its own dice, so opponents' hands are genuinely hidden, not just hidden in the UI.
function sendStateToAll(roomCode) {
    let room = rooms.get(roomCode);
    if (!room || !room.gameState) return;
    let gameState = room.gameState;

    room.players.forEach((player, playerIndex) => {
        if (!player.connected) return; // nobody there to receive it right now
        io.to(player.socketId).emit('stateUpdate', {
            playerNames: gameState.playerNames,
            playerDiceCounts: gameState.playerDiceCounts,
            playerConnected: room.players.map(p => p.connected),
            numFaces: gameState.numFaces,
            currentPlayer: gameState.currentPlayer,
            currentBidQuantity: gameState.currentBidQuantity,
            currentBidFace: gameState.currentBidFace,
            awaitingRoll: gameState.awaitingRoll,
            myHand: gameState.hands[playerIndex],
            myIndex: playerIndex
        });
    });
}

// A room with nobody left in it should not sit in memory forever.
function cleanupRoomIfEmpty(roomCode) {
    let room = rooms.get(roomCode);
    if (room && room.players.length === 0) {
        rooms.delete(roomCode);
    }
}

// Called once a disconnected player's grace period actually runs out without
// them coming back. Only now do we treat it as a real departure.
function finalizeDisconnect(roomCode, token) {
    let room = rooms.get(roomCode);
    if (!room) return;

    let playerIndex = room.players.findIndex(p => p.token === token);
    if (playerIndex === -1) return;
    let player = room.players[playerIndex];
    if (player.connected) return; // they reconnected before the timer fired

    if (room.gameState) {
        // Player indices are baked into gameState (hands, dice counts, turn order)
        // the moment a game starts, so we can't remove a seat mid-game without
        // renumbering everything. Instead, treat the abandoned seat exactly like
        // a player who ran out of dice: getNextActivePlayer/getPrevActivePlayer
        // and checkWinner already skip 0-dice seats, so this alone makes the
        // game skip their turns forever, and declares a winner by default if
        // they were the only thing standing between the others and victory.
        let gameState = room.gameState;
        gameState.playerDiceCounts[playerIndex] = 0;
        // Clear their hand too, not just the count - countFace()/resolveCall()
        // read actual dice values from `hands`, so a stale hand here would let
        // their old dice keep counting toward bids after they're supposed to be out.
        gameState.hands[playerIndex] = [];
        io.to(roomCode).emit('playerAborted', `${player.name} didn't reconnect in time and is out.`);

        let winnerIndex = checkWinner(gameState.playerDiceCounts);
        if (winnerIndex !== null) {
            io.to(roomCode).emit('gameOver', { winnerIndex, hands: gameState.hands });
            room.gameState = null;
            broadcastLobby(roomCode);
        } else {
            if (gameState.currentPlayer === playerIndex) {
                gameState.currentPlayer = getNextActivePlayer(playerIndex, gameState.playerDiceCounts);
            }
            sendStateToAll(roomCode);
        }
        return;
    }

    // Not in a game (still in the lobby) - an abandoned seat here can just be
    // removed outright, no indices to preserve.
    room.players = room.players.filter(p => p.token !== token);
    broadcastLobby(roomCode);
    cleanupRoomIfEmpty(roomCode);
}

io.on('connection', (socket) => {
    console.log('A player connected:', socket.id);

    socket.on('join', (data) => {
        let name = ((data && data.name) || '').toString().trim();
        let requestedCode = ((data && data.roomCode) || '').toString().trim().toUpperCase();
        let token = ((data && data.token) || '').toString().trim();

        // ---- Reconnect path: a returning player presenting their old token ----
        if (token && requestedCode && rooms.has(requestedCode)) {
            let room = rooms.get(requestedCode);
            let existing = room.players.find(p => p.token === token);
            if (existing) {
                clearTimeout(existing.disconnectTimer);
                existing.socketId = socket.id;
                existing.connected = true;

                socketRoom.set(socket.id, requestedCode);
                socket.join(requestedCode);

                console.log('Player reconnected:', existing.name, socket.id, 'room:', requestedCode);
                socket.emit('joinedRoom', { roomCode: requestedCode, token: existing.token });
                io.to(requestedCode).emit('playerReconnected', existing.name);
                broadcastLobby(requestedCode);
                sendStateToAll(requestedCode);
                return;
            }
            // Token didn't match anyone (grace period already expired, or a stale
            // session from a previous visit) - fall through and join fresh below.
        }

        // ---- Fresh join path ----
        if (!name) {
            socket.emit('joinRejected', 'Enter a name first.');
            return;
        }

        let roomCode;
        if (requestedCode) {
            if (!rooms.has(requestedCode)) {
                socket.emit('joinRejected', `Room "${requestedCode}" doesn't exist.`);
                return;
            }
            roomCode = requestedCode;
        } else {
            roomCode = generateRoomCode();
            rooms.set(roomCode, { players: [], gameState: null });
        }

        let room = rooms.get(roomCode);

        if (room.gameState) {
            socket.emit('joinRejected', 'A game is already in progress in that room.');
            return;
        }
        if (room.players.some(p => p.socketId === socket.id)) {
            socket.emit('joinRejected', 'You have already joined.');
            return;
        }

        let newToken = generateToken();
        room.players.push({ socketId: socket.id, name: name, token: newToken, connected: true, disconnectTimer: null });
        socketRoom.set(socket.id, roomCode);
        socket.join(roomCode); // Socket.IO's own grouping - lets us io.to(roomCode).emit(...) below

        console.log('Player joined:', name, socket.id, 'room:', roomCode);
        socket.emit('joinedRoom', { roomCode, token: newToken });
        broadcastLobby(roomCode);
    });

    socket.on('startGame', (data) => {
        let roomCode = socketRoom.get(socket.id);
        let room = rooms.get(roomCode);
        if (!room) return;

        if (room.gameState) {
            socket.emit('joinRejected', 'A game is already in progress.');
            return;
        }
        if (room.players.length < 2) {
            socket.emit('joinRejected', 'Need at least 2 players.');
            return;
        }

        let startingDice = parseInt(data && data.startingDice);
        let numFaces = parseInt(data && data.numFaces);

        if (!startingDice || startingDice < 1) { startingDice = 3; }
        if (!numFaces || numFaces < 2) { numFaces = 4; }
        if (startingDice > 10) { startingDice = 10; }
        if (numFaces > 20) { numFaces = 20; }

        let numPlayers = room.players.length;

        let playerDiceCounts = [];
        for (let i = 0; i < numPlayers; i++) {
            playerDiceCounts.push(startingDice);
        }

        room.gameState = {
            playerNames: room.players.map(p => p.name),
            playerDiceCounts: playerDiceCounts,
            numFaces: numFaces,
            currentPlayer: Math.floor(Math.random() * numPlayers),
            hands: rollAllHands(playerDiceCounts, numFaces),
            currentBidQuantity: 0,
            currentBidFace: 0,
            awaitingRoll: false
        };

        console.log('Game started in room', roomCode, 'with players:', room.gameState.playerNames);
        sendStateToAll(roomCode);
    });

    socket.on('raise', (data) => {
        let roomCode = socketRoom.get(socket.id);
        let room = rooms.get(roomCode);
        if (!room || !room.gameState) {
            socket.emit('invalidRaise');
            return;
        }
        let gameState = room.gameState;

        // Never trust the client: the browser disables the button when it isn't
        // your turn, but anyone can re-enable it in dev tools and emit anyway.
        // The server is the only place a rule is actually enforced.
        let senderIndex = room.players.findIndex(p => p.socketId === socket.id);
        if (senderIndex !== gameState.currentPlayer) {
            socket.emit('notYourTurn');
            return;
        }

        let { bidQuantity, bidFace } = data;

        // A bid has to be physically possible: a real face on the die, and never
        // more dice than exist on the table.
        let totalDice = gameState.playerDiceCounts.reduce((sum, n) => sum + n, 0);
        if (!bidFace || bidFace < 1 || bidFace > gameState.numFaces ||
            !bidQuantity || bidQuantity < 1 || bidQuantity > totalDice) {
            socket.emit('invalidRaise');
            return;
        }

        let valid = isValidRaise(
            gameState.currentBidQuantity, gameState.currentBidFace,
            bidQuantity, bidFace
        );

        if (valid) {
            gameState.currentBidQuantity = bidQuantity;
            gameState.currentBidFace = bidFace;
            gameState.currentPlayer = getNextActivePlayer(gameState.currentPlayer, gameState.playerDiceCounts);
            sendStateToAll(roomCode);
        } else {
            socket.emit('invalidRaise');
        }
    });

    socket.on('call', () => {
        let roomCode = socketRoom.get(socket.id);
        let room = rooms.get(roomCode);
        if (!room || !room.gameState) return;
        let gameState = room.gameState;

        let senderIndex = room.players.findIndex(p => p.socketId === socket.id);
        if (senderIndex !== gameState.currentPlayer) {
            socket.emit('notYourTurn');
            return;
        }

        // Can't call a lie that hasn't been told yet.
        if (gameState.currentBidQuantity === 0) {
            socket.emit('notYourTurn');
            return;
        }

        let winner = resolveCall(gameState.hands, gameState.currentBidQuantity, gameState.currentBidFace);

        // Snapshot the hands that were ACTUALLY on the table for this bid.
        // gameState.hands gets overwritten by the reroll below, so capturing it
        // afterwards would reveal the wrong dice entirely.
        let revealedHands = gameState.hands;
        let bidQuantityCalled = gameState.currentBidQuantity;
        let bidFaceCalled = gameState.currentBidFace;

        let callerIndex = gameState.currentPlayer;
        let bidderIndex = getPrevActivePlayer(gameState.currentPlayer, gameState.playerDiceCounts);
        let loserIndex = (winner === "bidder") ? callerIndex : bidderIndex;
        let winnerRoundIndex = (winner === "bidder") ? bidderIndex : callerIndex;

        gameState.playerDiceCounts[loserIndex] = removeDie(gameState.playerDiceCounts[loserIndex]);

        let winnerIndex = checkWinner(gameState.playerDiceCounts);
        if (winnerIndex !== null) {
            io.to(roomCode).emit('gameOver', {
                winnerIndex,
                hands: revealedHands,
                bidQuantity: bidQuantityCalled,
                bidFace: bidFaceCalled,
                loserIndex,
                winnerRoundIndex
            });
            room.gameState = null;
            broadcastLobby(roomCode);
            return;
        }

        gameState.currentPlayer = (gameState.playerDiceCounts[loserIndex] === 0)
            ? getNextActivePlayer(loserIndex, gameState.playerDiceCounts)
            : loserIndex;

        // Don't reroll yet. The round is over, the hands are still on the table,
        // and the next round only starts when someone clicks Roll.
        gameState.awaitingRoll = true;

        io.to(roomCode).emit('roundResult', {
            hands: revealedHands,
            bidQuantity: bidQuantityCalled,
            bidFace: bidFaceCalled,
            loserIndex,
            winnerRoundIndex
        });
        sendStateToAll(roomCode);
    });

    socket.on('rollNextRound', () => {
        let roomCode = socketRoom.get(socket.id);
        let room = rooms.get(roomCode);
        if (!room || !room.gameState || !room.gameState.awaitingRoll) {
            return;
        }
        let gameState = room.gameState;

        gameState.hands = rollAllHands(gameState.playerDiceCounts, gameState.numFaces);
        gameState.currentBidQuantity = 0;
        gameState.currentBidFace = 0;
        gameState.awaitingRoll = false;

        sendStateToAll(roomCode);
    });

    socket.on('disconnect', () => {
        console.log('Player disconnected:', socket.id);

        let roomCode = socketRoom.get(socket.id);
        socketRoom.delete(socket.id);
        if (!roomCode) return;

        let room = rooms.get(roomCode);
        if (!room) return;

        let player = room.players.find(p => p.socketId === socket.id);
        if (!player) return; // e.g. this socket already got replaced by a faster reconnect

        // Don't rip the seat out immediately - give them DISCONNECT_GRACE_MS to
        // come back. Keeping them in `room.players` (just marked disconnected)
        // preserves their index, which mid-game state depends on.
        player.connected = false;
        io.to(roomCode).emit('playerDisconnected', player.name);
        broadcastLobby(roomCode);

        player.disconnectTimer = setTimeout(() => {
            finalizeDisconnect(roomCode, player.token);
        }, DISCONNECT_GRACE_MS);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
