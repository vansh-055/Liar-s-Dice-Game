// Pure game rules. No I/O, no DOM, no sockets - works in Node and the browser.

// maxFace defaults to 4 (Swindlestones uses d4) but any size die works.
function rolldie(maxFace = 20) {
    let min = 1;
    return Math.floor(Math.random() * (maxFace - min + 1)) + min;
}

function rollhand(n, maxFace = 20) {
    let hand = new Array(n);
    for (let i = 0; i < n; i++) {
        hand[i] = rolldie(maxFace);
    }
    return hand;
}

function countFace(hands, num) {
    let count = 0;
    for (let hand of hands) {
        for (let die of hand) {
            if (die == num) {
                count++;
            }
        }
    }
    return count;
}

function rollAllHands(playerDiceCounts, maxFace = 20) {
    let hands = [];
    for (let i = 0; i < playerDiceCounts.length; i++) {
        hands.push(rollhand(playerDiceCounts[i], maxFace));
    }
    return hands;
}

function isBidTrue(hands, bidQuantity, bidFace) {
    let count = countFace(hands, bidFace);
    return count >= bidQuantity;
}

function resolveCall(hands, bidQuantity, bidFace) {
    if (isBidTrue(hands, bidQuantity, bidFace)) {
        return "bidder";
    }
    return "caller";
}

function isValidRaise(prevQuantity, prevFace, newQuantity, newFace) {
    let ruleA = newQuantity > prevQuantity;
    let ruleB = (newQuantity == prevQuantity) && (newFace > prevFace);
    return ruleA || ruleB;
}

function removeDie(size) {
    return size - 1;
}

function checkWinner(playerDiceCounts) {
    let cntzero = 0;
    let total = playerDiceCounts.length;
    for (let dice of playerDiceCounts) {
        if (dice == 0) { cntzero++; }
    }
    if (total - cntzero == 1) {
        for (let i = 0; i < total; i++) {
            if (playerDiceCounts[i] != 0) { return i; }
        }
    }
    return null;
}

// Skips eliminated (0-dice) players when finding whose turn is next.
function getNextActivePlayer(currentIndex, playerDiceCounts) {
    let numPlayers = playerDiceCounts.length;
    let next = (currentIndex + 1) % numPlayers;
    while (playerDiceCounts[next] === 0) {
        next = (next + 1) % numPlayers;
    }
    return next;
}

// Skips eliminated (0-dice) players when walking backward (used to find who made the last bid).
function getPrevActivePlayer(currentIndex, playerDiceCounts) {
    let numPlayers = playerDiceCounts.length;
    let prev = (currentIndex - 1 + numPlayers) % numPlayers;
    while (playerDiceCounts[prev] === 0) {
        prev = (prev - 1 + numPlayers) % numPlayers;
    }
    return prev;
}

// `module` only exists under Node's require(). In the browser this block is skipped,
// so the same file works as both a <script src> and a require()'d module.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        rolldie,
        rollhand,
        countFace,
        rollAllHands,
        isBidTrue,
        resolveCall,
        isValidRaise,
        removeDie,
        checkWinner,
        getNextActivePlayer,
        getPrevActivePlayer
    };
}