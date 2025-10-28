#!/bin/bash

# Start backend server in the background
cd server && npm start &
BACKEND_PID=$!

# Wait a moment for backend to start
sleep 2

# Start frontend server
cd ..
node frontend-server.js &
FRONTEND_PID=$!

# Wait for both processes
wait $BACKEND_PID $FRONTEND_PID
