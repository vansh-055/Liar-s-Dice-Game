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

let players = [];      // [{ socketId, name }] - index in this array IS the player index
let gameState = null;  // null until a game is actually running

function broadcastLobby() {
    io.emit('lobbyUpdate', players.map(p => p.name));
}

// Sends each player their OWN view of the game.
// Note what is absent: the full `hands` array. Each browser only ever receives
// its own dice, so opponents' hands are genuinely hidden, not just hidden in the UI.
function sendStateToAll() {
    players.forEach((player, playerIndex) => {
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

io.on('connection', (socket) => {
    console.log('A player connected:', socket.id);

    // send the newcomer the current lobby so they aren't looking at a blank list
    socket.emit('lobbyUpdate', players.map(p => p.name));

    socket.on('join', (name) => {
        if (gameState) {
            socket.emit('joinRejected', 'A game is already in progress.');
            return;
        }
        if (players.some(p => p.socketId === socket.id)) {
            socket.emit('joinRejected', 'You have already joined.');
            return;
        }

        players.push({ socketId: socket.id, name: name });
        console.log('Player joined:', name, socket.id);
        broadcastLobby();
    });

    socket.on('startGame', (data) => {
        if (gameState) {
            socket.emit('joinRejected', 'A game is already in progress.');
            return;
        }
        if (players.length < 2) {
            socket.emit('joinRejected', 'Need at least 2 players.');
            return;
        }

        let startingDice = parseInt(data && data.startingDice);
        let numFaces = parseInt(data && data.numFaces);

        if (!startingDice || startingDice < 1) { startingDice = 3; }
        if (!numFaces || numFaces < 2) { numFaces = 4; }
        if (startingDice > 10) { startingDice = 10; }
        if (numFaces > 20) { numFaces = 20; }

        let numPlayers = players.length;

        let playerDiceCounts = [];
        for (let i = 0; i < numPlayers; i++) {
            playerDiceCounts.push(startingDice);
        }

        gameState = {
            playerNames: players.map(p => p.name),
            playerDiceCounts: playerDiceCounts,
            numFaces: numFaces,
            currentPlayer: Math.floor(Math.random() * numPlayers),
            hands: rollAllHands(playerDiceCounts, numFaces),
            currentBidQuantity: 0,
            currentBidFace: 0,
            awaitingRoll: false
        };

        console.log('Game started with players:', gameState.playerNames);
        sendStateToAll();
    });

    socket.on('raise', (data) => {
        if (!gameState) {
            socket.emit('invalidRaise');
            return;
        }

        // Never trust the client: the browser disables the button when it isn't
        // your turn, but anyone can re-enable it in dev tools and emit anyway.
        // The server is the only place a rule is actually enforced.
        let senderIndex = players.findIndex(p => p.socketId === socket.id);
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
            sendStateToAll();
        } else {
            socket.emit('invalidRaise');
        }
    });

    socket.on('call', () => {
        if (!gameState) {
            return;
        }

        let senderIndex = players.findIndex(p => p.socketId === socket.id);
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
            io.emit('gameOver', {
                winnerIndex,
                hands: revealedHands,
                bidQuantity: bidQuantityCalled,
                bidFace: bidFaceCalled,
                loserIndex,
                winnerRoundIndex
            });
            gameState = null;
            broadcastLobby();
            return;
        }

        gameState.currentPlayer = (gameState.playerDiceCounts[loserIndex] === 0)
            ? getNextActivePlayer(loserIndex, gameState.playerDiceCounts)
            : loserIndex;

        // Don't reroll yet. The round is over, the hands are still on the table,
        // and the next round only starts when someone clicks Roll.
        gameState.awaitingRoll = true;

        io.emit('roundResult', {
            hands: revealedHands,
            bidQuantity: bidQuantityCalled,
            bidFace: bidFaceCalled,
            loserIndex,
            winnerRoundIndex
        });
        sendStateToAll();
    });

    socket.on('rollNextRound', () => {
        if (!gameState || !gameState.awaitingRoll) {
            return;
        }

        gameState.hands = rollAllHands(gameState.playerDiceCounts, gameState.numFaces);
        gameState.currentBidQuantity = 0;
        gameState.currentBidFace = 0;
        gameState.awaitingRoll = false;

        sendStateToAll();
    });

    socket.on('disconnect', () => {
        console.log('Player disconnected:', socket.id);

        let wasInGame = players.some(p => p.socketId === socket.id);
        players = players.filter(p => p.socketId !== socket.id);

        if (gameState && wasInGame) {
            gameState = null;
            io.emit('gameAborted', 'A player disconnected. Game ended.');
        }

        broadcastLobby();
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});