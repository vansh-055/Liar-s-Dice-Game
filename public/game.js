const socket = io();

let state = null;
let lastHandKey = null; // used to detect an actual new roll vs. a re-render
let myName = null;      // the name we joined with - needed again if we save a session

// True while a 'join' we sent was the silent auto-rejoin-on-load attempt, not
// something the user clicked. Lets joinRejected tell the two apart so a stale
// session from a past visit doesn't surface a confusing error on an empty page.
let autoRejoinInFlight = false;

// ---------- reconnect session ----------
// Survives a refresh/network blip: on reconnect we hand the server this token
// so it can recognize "this is seat 2 coming back", not a new stranger. Wrapped
// in try/catch since localStorage can throw in private-browsing contexts.

function saveSession(roomCode, token, name) {
    try {
        localStorage.setItem("liarsDiceSession", JSON.stringify({ roomCode, token, name }));
    } catch (e) { /* no persistence available - reconnect just won't be seamless */ }
}
function loadSession() {
    try {
        let raw = localStorage.getItem("liarsDiceSession");
        return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
}
function clearSession() {
    try { localStorage.removeItem("liarsDiceSession"); } catch (e) { /* ignore */ }
}

// ---------- die rendering ----------

function createDieElement(value, maxFace, opts = {}) {
    let die = document.createElement("div");
    die.className = "die" + (opts.small ? " small" : "");
    die.dataset.max = maxFace;
    die.textContent = value;
    if (opts.animate) {
        die.classList.add("rolling");
        die.style.animationDelay = `${(opts.index || 0) * 60}ms`;
    }
    return die;
}

function renderDiceRow(container, hand, maxFace, opts = {}) {
    container.innerHTML = "";
    hand.forEach((value, i) => {
        container.appendChild(createDieElement(value, maxFace, { ...opts, index: i }));
    });
}

// ---------- display helpers ----------

function logMessage(node) {
    let log = document.getElementById("log");
    log.prepend(node);
}

function showWarning(msg) {
    document.getElementById("warning").textContent = msg;
}

// Small plain-text log entries (connect/disconnect notices), as opposed to the
// dice-illustrated reveal cards built by buildRevealBlock() further down.
function logText(msg) {
    let p = document.createElement("p");
    p.style.color = "var(--text-dim)";
    p.style.fontSize = "0.85rem";
    p.style.margin = "0";
    p.textContent = msg;
    logMessage(p);
}

function render() {
    document.getElementById("warning").textContent = "";

    let isMyTurn = state.currentPlayer === state.myIndex;

    if (state.awaitingRoll) {
        document.getElementById("turnInfo").textContent =
            `Round over. ${state.playerNames[state.currentPlayer]} starts the next one.`;
    } else {
        document.getElementById("turnInfo").textContent = isMyTurn
            ? "Your turn!"
            : `${state.playerNames[state.currentPlayer]}'s turn.`;
    }

    document.getElementById("diceCounts").textContent =
        "Dice remaining - " + state.playerNames
            .map((name, i) => {
                let away = state.playerConnected && !state.playerConnected[i];
                return `${name}: ${state.playerDiceCounts[i]}${away ? " (disconnected)" : ""}`;
            })
            .join(", ");

    if (state.currentBidQuantity === 0) {
        document.getElementById("bidInfo").textContent = state.awaitingRoll
            ? "Roll to begin the next round."
            : "No bid yet - make the opening bid.";
    } else {
        document.getElementById("bidInfo").textContent =
            `Current bid: ${state.currentBidQuantity} of face ${state.currentBidFace}`;
    }

    // Only draw a fresh "rolling in" animation when the hand actually changed
    // (a new round), not on every re-render (e.g. after someone else raises).
    let handKey = JSON.stringify(state.myHand);
    let isNewRoll = handKey !== lastHandKey;
    lastHandKey = handKey;

    let diceRow = document.getElementById("myDiceRow");
    renderDiceRow(diceRow, state.myHand, state.numFaces, { animate: isNewRoll });

    let faceInput = document.getElementById("bidFaceInput");
    faceInput.max = state.numFaces;
    faceInput.placeholder = `face (1-${state.numFaces})`;

    document.getElementById("rollBtn").style.display = state.awaitingRoll ? "inline-block" : "none";

    document.getElementById("raiseBtn").disabled = state.awaitingRoll || !isMyTurn;
    document.getElementById("callBtn").disabled =
        state.awaitingRoll || !isMyTurn || state.currentBidQuantity === 0;
}

// ---------- actions sent to the server ----------

function handleJoin() {
    let name = document.getElementById("nameInput").value.trim();
    let roomCode = document.getElementById("roomCodeInput").value.trim().toUpperCase();
    if (!name) {
        showWarning("Enter a name first.");
        return;
    }
    myName = name;
    socket.emit('join', { name, roomCode });
}

function startGame() {
    let startingDice = parseInt(document.getElementById("startingDiceInput").value);
    let numFaces = parseInt(document.getElementById("numFacesInput").value);
    socket.emit('startGame', { startingDice, numFaces });
}

function handleRaise() {
    let bidQuantity = parseInt(document.getElementById("bidQuantityInput").value);
    let bidFace = parseInt(document.getElementById("bidFaceInput").value);
    socket.emit('raise', { bidQuantity, bidFace });
}

function handleCall() {
    socket.emit('call');
}

function handleRoll() {
    socket.emit('rollNextRound');
}

// ---------- messages coming from the server ----------

socket.on('connect', () => {
    console.log('Connected to server with id:', socket.id);

    // A fresh page load (refresh, or reopening the tab) still has a socket with
    // no idea who we were. If we remember a room+token, try to slide back into
    // our old seat before the user has to do anything.
    let session = loadSession();
    if (session && session.roomCode && session.token) {
        myName = session.name;
        autoRejoinInFlight = true;
        socket.emit('join', session);
    }
});

socket.on('lobbyUpdate', (players) => {
    document.getElementById("lobbyStatus").textContent =
        `Players joined (${players.length}): ` +
        players.map(p => p.connected ? p.name : `${p.name} (disconnected)`).join(", ");
    document.getElementById("startBtn").style.display =
        players.length >= 2 ? "inline-block" : "none";
});

socket.on('joinRejected', ({ message, roomNotFound }) => {
    // A missing room isn't the player's fault - it's just gone (ended, server
    // restarted, link went stale). There's nothing for them to fix, so don't
    // blame them with an error; just quietly reset to a fresh lobby. Same goes
    // for any rejection of a silent auto-rejoin attempt - the user didn't do
    // anything just now, so there's nothing for them to be warned about.
    if (!roomNotFound && !autoRejoinInFlight) {
        showWarning(message);
    }
    autoRejoinInFlight = false;
    clearSession(); // whatever we had stored didn't work - don't keep retrying it
});

socket.on('joinedRoom', ({ roomCode, token }) => {
    autoRejoinInFlight = false;
    saveSession(roomCode, token, myName);

    let display = document.getElementById("roomCodeDisplay");
    display.style.display = "block";
    display.innerHTML = `Room code: <b>${roomCode}</b> - share this with friends so they can join.`;
    document.getElementById("joinBtn").disabled = true;
    document.getElementById("nameInput").disabled = true;
    document.getElementById("roomCodeInput").disabled = true;
});

socket.on('playerDisconnected', (name) => {
    logText(`⚠️ ${name} disconnected - waiting for them to reconnect...`);
});

socket.on('playerReconnected', (name) => {
    logText(`✅ ${name} reconnected.`);
});

socket.on('stateUpdate', (newState) => {
    state = newState;
    document.getElementById("lobby").style.display = "none";
    document.getElementById("gameArea").style.display = "block";
    render();
});

socket.on('invalidRaise', () => {
    showWarning("Invalid raise, try again.");
});

socket.on('notYourTurn', () => {
    showWarning("That move isn't allowed right now.");
});

// Appends a mix of plain strings and [tagName, text] pairs as text nodes/elements,
// so player names (user-controlled) never pass through innerHTML.
function appendRichText(container, parts) {
    for (let part of parts) {
        if (Array.isArray(part)) {
            let [tag, text] = part;
            let el = document.createElement(tag);
            el.textContent = text;
            container.appendChild(el);
        } else {
            container.appendChild(document.createTextNode(part));
        }
    }
}

// Builds one reveal card: every player's row of dice, plus a one-line summary.
function buildRevealBlock(data, title) {
    let block = document.createElement("div");
    block.className = "reveal-block";

    let heading = document.createElement("div");
    heading.className = "reveal-name";
    heading.textContent = title;
    block.appendChild(heading);

    state.playerNames.forEach((name, i) => {
        let row = document.createElement("div");
        row.style.display = "flex";
        row.style.alignItems = "center";
        row.style.gap = "0.5rem";
        row.style.marginBottom = "0.4rem";

        let label = document.createElement("span");
        label.textContent = name + (i === state.myIndex ? " (you)" : "");
        label.style.width = "5.5rem";
        label.style.flexShrink = "0";
        label.style.fontSize = "0.85rem";
        label.style.color = "var(--text-dim)";
        row.appendChild(label);

        let diceRow = document.createElement("div");
        diceRow.className = "dice-row";
        diceRow.style.marginBottom = "0";
        renderDiceRow(diceRow, data.hands[i], state.numFaces, { small: true });
        row.appendChild(diceRow);

        block.appendChild(row);
    });

    // Abandonment-triggered game overs have a final hand snapshot but no bid to
    // report - nobody called anything, a seat just never came back from a disconnect.
    if (data.bidQuantity) {
        let summary = document.createElement("div");
        summary.className = "reveal-summary";
        appendRichText(summary, [
            "Bid was ", ["b", `${data.bidQuantity} of face ${data.bidFace}`], ". ",
            ["b", state.playerNames[data.winnerRoundIndex]], " wins the round, ",
            ["b", state.playerNames[data.loserIndex]], " loses a die."
        ]);
        block.appendChild(summary);
    }

    return block;
}

socket.on('roundResult', (data) => {
    logMessage(buildRevealBlock(data, "Hands Revealed"));
});

socket.on('gameOver', (data) => {
    let block = buildRevealBlock(data, "Final Reveal");
    let winnerLine = document.createElement("div");
    winnerLine.className = "reveal-summary";
    appendRichText(winnerLine, ["🏆 ", ["b", state.playerNames[data.winnerIndex]], " wins the game!"]);
    block.appendChild(winnerLine);
    logMessage(block);

    // The log entry above is easy to miss - also update the prominent status
    // text so it doesn't keep showing a stale "X's turn" from before the game ended.
    let turnInfo = document.getElementById("turnInfo");
    turnInfo.textContent = "";
    appendRichText(turnInfo, ["🏆 ", ["b", state.playerNames[data.winnerIndex]], " wins the game!"]);
    document.getElementById("bidInfo").textContent = "Game over - see the final reveal below.";

    document.getElementById("raiseBtn").disabled = true;
    document.getElementById("callBtn").disabled = true;
    document.getElementById("backToLobbyBtn").style.display = "inline-block";
});

document.getElementById("backToLobbyBtn").addEventListener("click", () => {
    document.getElementById("backToLobbyBtn").style.display = "none";
    document.getElementById("gameArea").style.display = "none";
    document.getElementById("lobby").style.display = "block";
});

socket.on('playerAborted', (msg) => {
    logText(`❌ ${msg}`);
});

// ---------- wire up buttons (once, at load) ----------

function openRules() {
    document.getElementById("rulesModal").style.display = "flex";
}
function closeRules() {
    document.getElementById("rulesModal").style.display = "none";
}

document.getElementById("rulesBtn").addEventListener("click", openRules);
document.getElementById("rulesCloseBtn").addEventListener("click", closeRules);
document.getElementById("rulesCloseBtn2").addEventListener("click", closeRules);
document.getElementById("rulesModal").addEventListener("click", (e) => {
    if (e.target.id === "rulesModal") closeRules(); // click on the dark backdrop, not the panel itself
});
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeRules();
});

document.getElementById("joinBtn").addEventListener("click", handleJoin);
document.getElementById("startBtn").addEventListener("click", startGame);
document.getElementById("raiseBtn").addEventListener("click", handleRaise);
document.getElementById("callBtn").addEventListener("click", handleCall);
document.getElementById("rollBtn").addEventListener("click", handleRoll);
