import express from "express";
import http from "http";
import cors from "cors";
import { Server, Socket } from "socket.io";
import os from "os";
import open from "open";
import fs from "fs";

// ---------------------------
// Type Definitions
// ---------------------------

type PlayerState = {
  name: string;
  connected: boolean;
  hasLeft?: boolean;  // ✅ new
  lastSubmitRound: number;
  scores: Record<number, number>;
};

type GameState = {
  gameId: string;
  hostName: string;
  players: PlayerState[];
  maxRounds: number;
  round: number;
  startedAt?: number;
  endedAt?: number;
  awaiting: string[];
  roundSeed?: number;
  nextRoundSeed?: number;
};

type Games = Map<string, GameState>;
const games: Games = new Map();

// ---------------------------
// Persistence + Cleanup
// ---------------------------

const STATE_FILE = "./games.json";
const STALE_MINUTES = 60; // remove games older than 1 hour

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
    if (arr.length === 0) return;

    // Write backup first
    if (fs.existsSync(STATE_FILE)) {
      fs.copyFileSync(STATE_FILE, STATE_FILE + ".bak");
    }

    fs.writeFileSync(STATE_FILE, JSON.stringify(arr, null, 2));
    // console.log(`💾 Saved ${arr.length} games to disk`);
  } catch (err) {
    console.error("❌ Failed to save games:", err);
  }
}

function loadGamesFromDisk() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;

    const data = fs.readFileSync(STATE_FILE, "utf8");
    const arr = JSON.parse(data) as GameState[];

    for (const g of arr) {
      // Defensive resets
      g.players.forEach(p => p.connected = false); // avoid ghost sessions
      g.awaiting = g.awaiting && g.awaiting.length > 0
        ? g.awaiting
        : g.players.map(p => p.name); // rebuild if missing
      games.set(g.gameId, g);
    }

    console.log(`♻️ Restored ${games.size} games from disk`);
  } catch (err) {
    console.error("⚠️ Failed to load saved games:", err);
  }
}

