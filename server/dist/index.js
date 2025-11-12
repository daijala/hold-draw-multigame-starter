import express from "express";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";
import os from "os";
import open from "open";
import fs from "fs";
const games = new Map();
// ---------------------------
// Persistence + Cleanup
// ---------------------------
const STATE_FILE = "./games.json";
const STALE_MINUTES = 60; // remove games older than 1 hour
const STRICT_WAIT_FOR_ALL = true; // ✅ require every non-left player to submit, even if disconnected
const MIN_SUBMIT_MS = 500; // 👈 reject submits sooner than this after (re)appearing
// Throttle control for disk writes
let lastSaveTime = 0;
let pendingSave = false;
const SAVE_INTERVAL_MS = 2000; // at most once every 2s
function saveGamesToDisk(force = false) {
    const now = Date.now();
    const elapsed = now - lastSaveTime;
    // Prevent frequent writes
    if (!force && elapsed < SAVE_INTERVAL_MS) {
        if (!pendingSave) {
            pendingSave = true;
            setTimeout(() => {
                pendingSave = false;
                saveGamesToDisk(true);
            }, SAVE_INTERVAL_MS);
        }
        return;
    }
    try {
        lastSaveTime = now;
        const arr = Array.from(games.values());
        if (arr.length === 0)
            return;
        // Write backup first
        if (fs.existsSync(STATE_FILE)) {
            fs.copyFileSync(STATE_FILE, STATE_FILE + ".bak");
        }
        fs.writeFileSync(STATE_FILE, JSON.stringify(arr, null, 2));
        // console.log(`💾 Saved ${arr.length} games to disk`);
    }
    catch (err) {
        console.error("❌ Failed to save games:", err);
    }
}
function loadGamesFromDisk() {
    try {
        if (!fs.existsSync(STATE_FILE))
            return;
        const data = fs.readFileSync(STATE_FILE, "utf8");
        const arr = JSON.parse(data);
        for (const g of arr) {
            // Defensive resets
            g.players.forEach(p => p.connected = false); // avoid ghost sessions
            g.awaiting = g.awaiting && g.awaiting.length > 0
                ? g.awaiting
                : g.players.map(p => p.name); // rebuild if missing
            games.set(g.gameId, g);
        }
        console.log(`♻️ Restored ${games.size} games from disk`);
    }
    catch (err) {
        console.error("⚠️ Failed to load saved games:", err);
    }
}
function cleanupStaleGames() {
    const now = Date.now();
    const removedGames = [];
    for (const [id, gs] of games) {
        const lastTime = gs.endedAt ?? gs.startedAt ?? now;
        const ageMinutes = (now - lastTime) / 60000;
        const shouldRemove = gs.endedAt
            ? ageMinutes > STALE_MINUTES
            : !gs.endedAt && ageMinutes > STALE_MINUTES * 2; // inactive lobby safety
        if (shouldRemove) {
            const ageDesc = `${Math.round(ageMinutes)} min ago`;
            removedGames.push({
                id,
                host: gs.hostName,
                round: gs.round,
                age: ageDesc,
            });
            games.delete(id);
        }
    }
    if (removedGames.length > 0) {
        console.log(`🧹 Cleaned up ${removedGames.length} stale game(s):`);
        for (const g of removedGames) {
            console.log(`   - ${g.id} (host: ${g.host}, round: ${g.round}, last active ${g.age})`);
        }
        saveGamesToDisk(true);
    }
}
// Auto-save + cleanup schedule
setInterval(() => saveGamesToDisk(), 10000);
setInterval(cleanupStaleGames, 60000); // check every minute
loadGamesFromDisk();
// ---------------------------
// Auto-reload when games.json changes on disk (debounced + safe merge)
// ---------------------------
import crypto from "crypto";
let reloadTimer = null;
let lastFileHash = "";
function computeFileHash(path) {
    try {
        const data = fs.readFileSync(path, "utf8");
        return crypto.createHash("md5").update(data).digest("hex");
    }
    catch {
        return "";
    }
}
function mergeGamesFromDisk(data) {
    const arr = JSON.parse(data);
    let updated = 0;
    for (const g of arr) {
        g.players.forEach((p) => (p.connected = false)); // avoid ghost sessions
        g.awaiting = g.awaiting?.length ? g.awaiting : g.players.map((p) => p.name);
        const existing = games.get(g.gameId);
        if (!existing) {
            games.set(g.gameId, g);
            updated++;
        }
        else {
            // merge but keep live connected states if any
            existing.players = g.players;
            existing.round = g.round;
            existing.awaiting = g.awaiting;
            existing.roundSeed = g.roundSeed;
            existing.nextRoundSeed = g.nextRoundSeed;
            existing.maxRounds = g.maxRounds;
            existing.endedAt = g.endedAt;
            updated++;
        }
    }
    console.log(`♻️ Merged ${updated} game(s) from disk`);
}
// --- Replace your fs.watchFile section with this ---
if (fs.existsSync(STATE_FILE)) {
    fs.watchFile(STATE_FILE, { interval: 3000 }, (curr, prev) => {
        if (curr.mtimeMs <= prev.mtimeMs)
            return; // no real change
        const now = Date.now();
        // Don't reload if we just wrote recently
        if (now - lastSaveTime < 5000)
            return;
        console.log(`📂 Detected external change to ${STATE_FILE}, verifying merge safety…`);
        try {
            const data = fs.readFileSync(STATE_FILE, "utf8");
            const arr = JSON.parse(data);
            let merged = 0;
            for (const g of arr) {
                // Skip if game already newer in memory
                const live = games.get(g.gameId);
                if (live && (live.startedAt ?? 0) > (g.startedAt ?? 0))
                    continue;
                g.players.forEach(p => (p.connected = false));
                g.awaiting = g.awaiting?.length ? g.awaiting : g.players.map(p => p.name);
                games.set(g.gameId, g);
                merged++;
            }
            if (merged > 0)
                console.log(`♻️ Merged ${merged} newer game(s) from disk safely`);
        }
        catch (err) {
            console.error("⚠️ Safe merge failed:", err);
        }
    });
}
// ---------------------------
// Helpers
// ---------------------------
function newGame(gameId, hostName, maxRounds = 10) {
    const gs = {
        gameId,
        hostName,
        players: [],
        maxRounds,
        round: 0,
        awaiting: [],
        paused: false, // 👈 default
        roundStartedAt: undefined,
    };
    games.set(gameId, gs);
    saveGamesToDisk();
    return gs;
}
function getGame(gameId) {
    return games.get(gameId);
}
function findPlayer(gs, playerName) {
    if (!playerName)
        return undefined; // 👈 safeguard
    return gs.players.find((p) => p.name.toLowerCase() === playerName.toLowerCase());
}
function ensureAwaiting(gs) {
    // 🔒 Terminal game: never rebuild
    if (gs.endedAt || gs.round > gs.maxRounds) {
        gs.awaiting = [];
        gs.paused = false;
        return;
    }
    // Who is actually connected in this room?
    const roomSockets = io.sockets.adapter.rooms.get(gs.gameId) ?? new Set();
    const activeNames = new Set(Array.from(roomSockets)
        .map((sid) => io.sockets.sockets.get(sid)?.data?.playerName?.toLowerCase())
        .filter(Boolean));
    // Refresh connected flags for UI
    for (const p of gs.players) {
        p.connected = activeNames.has(p.name.toLowerCase());
    }
    // ✅ STRICT: Await EVERY non-left player who still owes this round (regardless of connection)
    const needAll = gs.players
        .filter((p) => !p.hasLeft && p.lastSubmitRound < gs.round)
        .map((p) => p.name);
    gs.awaiting = STRICT_WAIT_FOR_ALL ? needAll : (
    // non-strict fallback (connected-only)
    gs.players.filter((p) => !p.hasLeft && p.connected && p.lastSubmitRound < gs.round)
        .map((p) => p.name));
    // Show paused banner if anyone required is disconnected
    const someoneRequiredDisconnected = gs.players.some((p) => !p.hasLeft && p.lastSubmitRound < gs.round && !p.connected);
    gs.paused = STRICT_WAIT_FOR_ALL ? someoneRequiredDisconnected
        : gs.players.some((p) => !p.hasLeft && !p.connected);
    console.log(`🧩 ensureAwaiting(): round=${gs.round} → awaiting=[${gs.awaiting.join(", ")}]`);
}
// ---------------------------
// Round Advancement Helper
// ---------------------------
function advanceRound(gs) {
    if (gs.endedAt)
        return; // already done
    // 🧠 Refresh player connection states BEFORE advancing
    const roomSockets = io.sockets.adapter.rooms.get(gs.gameId) ?? new Set();
    const activeNames = new Set(Array.from(roomSockets)
        .map(sid => io.sockets.sockets.get(sid)?.data?.playerName?.toLowerCase())
        .filter(Boolean));
    for (const p of gs.players) {
        p.connected = activeNames.has(p.name.toLowerCase());
    }
    // 🏁 End-of-game check
    if (gs.round >= gs.maxRounds) {
        gs.endedAt = Date.now();
        gs.round = gs.maxRounds + 1;
        gs.awaiting = []; // 🔒 freeze — no one is “awaiting” in Game Over
        console.log(`🏁 Game ${gs.gameId} completed all ${gs.maxRounds} rounds`);
        safeBroadcast(io, gs, { roundComplete: gs.maxRounds });
        saveGamesToDisk(true);
        return;
    }
    // 🔁 Move to next round
    gs.round += 1;
    gs.roundSeed = gs.nextRoundSeed ?? Math.floor(Math.random() * 1000000);
    gs.nextRoundSeed = Math.floor(Math.random() * 1000000);
    gs.roundStartedAt = Date.now();
    for (const p of gs.players) {
        // If they’re connected at round start, they’re considered to have “seen” the round
        p.seenThisRound = !!p.connected;
        // Small grace before we accept a submit (prevents instant resume->submit)
        p.allowSubmitAfter = Date.now() + MIN_SUBMIT_MS;
    }
    // ✅ Only include connected players in awaiting
    gs.awaiting = STRICT_WAIT_FOR_ALL
        ? gs.players.filter((p) => !p.hasLeft).map((p) => p.name)
        : gs.players.filter((p) => p.connected && !p.hasLeft).map((p) => p.name);
    // ✅ Rebuild awaiting list with updated connection states
    ensureAwaiting(gs);
    console.log(`🔁 Advancing to round ${gs.round}`);
    safeBroadcast(io, gs);
    saveGamesToDisk(true);
}
// ---------------------------
// Broadcast Helpers
// ---------------------------
function broadcast(io, gs, opts = {}) {
    if (gs.round === 0 && !opts.force) {
        console.log(`🚫 Skipping broadcast for ${gs.gameId} (no active round yet)`);
        return;
    }
    const totals = {};
    const submissions = {};
    for (const p of gs.players) {
        const sum = Object.values(p.scores).reduce((a, b) => a + b, 0);
        totals[p.name] = sum;
        submissions[p.name] = p.lastSubmitRound >= gs.round;
    }
    const started = gs.round > 0 && gs.round <= gs.maxRounds;
    const ended = gs.round > gs.maxRounds;
    const timestamp = Date.now();
    const message = ended
        ? "🏁 Game over"
        : (gs.awaiting.length === 0 ? "All players submitted" : `Awaiting: ${gs.awaiting.join(", ")}`);
    const enhancedState = {
        gameId: gs.gameId,
        host: gs.hostName,
        hostName: gs.hostName,
        players: gs.players.map((p) => ({
            name: p.name,
            connected: p.connected,
            scores: p.scores,
            lastSubmitRound: p.lastSubmitRound,
        })),
        totals,
        round: gs.round,
        roundSeed: gs.roundSeed ?? null,
        nextRoundSeed: gs.nextRoundSeed ?? null,
        maxRounds: gs.maxRounds,
        started,
        ended,
        message,
        submissions,
        playerCount: gs.players.length,
        timestamp,
        roundComplete: opts.roundComplete ?? null,
        nextRound: !ended ? gs.round + 1 : null,
        paused: gs.paused ?? false,
        roundStarted: opts.force === true && gs.round > 0,
    };
    console.log(`🛰️ [Server] Round ${gs.round}  roundComplete=${opts.roundComplete ?? "nil"}  Totals: ${JSON.stringify(totals)}`);
    if (gs.paused) {
        console.log(`⏸️ Game ${gs.gameId} paused — waiting for disconnected players`);
    }
    io.to(gs.gameId).emit("stateUpdate", enhancedState);
}
// --- throttled wrapper ---
const broadcastCooldown = new Map();
const callCounts = {};
setInterval(() => {
    const counts = Object.entries(callCounts)
        .map(([id, n]) => `${id}:${n}`)
        .join("  ");
    if (counts)
        console.log(`📊 Broadcast counts: ${counts}`);
    for (const k of Object.keys(callCounts))
        delete callCounts[k];
}, 3000);
function safeBroadcast(io, gs, opts = {}) {
    callCounts[gs.gameId] = (callCounts[gs.gameId] ?? 0) + 1;
    clearTimeout(broadcastCooldown.get(gs.gameId));
    const t = setTimeout(() => {
        broadcast(io, gs, opts);
        broadcastCooldown.delete(gs.gameId);
    }, 150);
    broadcastCooldown.set(gs.gameId, t);
    saveGamesToDisk(); // ✅ persist every broadcast
}
// ---------------------------
// Express Setup
// ---------------------------
const app = express();
app.use(cors());
app.use(express.json());
app.get("/health", (_req, res) => res.json({ ok: true, games: games.size }));
app.get("/stats", (_req, res) => {
    const now = Date.now();
    const stats = {
        uptimeMinutes: Math.round(process.uptime() / 60),
        memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
        activeGames: games.size,
        games: Array.from(games.values()).map((gs) => ({
            id: gs.gameId,
            host: gs.hostName,
            players: gs.players.length,
            round: gs.round,
            started: gs.startedAt
                ? `${Math.round((now - gs.startedAt) / 60000)} min ago`
                : null,
            ended: gs.endedAt
                ? `${Math.round((now - gs.endedAt) / 60000)} min ago`
                : null,
            awaiting: gs.awaiting,
            connected: gs.players.map((p) => ({ name: p.name, connected: p.connected })),
        })),
    };
    res.json(stats);
});
// ---------------------------
// Manual Cleanup Endpoint
// ---------------------------
app.get("/cleanup", (req, res) => {
    const force = req.query.all === "true"; // e.g. /cleanup?all=true
    const now = Date.now();
    const removedGames = [];
    for (const [id, gs] of games) {
        const lastTime = gs.endedAt ?? gs.startedAt ?? now;
        const ageMinutes = (now - lastTime) / 60000;
        const shouldRemove = force
            ? true
            : gs.endedAt
                ? ageMinutes > STALE_MINUTES
                : !gs.endedAt && ageMinutes > STALE_MINUTES * 2;
        if (shouldRemove) {
            const ageDesc = `${Math.round(ageMinutes)} min ago`;
            removedGames.push({
                id,
                host: gs.hostName,
                round: gs.round,
                age: ageDesc,
            });
            games.delete(id);
        }
    }
    if (removedGames.length > 0) {
        const label = force ? "⚠️ Forced" : "🧹";
        console.log(`${label} cleanup removed ${removedGames.length} game(s):`);
        for (const g of removedGames) {
            console.log(`   - ${g.id} (host: ${g.host}, round: ${g.round}, last active ${g.age})`);
        }
        saveGamesToDisk();
        // 🛰️ Broadcast "Server Reset" notice if forced cleanup
        if (force) {
            io.emit("stateUpdate", {
                gameId: "SERVER_RESET",
                message: "⚠️ Server reset — all games cleared by admin",
                timestamp: Date.now(),
                players: [],
                totals: {},
                round: 0,
                maxRounds: 0,
                started: false,
                ended: true,
                host: "",
                submissions: {},
                playerCount: 0,
                roundComplete: null,
                nextRound: null,
            });
            console.log("📣 Broadcasted server reset notice to all clients.");
        }
    }
    else {
        console.log(force ? "⚠️ Forced cleanup found no games to remove." : "🧹 No stale games found.");
    }
    res.json({
        mode: force ? "forced" : "normal",
        removed: removedGames.length,
        details: removedGames,
        remaining: Array.from(games.keys()),
    });
});
// ---------------------------
// Socket.IO Logic
// ---------------------------
// const server = http.createServer(app);
// const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });
const server = http.createServer(app);
// ✅ Replit / shared-host tuned Socket.IO config
const io = new Server(server, {
    cors: { origin: "*" }, // Allow all for testing
    pingInterval: 10000, // Send a ping every 10s (default is 25s)
    pingTimeout: 15000, // If no pong after 15s, drop & reconnect
    connectTimeout: 5000, // Wait max 5s for initial connection
    maxHttpBufferSize: 1e6, // Avoid big payload stalls
    allowEIO3: true, // Support older clients if needed
    perMessageDeflate: {
        threshold: 2048, // Compress larger packets only
    },
});
io.on("connection", (socket) => {
    const fail = (code, message) => socket.emit("error", { code, message });
    // CREATE
    socket.on("createGame", (payload, ack) => {
        const id = (payload.gameId && payload.gameId.trim()) ||
            `game_${Math.random().toString(36).slice(2, 8)}`;
        // 🔥 If an old game with the same ID exists, clear it first
        if (games.has(id)) {
            const existing = games.get(id);
            console.log(`⚠️ Overwriting existing game ${id} (round=${existing.round}, host=${existing.hostName})`);
            games.delete(id);
        }
        // 🆕 Create a brand new empty lobby game (round = 0)
        const gs = newGame(id, payload.hostName);
        gs.round = 0; // ✅ Ensure it's lobby phase, not active
        gs.startedAt = undefined;
        gs.endedAt = undefined;
        // Add host as the first player
        gs.players.push({
            name: payload.hostName,
            connected: true,
            lastSubmitRound: 0,
            scores: {},
        });
        // Only host is present, so awaiting = just them
        gs.awaiting = gs.players.map((p) => p.name);
        socket.data.playerName = payload.hostName;
        socket.data.gameId = id;
        socket.join(id);
        console.log(`🌱 Created new game ${id} hosted by ${payload.hostName} (lobby mode)`);
        // 🔄 Send lobby broadcast — round=0 means “waiting for host to start”
        safeBroadcast(io, gs, { force: true });
        saveGamesToDisk(true);
        // ✅ Respond to client’s ack
        if (ack)
            ack({ ok: true, gameId: id });
    });
    // JOIN
    socket.on("joinGame", (payload) => {
        let gs = getGame(payload.gameId);
        if (!gs) {
            gs = newGame(payload.gameId, payload.playerName);
            console.log(`🆕 Auto-created game ${payload.gameId} for ${payload.playerName}`);
        }
        let p = findPlayer(gs, payload.playerName);
        if (!p) {
            p = { name: payload.playerName, connected: true, lastSubmitRound: 0, scores: {} };
            gs.players.push(p);
        }
        else {
            p.connected = true;
            p.hasLeft = false; // ✅ rejoined player is now active again
        }
        gs.awaiting = gs.players.map((pl) => pl.name); // ✅ ensure awaiting always populated
        socket.data.playerName = payload.playerName;
        socket.data.gameId = payload.gameId;
        socket.join(gs.gameId);
        if (gs.round > 0 && !gs.endedAt) {
            const p2 = findPlayer(gs, payload.playerName);
            if (p2) {
                p2.seenThisRound = true;
                p2.allowSubmitAfter = Date.now() + MIN_SUBMIT_MS;
            }
        }
        ensureAwaiting(gs);
        // 🧠 Send latest state directly to the reconnected socket
        safeBroadcast(io, gs, { force: true });
        io.to(socket.id).emit("stateUpdate", {
            ...gs,
            message: "🔄 Synced latest state after reconnection",
        });
        if (gs.paused && gs.players.every(p => p.connected || p.hasLeft)) {
            gs.paused = false;
            console.log(`▶️ Game ${gs.gameId} resumed — all players reconnected`);
            safeBroadcast(io, gs, { force: true });
        }
    });
    // ---------------------------
    // LEAVE GAME
    // ---------------------------
    socket.on("leaveGame", (payload) => {
        const gs = getGame(payload.gameId);
        if (!gs)
            return fail("NOT_FOUND", `Game ${payload.gameId} not found.`);
        const p = findPlayer(gs, payload.playerName);
        if (p) {
            p.connected = false;
            p.hasLeft = true;
            console.log(`👋 ${p.name} left game ${payload.gameId}`);
        }
        else {
            console.warn(`⚠️ leaveGame: player ${payload.playerName} not found in ${payload.gameId}`);
        }
        socket.leave(payload.gameId);
        ensureAwaiting(gs);
        // 🧩 If the host left → end game gracefully
        if (p && gs.hostName.toLowerCase() === p.name.toLowerCase()) {
            console.log(`⚠️ Host ${p.name} left game ${gs.gameId} — ending match`);
            gs.endedAt = Date.now();
            io.to(gs.gameId).emit("stateUpdate", {
                gameId: "HOST_LEFT",
                message: `⚠️ Host ${p.name} left — game ended`,
                timestamp: Date.now(),
                players: gs.players,
                totals: {},
                round: gs.round,
                maxRounds: gs.maxRounds,
                ended: true,
                started: true,
            });
            saveGamesToDisk(true);
            return;
        }
        // ✅ If this leave caused awaiting=[] and the round was active, finalize it automatically
        if (gs.awaiting.length === 0 && gs.round > 0 && !gs.endedAt) {
            console.log(`🏁 Round ${gs.round} completed automatically after ${p?.name ?? "a player"} left`);
            safeBroadcast(io, gs, { roundComplete: gs.round });
            setTimeout(() => {
                const live = games.get(gs.gameId);
                if (!live || live.round !== gs.round || live.endedAt)
                    return;
                advanceRound(live);
            }, 2500);
        }
        else {
            // Normal case: others still active
            safeBroadcast(io, gs, { force: true });
            saveGamesToDisk(true);
        }
        // 🧹 Remove game if empty
        if (gs.players.every((p) => !p.connected && p.hasLeft)) {
            console.log(`🗑️ All players left ${payload.gameId}, removing game`);
            games.delete(payload.gameId);
        }
    });
    // ---------------------------
    // START GAME
    // ---------------------------
    socket.on("startGame", (payload, ack) => {
        const targetId = (payload && payload.gameId) || socket.data.gameId; // 👈 fallback
        const gs = getGame(targetId);
        if (!gs) {
            if (ack)
                ack({ ok: false, error: `NOT_FOUND: ${String(targetId)}` });
            return;
        }
        if (gs.round > 0 && !gs.endedAt) {
            console.warn(`⚠️ startGame ignored — ${gs.gameId} already running (round=${gs.round})`);
            if (ack)
                ack({ ok: true, round: gs.round, alreadyRunning: true });
            return;
        }
        // 🧩 Defensive: find all currently connected sockets in this room
        const roomSockets = io.sockets.adapter.rooms.get(gs.gameId) ?? new Set();
        // 🧹 Reset all player state cleanly
        for (const p of gs.players) {
            p.scores = {};
            p.lastSubmitRound = 0;
            p.hasLeft = false; // ✅ reset for fresh match
            // Only mark as connected if their socket is actually present
            const isConnected = Array.from(roomSockets).some((sid) => {
                const sock = io.sockets.sockets.get(sid);
                return sock?.data?.playerName?.toLowerCase() === p.name.toLowerCase();
            });
            p.connected = isConnected;
        }
        // 💫 Start a brand new match
        gs.endedAt = undefined;
        gs.round = 1;
        gs.roundSeed = Math.floor(Math.random() * 1000000);
        gs.nextRoundSeed = Math.floor(Math.random() * 1000000);
        gs.startedAt = Date.now();
        gs.roundStartedAt = Date.now();
        for (const p of gs.players) {
            // If they’re connected at round start, they’re considered to have “seen” the round
            p.seenThisRound = !!p.connected;
            // Small grace before we accept a submit (prevents instant resume->submit)
            p.allowSubmitAfter = Date.now() + MIN_SUBMIT_MS;
        }
        // ✅ Ensure the triggering socket (host or player) is definitely marked connected
        const self = findPlayer(gs, socket.data.playerName);
        if (self)
            self.connected = true;
        // ✅ Awaiting only includes currently connected players
        gs.awaiting = STRICT_WAIT_FOR_ALL
            ? gs.players.filter((p) => !p.hasLeft).map((p) => p.name)
            : gs.players.filter((p) => p.connected && !p.hasLeft).map((p) => p.name);
        console.log(`🌱 Starting (or restarting) match for ${payload.gameId} → round 1`);
        console.log(`🧩 Active connections in ${gs.gameId}:`, Array.from(io.sockets.adapter.rooms.get(gs.gameId) ?? [])
            .map((id) => io.sockets.sockets.get(id)?.data?.playerName)
            .filter(Boolean));
        safeBroadcast(io, gs, { force: true }); // triggers roundStarted=true
        saveGamesToDisk(true);
        if (ack)
            ack({ ok: true, round: gs.round });
    });
    // ---------------------------
    // SUBMIT SCORE
    // ---------------------------
    socket.on("submitScore", (payload) => {
        const { gameId, playerName, round, score } = payload;
        const gs = games.get(gameId);
        if (!gs)
            return fail("NOT_FOUND", `Game ${gameId} not found.`);
        if (gs.endedAt)
            return;
        const key = String(playerName).trim().toLowerCase();
        const player = gs.players.find((p) => p.name.toLowerCase() === key);
        if (!player)
            return fail("PLAYER_NOT_FOUND", `No such player ${playerName}`);
        // 🧠 Defensive check for invalid round values
        if (typeof round !== "number" || round <= 0) {
            console.warn(`⚠️ Invalid round ${round} from ${playerName} in ${gameId}`);
            return;
        }
        // 🛡️ Ignore duplicate resubmits for the current round
        if (round === gs.round && player.lastSubmitRound >= gs.round) {
            console.log(`♻️ Duplicate submit ignored from ${playerName} r${round}`);
            return;
        }
        // ❗ Server-only guard: prevent instant/accidental submits on resume
        if (gs.round > 0 && !gs.endedAt) {
            const now = Date.now();
            // If we’ve never seen this player in-room this round, mark seen and require a brief dwell
            if (!player.seenThisRound) {
                player.seenThisRound = true;
                player.allowSubmitAfter = now + MIN_SUBMIT_MS;
                console.log(`⏸️ First activity from ${playerName} this round — gating submit for ${MIN_SUBMIT_MS}ms`);
                safeBroadcast(io, gs, { force: true });
                return;
            }
            // If they reappeared just now, require a minimal dwell time
            const notYet = typeof player.allowSubmitAfter === "number" && now < player.allowSubmitAfter;
            if (notYet) {
                console.log(`⛔ Ignoring submit from ${playerName} r${round} — too soon after (re)appear`);
                return;
            }
        }
        // 🚦 Handle possible stale or out-of-sync round submissions
        if (round < gs.round) {
            const alreadySubmitted = player.lastSubmitRound >= gs.round;
            if (alreadySubmitted) {
                console.log(`⚠️ Duplicate old submission ignored: ${playerName} r${round} (current ${gs.round})`);
                return;
            }
            // 🩹 If they haven't yet submitted this round, treat it as current submission
            console.log(`🩹 Accepting stale submission from ${playerName}: r${round} (server=${gs.round})`);
            player.scores[gs.round] = score;
            player.lastSubmitRound = gs.round;
        }
        else if (round > gs.round) {
            console.warn(`⚠️ Future submission ignored: ${playerName} r${round} > current ${gs.round}`);
            return;
        }
        else {
            // ✅ Normal case
            console.log(`📥 submitScore ${playerName} r${round}=${score}`);
            player.scores[round] = score;
            player.lastSubmitRound = round;
        }
        // 🔁 Safety net: if player was previously disconnected, auto-reconnect them
        if (!player.connected) {
            player.connected = true;
            player.hasLeft = false;
            socket.data.gameId = gameId;
            socket.data.playerName = playerName;
            socket.join(gameId);
            console.log(`🔁 Auto-reattached ${playerName} to ${gameId} on late submit`);
        }
        // Mark presence and set a short grace for any immediate follow-ups (mostly no-op now)
        player.seenThisRound = true;
        player.allowSubmitAfter = Date.now() + MIN_SUBMIT_MS;
        // ✅ Recompute awaiting list AFTER updating player state
        ensureAwaiting(gs);
        // 🏁 If EVERYONE has submitted, finalize immediately (even in strict mode)
        const finished = gs.round;
        if (gs.awaiting.length === 0) {
            console.log(`🏁 All players submitted round ${finished} (strict finalize)`);
            safeBroadcast(io, gs, { roundComplete: finished });
            setTimeout(() => {
                const live = games.get(gameId);
                if (!live || live.round !== finished || live.endedAt)
                    return;
                advanceRound(live);
            }, 2500);
            return;
        }
        // 🕐 Still awaiting someone
        if (STRICT_WAIT_FOR_ALL) {
            // If any required (non-left, not-yet-submitted) player is disconnected, HOLD the round.
            const requiredDisconnected = gs.players.some((p) => !p.hasLeft && p.lastSubmitRound < gs.round && !p.connected);
            if (requiredDisconnected) {
                gs.paused = true;
                console.log(`⏸️ Holding round ${gs.round} — required player disconnected`);
                safeBroadcast(io, gs, { force: true });
                // (optional) also ping the submitter with a message
                io.to(socket.id).emit("stateUpdate", { ...gs, message: "⏸️ Waiting for reconnect" });
                return;
            }
        }
        // Non-strict (or no requiredDisconnected): just broadcast normal “awaiting …”
        console.log(`🕐 Still awaiting ${gs.awaiting.join(", ")} for round ${gs.round}`);
        safeBroadcast(io, gs);
        // Quick receipt to the submitting socket
        io.to(socket.id).emit("stateUpdate", { ...gs, message: "✅ Score received" });
        return;
    });
    // ---------------------------
    // REMATCH GAME
    // ---------------------------
    socket.on("rematchGame", ({ gameId }) => {
        const gs = games.get(gameId);
        if (!gs)
            return fail("NOT_FOUND", `Game ${gameId} not found.`);
        // 🧠 Identify who triggered rematch
        let caller = socket.data?.playerName ?? gs.hostName;
        console.log(`🔁 Host triggered rematch for ${gameId} by ${caller}`);
        const self = findPlayer(gs, caller);
        if (!self)
            console.warn(`⚠️ rematchGame: could not find player ${caller}`);
        // 🧹 Remove permanently-left players before restarting
        gs.players = gs.players.filter(p => !p.hasLeft);
        // ♻️ Reset player states for new match
        for (const p of gs.players) {
            p.scores = {};
            p.lastSubmitRound = 0;
            p.hasLeft = false;
            // Assume the caller (host) is connected even if their socket just rejoined
            p.connected = p.connected || p.name === caller;
        }
        // 💫 Reset match metadata
        gs.round = 1;
        gs.roundSeed = Math.floor(Math.random() * 1000000);
        gs.nextRoundSeed = Math.floor(Math.random() * 1000000);
        gs.startedAt = Date.now();
        gs.endedAt = undefined;
        // ✅ Awaiting includes all current players (not just connected)
        gs.awaiting = gs.players.map(p => p.name);
        gs.paused = false; // don’t flash paused at rematch start
        console.log(`🌱 Starting new match immediately for ${gameId} → Round 1`);
        // 🛰️ Send new-round broadcast immediately
        safeBroadcast(io, gs, { force: true });
        saveGamesToDisk(true);
        // ⏳ After a short delay, rebuild connection & awaiting truth state
        setTimeout(() => {
            const live = games.get(gameId);
            if (!live)
                return;
            ensureAwaiting(live);
            safeBroadcast(io, live, { force: true });
        }, 500);
    });
    // REQUEST STATE
    const lastRequestState = new Map();
    socket.on("requestState", (payload) => {
        const now = Date.now();
        const last = lastRequestState.get(payload.gameId) ?? 0;
        if (now - last < 2000)
            return;
        lastRequestState.set(payload.gameId, now);
        const gs = getGame(payload.gameId);
        if (gs)
            safeBroadcast(io, gs);
    });
    // Disconnect
    socket.on("disconnect", (reason) => {
        const { gameId, playerName } = socket.data || {};
        console.log(`🔌 Disconnected ${playerName ?? "(unknown)"} from ${gameId ?? "(none)"} (${reason})`);
        if (!gameId || !playerName)
            return;
        const gs = games.get(gameId);
        if (!gs)
            return;
        const p = findPlayer(gs, playerName);
        if (p)
            p.connected = false;
        // 🔒 If the game is over, do not rebuild awaiting or emit a “live” update
        if (gs.endedAt || gs.round > gs.maxRounds) {
            // Optional: emit one last *final* snapshot to remaining clients
            safeBroadcast(io, gs, { roundComplete: gs.maxRounds, force: true });
            saveGamesToDisk();
            return;
        }
        // 🧩 Refresh awaiting list and rebroadcast to all connected players
        ensureAwaiting(gs);
        safeBroadcast(io, gs, { force: true });
        saveGamesToDisk();
        // ✅ NEW: if no connected players are outstanding, finish the round
        if (gs.awaiting.length === 0 && gs.round > 0 && !gs.endedAt) {
            console.log(`🏁 Round ${gs.round} completed automatically after disconnect`);
            const finished = gs.round;
            safeBroadcast(io, gs, { roundComplete: finished });
            setTimeout(() => {
                const live = games.get(gameId);
                if (!live || live.round !== finished || live.endedAt)
                    return;
                advanceRound(live);
            }, 2500);
        }
        // 🧹 Optional cleanup if no one’s left
        if (gs.players.every((pl) => !pl.connected)) {
            console.log(`🕐 All players disconnected from ${gameId} — scheduling delayed cleanup…`);
            setTimeout(() => {
                const live = games.get(gameId);
                if (!live)
                    return; // already cleaned
                // if still empty after 60 seconds, then remove
                if (live.players.every((p) => !p.connected)) {
                    console.log(`🗑️ Removing game ${gameId} after 60 s of full disconnect`);
                    games.delete(gameId);
                    saveGamesToDisk(true);
                }
                else {
                    console.log(`♻️ ${gameId} had reconnects within 60 s — keeping active`);
                }
            }, 60000);
        }
    });
});
// ---------------------------
// Startup
// ---------------------------
const PORT = process.env.PORT || 8000;
server.listen(PORT, () => {
    console.log("✅ Server running!");
    console.log(`   Local → http://localhost:${PORT}`);
    for (const [name, nets] of Object.entries(os.networkInterfaces())) {
        for (const net of nets || []) {
            if (net.family === "IPv4" && !net.internal)
                console.log(`   Network (${name}) → http://${net.address}:${PORT}`);
        }
    }
    console.log("\n📱 Use one of the 'Network' URLs on your iPhone/iPad.");
    open(`http://localhost:${PORT}/health`).catch(() => { });
});
