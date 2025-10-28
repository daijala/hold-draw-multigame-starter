import express from 'express';
import http from 'http';
import cors from 'cors';
import { Server, Socket } from 'socket.io';
import os from "os";
import open from "open";


/**
 * Event names (stable for Swift, Web, etc.)
 * client -> server:
 *  - createGame: { gameId?: string, hostName: string }
 *  - joinGame:   { gameId: string, playerName: string }
 *  - leaveGame:  { gameId: string, playerName: string }
 *  - startGame:  { gameId: string } // host only
 *  - submitScore:{ gameId: string, playerName: string, round: number, score: number }
 *  - requestState: { gameId: string } // ask for full state snapshot
 *
 * server -> client:
 *  - stateUpdate: EnhancedGameState
 *  - error: { code: string, message: string }
 */

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
  nextRoundSeed?: number;   // ✅ add this line
};

type Games = Map<string, GameState>;
const games: Games = new Map();

// Utility: find or create game (for createGame)
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

// 🔔 Enhanced broadcast helper that mirrors Swift `GameState`
function broadcast(io: Server, gs: GameState, opts: { roundComplete?: number } = {}) {
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

  io.to(gs.gameId).emit("stateUpdate", enhancedState);
}

const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => res.json({ ok: true, games: games.size }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

io.on('connection', (socket: Socket) => {
  function fail(code: string, message: string) {
    socket.emit('error', { code, message });
  }

  socket.on('createGame', (payload: { gameId?: string; hostName: string }) => {
    try {
      console.log(`🆕 createGame from ${payload.hostName} → ${payload.gameId}`);

      const id =
        (payload.gameId && payload.gameId.trim()) ||
        `game_${Math.random().toString(36).slice(2, 8)}`;
      if (games.has(id)) return fail('DUPLICATE_GAME', `Game ${id} already exists.`);
      const gs = newGame(id, payload.hostName);
      
      gs.players.push({
        name: payload.hostName,
        connected: true,
        lastSubmitRound: 0,
        scores: {},
      });
      socket.join(id);
      broadcast(io, gs);
    } catch (e: any) {
      fail('CREATE_ERROR', e?.message || 'Unknown error');
    }
  });

  socket.on('joinGame', (payload: { gameId: string, playerName: string }) => {
    console.log(`👥 joinGame from ${payload.playerName} → ${payload.gameId}`);

    let gs = getGame(payload.gameId);
    if (!gs) {
      // 🚀 auto-create if not found
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
    socket.join(gs.gameId);
    if (gs.round > 0 && gs.round <= gs.maxRounds) {
      ensureAwaiting(gs);
    }
    broadcast(io, gs);
  });

  socket.on('leaveGame', (payload: { gameId: string; playerName: string }) => {
    const gs = getGame(payload.gameId);
    if (!gs) return fail('NOT_FOUND', `Game ${payload.gameId} not found.`);
    const p = findPlayer(gs, payload.playerName);
    if (p) {
      p.connected = false;
      ensureAwaiting(gs);
      socket.leave(gs.gameId);
      broadcast(io, gs);
    } else fail('PLAYER_NOT_FOUND', `Player ${payload.playerName} not in game.`);
  });

  socket.on('startGame', (payload: { gameId: string }) => {
    const gs = getGame(payload.gameId);
    if (!gs) return fail('NOT_FOUND', `Game ${payload.gameId} not found.`);

    console.log(`🎬 startGame for ${payload.gameId} (round=${gs.round}, endedAt=${gs.endedAt})`);

    // ✅ If game was ended or reset, fully restart
    if (gs.round <= 0 || gs.endedAt) {
      gs.endedAt = undefined;               // ← hard clear lingering endedAt
      gs.round = 1;
      gs.roundSeed = Math.floor(Math.random() * 1_000_000);
      gs.nextRoundSeed = Math.floor(Math.random() * 1_000_000);
      gs.startedAt = Date.now();
      gs.awaiting = gs.players.map(p => p.name);

      console.log(`🌱 Starting match for ${payload.gameId} → round 1`);
      broadcast(io, gs);
      return;
    }

    // 🚫 Prevent double-start mid-game
    if (gs.round > 0 && !gs.endedAt) {
      console.log(`⚠️ Game ${payload.gameId} already in progress (round ${gs.round})`);
      return fail('ALREADY_STARTED', 'Game already in progress.');
    }
  });

  socket.on("submitScore", (payload) => {
    const { gameId, playerName, round, score } = payload;
    const gs = games.get(gameId);
    if (!gs) return fail("NOT_FOUND", `Game ${gameId} not found.`);

    // 🚫 Ignore any late submissions from a previous session
    if (gs.round <= 0) {
      console.log(`⚠️ Ignoring submitScore for ${gameId} → game is reset (round=${gs.round})`);
      return;
    }

    // 🚫 Ignore submissions for older completed games
    if (gs.endedAt) {
      console.log(`⚠️ Ignoring submitScore for ${gameId} → game already ended`);
      return;
    }

    const player = gs.players.find((p) => p.name === playerName);
    if (!player) return fail("PLAYER_NOT_FOUND", `No such player ${playerName}`);

    player.scores[round] = score;
    player.lastSubmitRound = round;

    gs.awaiting = gs.players
      .filter((p) => p.lastSubmitRound < gs.round)
      .map((p) => p.name);

    // 🏁 Everyone submitted?
    if (gs.awaiting.length === 0) {
      const finished = gs.round;
      console.log(`🏁 All players submitted round ${finished}`);

      // 📊 1️⃣ Broadcast leaderboard snapshot
      broadcast(io, gs, { roundComplete: finished });

      // ⏱ 2️⃣ Wait, then advance to next round (but re-check validity!)
      setTimeout(() => {
        
        // 🔒 Safety: skip if game was reset or ended during the delay
        if (gs.round <= 0) {
          console.log(`⚠️ Skipping advanceRound — ${gameId} was reset (round=${gs.round})`);
          return;
        }
        if (gs.endedAt) {
          console.log(`⚠️ Skipping advanceRound — ${gameId} already ended`);
          return;
        }

        if (gs.round >= gs.maxRounds) {
          console.log(`🏁 Game ${gs.gameId} completed all ${gs.maxRounds} rounds`);
          gs.endedAt = Date.now();
          gs.round = gs.maxRounds + 1;

          // ✅ Broadcast final leaderboard
          broadcast(io, gs, { roundComplete: gs.maxRounds });
          return;
        }
        gs.round += 1;
        gs.roundSeed = gs.nextRoundSeed ?? Math.floor(Math.random() * 1_000_000);
        gs.nextRoundSeed = Math.floor(Math.random() * 1_000_000);
        gs.awaiting = gs.players.map((p) => p.name);

        console.log(`🔁 Advancing to round ${gs.round}`);
        broadcast(io, gs);
      }, 2500);
    } else {
      console.log(`🕐 Awaiting submissions from: ${gs.awaiting.join(", ")}`);
      broadcast(io, gs);
    }
  });

  // 🆕 Manual Rematch Handler (Play Again flow)
  socket.on("rematchGame", ({ gameId }) => {
    const gs = games.get(gameId);
    if (!gs) {
      return socket.emit("error", {
        code: "NOT_FOUND",
        message: `Game ${gameId} not found.`,
      });
    }

    console.log(`🔁 Host triggered rematch for ${gameId}`);

    // 🧹 1️⃣ Cleanly reset all round-based state
    gs.round = 0;
    gs.roundSeed = undefined;
    gs.nextRoundSeed = undefined;
    gs.awaiting = [];
    gs.startedAt = undefined;
    gs.endedAt = undefined;

    // 🧩 Reset players’ per-round data
    for (const p of gs.players) {
      p.scores = {};
      p.lastSubmitRound = 0;
    }

    // 🟢 2️⃣ Immediately begin Round 1 (no extra startGame needed)
    gs.round = 1;
    gs.roundSeed = Math.floor(Math.random() * 1_000_000);
    gs.nextRoundSeed = Math.floor(Math.random() * 1_000_000);
    gs.startedAt = Date.now();
    gs.awaiting = gs.players.map(p => p.name);

    console.log(`🌱 Starting new match immediately for ${gameId} → Round 1`);
    broadcast(io, gs);
  });

  socket.on('requestState', (payload: { gameId: string }) => {
    const gs = getGame(payload.gameId);
    if (!gs) return fail('NOT_FOUND', `Game ${payload.gameId} not found.`);
    broadcast(io, gs);
  });
});

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

  // Optional: auto-open your health check
  open(`http://localhost:${PORT}/health`).catch(() => {});
});
