# Hold & Draw Multi-Game Starter (Node + TypeScript + Socket.io)

This starter lets you run **100+ simultaneous rooms** for your 10‑round "hold & draw" games (ColorUp / DrawzPoker).

## Structure

- `server/` — Node.js + TypeScript + Express + Socket.io
- `test-client/` — Plain HTML test client to simulate multiple players/rooms in browser tabs

## Quick Start

### 1) Server

```bash
cd server
npm install
npm run dev
# Server at http://localhost:8000
```

Health check:

```
GET http://localhost:8000/health
```

### 2) Test client

Just open `test-client/index.html` in your browser (double-click the file).

- Set the **Server URL** to `http://localhost:8000`
- Use **Create Game** (host)
- Other tabs **Join Game** with same gameId
- **Start Game** (host), then each **Submit Score**
- Server auto-advances when all connected players submit

## Stable Event Contract (for Swift / JS clients)

**client → server**

- `createGame` `{ gameId?: string; hostName: string }`
- `joinGame` `{ gameId: string; playerName: string }`
- `leaveGame` `{ gameId: string; playerName: string }`
- `startGame` `{ gameId: string }`
- `submitScore` `{ gameId: string; playerName: string; round: number; score: number }`
- `requestState` `{ gameId: string }`

**server → client**

- `stateUpdate` `GameState`
- `error` `{ code: string; message: string }`

**GameState**

```ts
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
  maxRounds: number; // 10
  round: number; // 0 before start, 1..maxRounds, >maxRounds => over
  startedAt?: number;
  endedAt?: number;
  awaiting: string[]; // players (connected) who still need to submit this round
};
```

## Notes

- Advancement waits only on **connected** players; if someone leaves, the room won’t stall.
- To scale horizontally later, persist `games` into Redis or Mongo and use a `socket.io` adapter.
- You can serve the test client from any static host; it just needs to reach the socket server.