function cleanupStaleGames() {
  const now = Date.now();
  const removedGames: { id: string; host: string; round: number; age: string }[] = [];

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
setInterval(() => saveGamesToDisk(), 10_000);
setInterval(cleanupStaleGames, 60_000); // check every minute
loadGamesFromDisk();

// ---------------------------
// Auto-reload when games.json changes on disk (debounced + safe merge)
// ---------------------------

import crypto from "crypto";

let reloadTimer: NodeJS.Timeout | null = null;
let lastFileHash = "";

function computeFileHash(path: string): string {
  try {
    const data = fs.readFileSync(path, "utf8");
    return crypto.createHash("md5").update(data).digest("hex");
  } catch {
    return "";
  }
}

function mergeGamesFromDisk(data: string) {
  const arr = JSON.parse(data) as GameState[];
  let updated = 0;

  for (const g of arr) {
    g.players.forEach((p) => (p.connected = false)); // avoid ghost sessions
    g.awaiting = g.awaiting?.length ? g.awaiting : g.players.map((p) => p.name);
    const existing = games.get(g.gameId);

    if (!existing) {
      games.set(g.gameId, g);
      updated++;
    } else {
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
    if (curr.mtimeMs <= prev.mtimeMs) return; // no real change
    const now = Date.now();
    // Don't reload if we just wrote recently
    if (now - lastSaveTime < 5000) return;

    console.log(`📂 Detected external change to ${STATE_FILE}, verifying merge safety…`);
    try {
      const data = fs.readFileSync(STATE_FILE, "utf8");
      const arr = JSON.parse(data) as GameState[];

      let merged = 0;
      for (const g of arr) {
        // Skip if game already newer in memory
        const live = games.get(g.gameId);
        if (live && (live.startedAt ?? 0) > (g.startedAt ?? 0)) continue;

        g.players.forEach(p => (p.connected = false));
        g.awaiting = g.awaiting?.length ? g.awaiting : g.players.map(p => p.name);
        games.set(g.gameId, g);
        merged++;
      }

      if (merged > 0) console.log(`♻️ Merged ${merged} newer game(s) from disk safely`);
    } catch (err) {
      console.error("⚠️ Safe merge failed:", err);
    }
  });
}

// ---------------------------
// Helpers
// ---------------------------

function newGame(gameId: string, hostName: string, maxRounds = 10): GameState {
  const gs: GameState = {
    gameId,
    hostName,
    players: [],
    maxRounds,
    round: 0,
    awaiting: [],
  };
  games.set(gameId, gs);
  saveGamesToDisk();
  return gs;
}

function getGame(gameId: string): GameState | undefined {
  return games.get(gameId);
}

function findPlayer(gs: GameState, playerName: string): PlayerState | undefined {
  return gs.players.find((p) => p.name.toLowerCase() === playerName.toLowerCase());
}

function ensureAwaiting(gs: GameState) {
  const roomSockets = io.sockets.adapter.rooms.get(gs.gameId) ?? new Set();

  const activeNames = new Set(
    Array.from(roomSockets)
      .map((sid) => io.sockets.sockets.get(sid)?.data?.playerName?.toLowerCase())
      .filter(Boolean)
  );

  const need = gs.players
    .map((p) => {
      const isConnected = activeNames.has(p.name.toLowerCase());
      p.connected = isConnected;
      return p;
    })
    .filter((p) => !p.hasLeft && p.lastSubmitRound < gs.round)
    .map((p) => p.name);

  gs.awaiting = need;
  gs.paused = gs.players.some((p) => !p.hasLeft && !p.connected); // ✅ informational only

  console.log(`🧩 ensureAwaiting(): round=${gs.round} → awaiting=[${gs.awaiting.join(", ")}]`);
}

// ---------------------------
// Round Advancement Helper
// ---------------------------
function advanceRound(gs: GameState) {
  if (gs.endedAt) return; // already done

  // 🏁 End-of-game check
  if (gs.round >= gs.maxRounds) {
    gs.endedAt = Date.now();
    gs.round = gs.maxRounds + 1;
    console.log(`🏁 Game ${gs.gameId} completed all ${gs.maxRounds} rounds`);
    safeBroadcast(io, gs, { roundComplete: gs.maxRounds });
    saveGamesToDisk(true);
    return;
  }

  // 🔁 Move to next round
  gs.round += 1;
  gs.roundSeed = gs.nextRoundSeed ?? Math.floor(Math.random() * 1_000_000);
  gs.nextRoundSeed = Math.floor(Math.random() * 1_000_000);

  // 🧹 Skip disconnected players (but keep them in the player list)
  const before = gs.awaiting.length;
  gs.awaiting = gs.players
    .filter((p) => p.connected && !p.hasLeft)
    .map((p) => p.name);
  const skipped = before - gs.awaiting.length;
  if (skipped > 0) {
    console.log(
      `⏭️ Skipped ${skipped} disconnected player(s) for round ${gs.round}`
    );
  }

  // ✅ Rebuild awaiting list with updated connection states
  ensureAwaiting(gs);

  console.log(`🔁 Advancing to round ${gs.round}`);
  safeBroadcast(io, gs);
  saveGamesToDisk(true);
}

// ---------------------------
// Broadcast Helpers
// ---------------------------

function broadcast(
  io: Server,
  gs: GameState,
  opts: { roundComplete?: number; force?: boolean } = {}
) {
  if (gs.round === 0 && !opts.force) {
    console.log(`🚫 Skipping broadcast for ${gs.gameId} (no active round yet)`);
    return;
  }

  const totals: Record<string, number> = {};
  const submissions: Record<string, boolean> = {};

  for (const p of gs.players) {
    const sum = Object.values(p.scores).reduce((a, b) => a + b, 0);
    totals[p.name] = sum;
    submissions[p.name] = p.lastSubmitRound >= gs.round;
  }

  const started = gs.round > 0 && gs.round <= gs.maxRounds;
  const ended = gs.round > gs.maxRounds;
  const timestamp = Date.now();

  const message =
    gs.awaiting.length === 0
      ? "All players submitted"
      : `Awaiting: ${gs.awaiting.join(", ")}`;

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

  console.log(
    `🛰️ [Server] Round ${gs.round}  roundComplete=${opts.roundComplete ?? "nil"}  Totals: ${JSON.stringify(
      totals
    )}`
  );

  io.to(gs.gameId).emit("stateUpdate", enhancedState);
}

// --- throttled wrapper ---
const broadcastCooldown: Map<string, NodeJS.Timeout> = new Map();
const callCounts: Record<string, number> = {};
setInterval(() => {
  const counts = Object.entries(callCounts)
    .map(([id, n]) => `${id}:${n}`)
    .join("  ");
  if (counts) console.log(`📊 Broadcast counts: ${counts}`);
  for (const k of Object.keys(callCounts)) delete callCounts[k];
}, 3000);

function safeBroadcast(
  io: Server,
  gs: GameState,
  opts: { roundComplete?: number; force?: boolean } = {}
) {
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
  const removedGames: { id: string; host: string; round: number; age: string }[] = [];

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
  } else {
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
  cors: { origin: "*" },         // Allow all for testing
  pingInterval: 10000,           // Send a ping every 10s (default is 25s)
  pingTimeout: 15000,            // If no pong after 15s, drop & reconnect
  connectTimeout: 5000,          // Wait max 5s for initial connection
  maxHttpBufferSize: 1e6,        // Avoid big payload stalls
  allowEIO3: true,               // Support older clients if needed
  perMessageDeflate: {
    threshold: 2048,             // Compress larger packets only
  },
});

