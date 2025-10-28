# Hold & Draw Multi-Game Server

## Project Overview

This is a real-time multiplayer game server built with Node.js, TypeScript, Express, and Socket.io. It supports 100+ simultaneous game rooms for 10-round "hold & draw" games (ColorUp / DrawzPoker).

**Status**: ✅ Fully configured and running in Replit environment
**Last Updated**: October 28, 2025

## Project Architecture

### Structure
```
├── server/                 # Backend Socket.io server
│   ├── src/
│   │   └── index.ts       # Main server logic with game state management
│   ├── dist/              # Compiled JavaScript (production build)
│   └── package.json       # Server dependencies
├── test-client/           # Frontend HTML test client
│   └── index.html         # Interactive game client UI
├── frontend-server.js     # Static file server for test client
├── package.json           # Root dependencies
└── start-production.sh    # Production startup script
```

### Technology Stack
- **Backend**: Node.js + TypeScript + Express + Socket.io
- **Frontend**: Vanilla HTML/CSS/JavaScript with Socket.io client
- **Build Tools**: tsx (development), TypeScript compiler (production)

## Ports Configuration

The project uses two servers running on different ports:

- **Frontend Server**: Port 5000 (serves the test client UI)
  - Accessible via Replit webview
  - Serves static HTML from `test-client/` directory
  
- **Backend Server**: Port 8000 (Socket.io game server)
  - Handles WebSocket connections
  - Manages game state and player interactions
  - Health check: `http://localhost:8000/health`

## Development

### Running Locally
Both servers start automatically via Replit workflows:
- **Backend Workflow**: Runs `tsx watch` for hot-reloading TypeScript
- **Frontend Workflow**: Serves static files on port 5000

### Key Features
- Supports 100+ concurrent game rooms
- 10-round game mechanics
- Auto-advancement when all connected players submit scores
- Player reconnection handling
- Round-based scoring system with seeded randomization
- Real-time state synchronization

## Socket.io Event Contract

### Client → Server Events
- `createGame`: Create a new game room
- `joinGame`: Join an existing game
- `leaveGame`: Leave a game
- `startGame`: Start the game (host only)
- `submitScore`: Submit score for current round
- `requestState`: Request full game state
- `rematchGame`: Start a new match with same players

### Server → Client Events
- `stateUpdate`: Full game state update
- `error`: Error message with code

## Deployment

The project is configured for **VM deployment** to support:
- Persistent WebSocket connections
- Real-time game state management
- Multiple concurrent server processes

**Build Command**: Compiles TypeScript in `server/` directory
**Run Command**: Starts both backend (port 8000) and frontend (port 5000) servers

## Recent Changes

### October 28, 2025 - Replit Environment Setup
- Updated backend port from 4000 to 8000 (Replit compatibility)
- Created Express static server for frontend on port 5000
- Configured automatic Socket.io URL detection for Replit environment
- Replaced complex ts-node import with tsx for better ESM support
- Added comprehensive .gitignore for Node.js
- Configured VM deployment for production
- Created dual-server startup configuration

## Notes

- The test client automatically connects to the correct backend URL based on the environment
- Games are stored in memory; for horizontal scaling, consider Redis/Mongo persistence
- Only connected players block round advancement (disconnected players are skipped)
- The server binds to localhost for backend and 0.0.0.0 for frontend (Replit requirement)

## Health Check

Verify the backend is running:
```bash
curl http://localhost:8000/health
# Expected: {"ok":true,"games":0}
```
