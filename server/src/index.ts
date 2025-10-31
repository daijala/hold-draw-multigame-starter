import express from "express";
import http from "http";
import cors from "cors";
import { Server, Socket } from "socket.io";
import os from "os";
import open from "open";

// ---------------------------
// Type Definitions
// ---------------------------

type PlayerState = {
  name: string;
  connected: boolean;
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
  return gs;
}

function getGame(gameId: string): GameState | undefined {
  return games.get(gameId);
}

function findPlayer(gs: GameState, playerName: string): PlayerState | undefined {
  return gs.players.find((p) => p.name.toLowerCase() === playerName.toLowerCase());
}

function ensureAwaiting(gs: GameState) {
  const need = gs.players
    .filter((p) => p.connected)
    .filter((p) => p.lastSubmitRound < gs.round)
    .map((p) => p.name);
  gs.awaiting = need;
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
// Server + Socket.IO Setup
// ---------------------------

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

// ---------------------------
// Socket Events
// ---------------------------

io.on("connection", (socket: Socket) => {
  const fail = (code: string, message: string) => socket.emit("error", { code, message });

  // CREATE
  socket.on("createGame", (payload: { gameId?: string; hostName: string }) => {
    const id =
      (payload.gameId && payload.gameId.trim()) ||
      `game_${Math.random().toString(36).slice(2, 8)}`;
    if (games.has(id)) return fail("DUPLICATE_GAME", `Game ${id} already exists.`);
    const gs = newGame(id, payload.hostName);
    gs.players.push({
      name: payload.hostName,
      connected: true,
      lastSubmitRound: 0,
      scores: {},
    });
    socket.data.playerName = payload.hostName;
    socket.data.gameId = id;
    socket.join(id);
    safeBroadcast(io, gs, { force: true });
  });

  // io.on("disconnect", (reason) => {
  //   if (reason !== "transport close") console.log("🔌 Disconnected", reason);
  // });

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
    }

    socket.data.playerName = payload.playerName;
    socket.data.gameId = payload.gameId;
    socket.join(gs.gameId);
    ensureAwaiting(gs);
    safeBroadcast(io, gs, { force: true });
  });

  // LEAVE
  socket.on("leaveGame", (payload: { gameId: string; playerName: string }) => {
    const gs = getGame(payload.gameId);
    if (!gs) return fail("NOT_FOUND", `Game ${payload.gameId} not found.`);
    const p = findPlayer(gs, payload.playerName);
    if (p) {
      p.connected = false;
      ensureAwaiting(gs);
      socket.leave(gs.gameId);
      safeBroadcast(io, gs, { force: true });
    } else fail("PLAYER_NOT_FOUND", `Player ${payload.playerName} not in game.`);
  });

  // START
  socket.on("startGame", (payload: { gameId: string }) => {
    const gs = getGame(payload.gameId);
    if (!gs) return fail("NOT_FOUND", `Game ${payload.gameId} not found.`);

    if (gs.round <= 0 || gs.endedAt) {
      gs.endedAt = undefined;
      gs.round = 1;
      gs.roundSeed = Math.floor(Math.random() * 1_000_000);
      gs.nextRoundSeed = Math.floor(Math.random() * 1_000_000);
      gs.startedAt = Date.now();
      gs.awaiting = gs.players.map((p) => p.name);

      console.log(`🌱 Starting match for ${payload.gameId} → round 1`);
      safeBroadcast(io, gs);
      return;
    }

    if (gs.round > 0 && !gs.endedAt) {
      return fail("ALREADY_STARTED", "Game already in progress.");
    }
  });

  // SUBMIT
  socket.on("submitScore", (payload) => {
    const { gameId, playerName, round, score } = payload;
    const gs = games.get(gameId);
    if (!gs) return fail("NOT_FOUND", `Game ${gameId} not found.`);
    if (gs.endedAt) return;

    const key = playerName.trim().toLowerCase();
    const player = gs.players.find((p) => p.name.toLowerCase() === key);
    if (!player) return fail("PLAYER_NOT_FOUND", `No such player ${playerName}`);

    if (round < gs.round) {
      console.log(`⚠️ Ignoring late submission r${round} < current ${gs.round} from ${playerName}`);
      return;
    }

    console.log(`📥 submitScore ${playerName} r${round}=${score}`);
    player.scores[round] = score;
    player.lastSubmitRound = round;

    ensureAwaiting(gs);

    if (gs.awaiting.length === 0) {
      const finished = gs.round;
      console.log(`🏁 All players submitted round ${finished}`);

      safeBroadcast(io, gs, { roundComplete: finished });

      setTimeout(() => {
        if (!games.has(gameId)) return;
        const live = games.get(gameId)!;
        if (live.round !== finished) return;
        if (live.endedAt) return;

        if (live.round >= live.maxRounds) {
          live.endedAt = Date.now();
          live.round = live.maxRounds + 1;
          console.log(`🏁 Game ${live.gameId} completed all ${live.maxRounds} rounds`);
          safeBroadcast(io, live, { roundComplete: live.maxRounds });
          return;
        }

        live.round += 1;
        live.roundSeed = live.nextRoundSeed ?? Math.floor(Math.random() * 1_000_000);
        live.nextRoundSeed = Math.floor(Math.random() * 1_000_000);
        live.awaiting = live.players.map((p) => p.name);
        console.log(`🔁 Advancing to round ${live.round}`);
        safeBroadcast(io, live);
      }, 2500);
    } else {
      console.log(`🕐 Awaiting submissions from: ${gs.awaiting.join(", ")}`);
      safeBroadcast(io, gs);
    }
  });

  // REMATCH
  socket.on("rematchGame", ({ gameId }) => {
    const gs = games.get(gameId);
    if (!gs) return fail("NOT_FOUND", `Game ${gameId} not found.`);

    console.log(`🔁 Host triggered rematch for ${gameId}`);

    for (const p of gs.players) {
      p.scores = {};
      p.lastSubmitRound = 0;
    }

    gs.round = 1;
    gs.roundSeed = Math.floor(Math.random() * 1_000_000);
    gs.nextRoundSeed = Math.floor(Math.random() * 1_000_000);
    gs.startedAt = Date.now();
    gs.endedAt = undefined;
    gs.awaiting = gs.players.map((p) => p.name);

    console.log(`🌱 Starting new match immediately for ${gameId} → Round 1`);
    safeBroadcast(io, gs);
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

  // 🔌 Connection lifecycle events
  socket.on("disconnect", () => {
    const { gameId, playerName } = socket.data || {};
    console.log(`🔌 Disconnected ${playerName ?? "(unknown)"} from ${gameId ?? "(none)"}`);
    if (gameId && playerName) {
      const gs = games.get(gameId);
      const p = gs && findPlayer(gs, playerName);
      if (p) p.connected = false;
      if (gs) ensureAwaiting(gs);
    }
  });

  socket.on("connect", () => {
    const { gameId, playerName } = socket.data || {};
    if (gameId && playerName) {
      console.log(`🔄 Rejoining ${playerName} to ${gameId} after reconnect`);
      socket.join(gameId);
      const gs = games.get(gameId);
      if (gs) {
        const p = findPlayer(gs, playerName);
        if (p) p.connected = true;
        ensureAwaiting(gs);
        safeBroadcast(io, gs, { force: true });
      }
    }
  });
});

// ---------------------------
// Startup
// ---------------------------

const PORT = process.env.PORT || 8000;
server.listen(PORT, () => {
  console.log("✅ Server is running!");
  console.log(`   Local  → http://localhost:${PORT}`);

  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]!) {
      if (net.family === "IPv4" && !net.internal) {
        console.log(`   Network (${name}) → http://${net.address}:${PORT}`);
      }
    }
  }
  console.log("\n📱 Use one of the 'Network' URLs on your iPhone/iPad.");
  open(`http://localhost:${PORT}/health`).catch(() => {});
});
