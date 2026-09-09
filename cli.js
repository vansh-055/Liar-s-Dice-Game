const readlineSync = require('readline-sync');
const {
    rollAllHands,
    resolveCall,
    isValidRaise,
    removeDie,
    checkWinner,
    getNextActivePlayer,
    getPrevActivePlayer
} = require('./rules.js');

function playGame() {
    let numPlayers = parseInt(readlineSync.question("How many players? "));
    let startingDice = parseInt(readlineSync.question("How many dice per player? "));

    let playerDiceCounts = [];
    for (let i = 0; i < numPlayers; i++) {
        playerDiceCounts.push(startingDice);
    }

    let playerNames = [];
    for (let i = 0; i < numPlayers; i++) {
        let name = readlineSync.question(`Player ${i}, enter your name: `);
        playerNames.push(name);
    }

    let currentPlayer = Math.floor(Math.random() * numPlayers); // who opens the first round

    let gameOver = false;
    while (!gameOver) {                                   // OUTER LOOP — once per ROUND
        let currentBidQuantity = 0;
        let currentBidFace = 0;

        let hands = rollAllHands(playerDiceCounts);
        console.log("Dice rolled.");

        console.log(`${playerNames[currentPlayer]}, make the opening bid.`);
        currentBidQuantity = parseInt(readlineSync.question("Quantity? "));
        currentBidFace = parseInt(readlineSync.question("Face (1-4)? "));
        currentPlayer = getNextActivePlayer(currentPlayer, playerDiceCounts);

        let roundOver = false;
        while (!roundOver) {                               // INNER LOOP — once per TURN
            let choice = readlineSync.question(`${playerNames[currentPlayer]}, type 'raise' or 'call': `);

            if (choice === "call") {
                roundOver = true;
                console.log("Hands revealed:", hands);

                let winner = resolveCall(hands, currentBidQuantity, currentBidFace);
                console.log(`${winner} wins this round!`);

                let callerIndex = currentPlayer;
                let bidderIndex = getPrevActivePlayer(currentPlayer, playerDiceCounts);
                let loserIndex = (winner === "bidder") ? callerIndex : bidderIndex;

                playerDiceCounts[loserIndex] = removeDie(playerDiceCounts[loserIndex]);
                console.log(`${playerNames[loserIndex]} loses a die. Dice remaining:`, playerDiceCounts);

                // Check for a game winner BEFORE picking who starts next round —
                // if the game just ended, there's no "next round" to hand off to.
                let winnerIndex = checkWinner(playerDiceCounts);
                if (winnerIndex !== null) {
                    console.log(`${playerNames[winnerIndex]} wins the game!`);
                    gameOver = true;
                } else if (playerDiceCounts[loserIndex] === 0) {
                    // loser was just eliminated — hand the turn to the next active player instead
                    currentPlayer = getNextActivePlayer(loserIndex, playerDiceCounts);
                } else {
                    currentPlayer = loserIndex; // loser starts next round (house rule)
                }
            } else {
                let bidface = parseInt(readlineSync.question("face? "));
                let bidquantity = parseInt(readlineSync.question("quantity? "));
                let valid = isValidRaise(currentBidQuantity, currentBidFace, bidquantity, bidface);
                if (valid) {
                    currentBidFace = bidface;
                    currentBidQuantity = bidquantity;
                    currentPlayer = getNextActivePlayer(currentPlayer, playerDiceCounts);
                } else {
                    console.log("Invalid raise, try again.");
                }
            }
        }
    }
}

playGame();
