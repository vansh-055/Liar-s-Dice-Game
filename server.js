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

// Everything used to be one global game shared by every visitor. Now the server
// hosts many independent games at once, each identified by a short room code.
let rooms = new Map();       // roomCode -> { players: [{socketId,name}], gameState: null|{...} }
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

function broadcastLobby(roomCode) {
    let room = rooms.get(roomCode);
    if (!room) return;
    io.to(roomCode).emit('lobbyUpdate', room.players.map(p => p.name));
}

// Sends each player in a room their OWN view of that room's game.
// Note what is absent: the full `hands` array. Each browser only ever receives
// its own dice, so opponents' hands are genuinely hidden, not just hidden in the UI.
function sendStateToAll(roomCode) {
    let room = rooms.get(roomCode);
    if (!room || !room.gameState) return;
    let gameState = room.gameState;

    room.players.forEach((player, playerIndex) => {
        io.to(player.socketId).emit('stateUpdate', {
            playerNames: gameState.playerNames,
            playerDiceCounts: gameState.playerDiceCounts,
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

io.on('connection', (socket) => {
    console.log('A player connected:', socket.id);

    socket.on('join', (data) => {
        let name = ((data && data.name) || '').toString().trim();
        let requestedCode = ((data && data.roomCode) || '').toString().trim().toUpperCase();

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

        room.players.push({ socketId: socket.id, name: name });
        socketRoom.set(socket.id, roomCode);
        socket.join(roomCode); // Socket.IO's own grouping - lets us io.to(roomCode).emit(...) below

        console.log('Player joined:', name, socket.id, 'room:', roomCode);
        socket.emit('joinedRoom', roomCode);
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

        let wasInGame = room.players.some(p => p.socketId === socket.id);
        room.players = room.players.filter(p => p.socketId !== socket.id);

        if (room.gameState && wasInGame) {
            room.gameState = null;
            io.to(roomCode).emit('gameAborted', 'A player disconnected. Game ended.');
        }

        broadcastLobby(roomCode);
        cleanupRoomIfEmpty(roomCode);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