io.on("connection", (socket: Socket) => {
  const fail = (code: string, message: string) => socket.emit("error", { code, message });

    // CREATE
  socket.on("createGame", (payload: { gameId?: string; hostName: string }) => {
    const id =
      (payload.gameId && payload.gameId.trim()) ||
      `game_${Math.random().toString(36).slice(2, 8)}`;

    // 🔥 If an old game with the same ID exists, clear it first
    if (games.has(id)) {
      const existing = games.get(id)!;
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
  });

  // JOIN
  socket.on("joinGame", (payload: { gameId: string; playerName: string }) => {
    let gs = getGame(payload.gameId);
    if (!gs) {
      gs = newGame(payload.gameId, payload.playerName);
      console.log(`🆕 Auto-created game ${payload.gameId} for ${payload.playerName}`);
    }

    let p = findPlayer(gs, payload.playerName);
    if (!p) {
      p = { name: payload.playerName, connected: true, lastSubmitRound: 0, scores: {} };
      gs.players.push(p);
    } else {
      p.connected = true;
      p.hasLeft = false;   // ✅ rejoined player is now active again
    }

    gs.awaiting = gs.players.map((pl) => pl.name); // ✅ ensure awaiting always populated

    socket.data.playerName = payload.playerName;
    socket.data.gameId = payload.gameId;
    socket.join(gs.gameId);
    ensureAwaiting(gs);

    // 🧠 Send latest state directly to the reconnected socket
    safeBroadcast(io, gs, { force: true });
    io.to(socket.id).emit("stateUpdate", {
      ...gs,
      message: "🔄 Synced latest state after reconnection",
    });
  });

  // ---------------------------
  // LEAVE GAME
  // ---------------------------
  socket.on("leaveGame", (payload) => {
    const gs = getGame(payload.gameId);
    if (!gs) return fail("NOT_FOUND", `Game ${payload.gameId} not found.`);

    const p = findPlayer(gs, payload.playerName);
    if (p) {
      p.connected = false;
      p.hasLeft = true;
      console.log(`👋 ${p.name} left game ${payload.gameId}`);
    } else {
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
        if (!live || live.round !== gs.round || live.endedAt) return;

        advanceRound(live);

      }, 2500);
    } else {
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
  socket.on("startGame", (payload: { gameId: string }) => {
    const gs = getGame(payload.gameId);
    if (!gs) return fail("NOT_FOUND", `Game ${payload.gameId} not found.`);

    // ✅ Only start if the game is fresh or ended
    if (gs.round > 0 && !gs.endedAt) {
      console.warn(`⚠️ startGame ignored — ${gs.gameId} already running (round=${gs.round})`);
      return;
    }

    // 🧩 Defensive: find all currently connected sockets in this room
    const roomSockets = io.sockets.adapter.rooms.get(gs.gameId) ?? new Set();

    // 🧹 Reset all player state cleanly
    for (const p of gs.players) {
      p.scores = {};
      p.lastSubmitRound = 0;
      p.hasLeft = false;   // ✅ reset for fresh match

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
    gs.roundSeed = Math.floor(Math.random() * 1_000_000);
    gs.nextRoundSeed = Math.floor(Math.random() * 1_000_000);
    gs.startedAt = Date.now();

    // ✅ Ensure the triggering socket (host or player) is definitely marked connected
    const self = findPlayer(gs, socket.data.playerName);
    if (self) self.connected = true;

    // ✅ Awaiting only includes currently connected players
    gs.awaiting = gs.players.filter((p) => p.connected).map((p) => p.name);

    console.log(`🌱 Starting (or restarting) match for ${payload.gameId} → round 1`);
    console.log(`🧩 Active connections in ${gs.gameId}:`,
      Array.from(io.sockets.adapter.rooms.get(gs.gameId) ?? [])
        .map((id) => io.sockets.sockets.get(id)?.data?.playerName)
        .filter(Boolean)
    );

    safeBroadcast(io, gs, { force: true }); // triggers roundStarted=true
    saveGamesToDisk(true);
  });

  // ---------------------------
  // SUBMIT SCORE
  // ---------------------------
  socket.on("submitScore", (payload) => {
    const { gameId, playerName, round, score } = payload;
    const gs = games.get(gameId);
    if (!gs) return fail("NOT_FOUND", `Game ${gameId} not found.`);
    if (gs.endedAt) return;

    const key = playerName.trim().toLowerCase();
    const player = gs.players.find((p) => p.name.toLowerCase() === key);
    if (!player) return fail("PLAYER_NOT_FOUND", `No such player ${playerName}`);

    // 🧠 Defensive check for invalid round values
    if (typeof round !== "number" || round <= 0) {
      console.warn(`⚠️ Invalid round ${round} from ${playerName} in ${gameId}`);
      return;
    }

    // 🚦 Handle possible stale or out-of-sync round submissions
    if (round < gs.round) {
      const alreadySubmitted = player.lastSubmitRound >= gs.round;
      if (alreadySubmitted) {
        console.log(
          `⚠️ Duplicate old submission ignored: ${playerName} r${round} (current ${gs.round})`
        );
        return;
      }

      // 🩹 If they haven't yet submitted this round, treat it as current submission
      console.log(
        `🩹 Accepting stale submission from ${playerName}: r${round} (server=${gs.round})`
      );
      player.scores[gs.round] = score;
      player.lastSubmitRound = gs.round;
    } else if (round > gs.round) {
      console.warn(
        `⚠️ Future submission ignored: ${playerName} r${round} > current ${gs.round}`
      );
      return;
    } else {
      // ✅ Normal case
      console.log(`📥 submitScore ${playerName} r${round}=${score}`);
      player.scores[round] = score;
      player.lastSubmitRound = round;
    }

    // 🔁 Safety net: if player was previously disconnected, auto-reconnect them
    if (!player.connected) {
      player.connected = true;
      socket.data.gameId = gameId;
      socket.data.playerName = playerName;
      socket.join(gameId);
      console.log(`🔁 Auto-reattached ${playerName} to ${gameId} on late submit`);
    }

    // ✅ Recompute awaiting list AFTER updating player state
    ensureAwaiting(gs);

    if (gs.awaiting.length > 0) {
      console.log(`🕐 Still awaiting ${gs.awaiting.join(", ")} for round ${gs.round}`);
      safeBroadcast(io, gs);
      // 🧠 Send fresh state to the submitting player too
      io.to(socket.id).emit("stateUpdate", { ...gs, message: "✅ Score received" });
      return;
    }

    // 🏁 All connected players have submitted
    const finished = gs.round;
    console.log(`🏁 All players submitted round ${finished}`);
    safeBroadcast(io, gs, { roundComplete: finished });

    setTimeout(() => {
      // 🧩 Re-check that the game still exists and hasn’t advanced or ended
      const live = games.get(gameId);
      if (!live || live.round !== finished || live.endedAt) return;

      advanceRound(live);

    }, 2500);
  });

  // ---------------------------
  // REMATCH GAME
  // ---------------------------
  socket.on("rematchGame", ({ gameId }) => {
    const gs = games.get(gameId);
    if (!gs) return fail("NOT_FOUND", `Game ${gameId} not found.`);

    console.log(`🔁 Host triggered rematch for ${gameId}`);

    // 🧹 Remove players who have left permanently
    const beforeCount = gs.players.length;
    gs.players = gs.players.filter(p => !p.hasLeft);
    const removed = beforeCount - gs.players.length;
    if (removed > 0) {
      console.log(`🗑️ Removed ${removed} player(s) who left before rematch`);
    }


    // 🧹 Reset scores and submission states for all players
    for (const p of gs.players) {
      p.scores = {};
      p.lastSubmitRound = 0;
      p.hasLeft = false;   // ✅ reset for fresh match
    }

    // 💫 Start fresh
    gs.round = 1;
    gs.roundSeed = Math.floor(Math.random() * 1_000_000);
    gs.nextRoundSeed = Math.floor(Math.random() * 1_000_000);
    gs.startedAt = Date.now();
    gs.endedAt = undefined;

    // ✅ Ensure the triggering socket (host or player) is definitely marked connected
    const self = findPlayer(gs, socket.data.playerName);
    if (self) self.connected = true;

    // ✅ Awaiting includes only connected players
    gs.awaiting = gs.players.filter((p) => p.connected).map((p) => p.name);

    console.log(`🌱 Starting new match immediately for ${gameId} → Round 1`);
    safeBroadcast(io, gs, { force: true }); // triggers roundStarted=true
    saveGamesToDisk(true);
  });

  // REQUEST STATE
  const lastRequestState = new Map<string, number>();
  socket.on("requestState", (payload: { gameId: string }) => {
    const now = Date.now();
    const last = lastRequestState.get(payload.gameId) ?? 0;
    if (now - last < 2000) return;
    lastRequestState.set(payload.gameId, now);

    const gs = getGame(payload.gameId);
    if (gs) safeBroadcast(io, gs);
  });

  // Disconnect
  socket.on("disconnect", (reason) => {
    const { gameId, playerName } = socket.data || {};
    console.log(`🔌 Disconnected ${playerName ?? "(unknown)"} from ${gameId ?? "(none)"} (${reason})`);

    if (!gameId || !playerName) return;

    const gs = games.get(gameId);
    if (!gs) return;

    const p = findPlayer(gs, playerName);
    if (p) p.connected = false;

    // 🧩 Refresh awaiting list and rebroadcast to all connected players
    ensureAwaiting(gs);
    safeBroadcast(io, gs, { force: true });

    saveGamesToDisk();

    // 🧹 Optional cleanup if no one’s left
    if (gs.players.every((pl) => !pl.connected)) {
      console.log(`🕐 All players disconnected from ${gameId} — scheduling delayed cleanup…`);

      setTimeout(() => {
        const live = games.get(gameId);
        if (!live) return; // already cleaned

        // if still empty after 60 seconds, then remove
        if (live.players.every((p) => !p.connected)) {
          console.log(`🗑️ Removing game ${gameId} after 60 s of full disconnect`);
          games.delete(gameId);
          saveGamesToDisk(true);
        } else {
          console.log(`♻️ ${gameId} had reconnects within 60 s — keeping active`);
        }
      }, 60_000);
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
  open(`http://localhost:${PORT}/health`).catch(() => {});
});
