const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

// ── In-memory store ──────────────────────────────────────────────
const rooms = {};

// ── Word list ───────────────────────────────────────────────────
const rawDictionary = fs.readFileSync(path.join(__dirname, 'words.txt'), 'utf8');
const DICTIONARY = new Set();
rawDictionary.split('\n').forEach(word => {
  const normalizedWord = word.trim().toLowerCase();
  if (normalizedWord.length >= 3) DICTIONARY.add(normalizedWord);
});
console.log(`Dictionary loaded: ${DICTIONARY.size} words`);

// ── Helpers ──────────────────────────────────────────────────────
function generateRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 4; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Score a 5x5 board (array of 25 cells, row-major)
function scoreBoard(grid) {
  const words = [];
  const size = 5;

  function checkLine(cells) {
    const line = cells.map(c => (c || '').toLowerCase());
    for (let start = 0; start < size; start++) {
      for (let end = start + 3; end <= size; end++) {
        const slice = line.slice(start, end);
        // skip if any cell in slice is empty
        if (slice.some(c => !c)) continue;
        const word = slice.join('');
        if (DICTIONARY.has(word)) {
          words.push({ word, score: word.length === 5 ? 10 : word.length });
        }
      }
    }
  }

  // Rows
  for (let r = 0; r < size; r++) {
    checkLine(grid.slice(r * size, r * size + size));
  }
  // Columns
  for (let c = 0; c < size; c++) {
    const col = [];
    for (let r = 0; r < size; r++) col.push(grid[r * size + c]);
    checkLine(col);
  }

  const total = words.reduce((sum, w) => sum + w.score, 0);
  return { words, total };
}

// ── Socket.io ─────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('connected:', socket.id);

  // CREATE ROOM
  socket.on('create_room', ({ playerName }) => {
    let roomId;
    do { roomId = generateRoomId(); } while (rooms[roomId]);

    rooms[roomId] = {
      id: roomId,
      hostId: socket.id,
      players: [{
        id: socket.id,
        name: playerName,
        board: null,
        score: null,
        words: null
      }],
      phase: 'lobby',       // lobby | playing | scoring
      turnOrder: [],
      currentTurnIndex: 0,
      calledLetters: [],    // [{letter, calledBy}]
      lettersLeft: 25
    };

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.playerName = playerName;

    socket.emit('room_created', { roomId, playerId: socket.id });
    socket.emit('room_state', sanitiseRoom(rooms[roomId]));
    console.log(`Room ${roomId} created by ${playerName}`);
  });

  // JOIN ROOM
  socket.on('join_room', ({ roomId, playerName }) => {
    const room = rooms[roomId];
    if (!room) return socket.emit('error', { message: 'Room not found.' });
    if (room.phase !== 'lobby') return socket.emit('error', { message: 'Game already in progress.' });
    if (room.players.length >= 50) return socket.emit('error', { message: 'Room is full.' });
    if (room.players.find(p => p.name === playerName)) {
      return socket.emit('error', { message: 'Name already taken in this room.' });
    }

    room.players.push({
      id: socket.id,
      name: playerName,
      board: null,
      score: null,
      words: null
    });

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.playerName = playerName;

    socket.emit('room_joined', { roomId, playerId: socket.id });
    io.to(roomId).emit('room_state', sanitiseRoom(room));
    console.log(`${playerName} joined room ${roomId}`);
  });

  // HOST STARTS GAME
  socket.on('start_game', (data) => {
    const turnTimer = data && data.turnTimer ? data.turnTimer : 0;
    const roomId = socket.data.roomId;
    const room = rooms[roomId];
    if (!room) return;
    if (room.hostId !== socket.id) return socket.emit('error', { message: 'Only the host can start.' });
    if (room.players.length < 2) return socket.emit('error', { message: 'Need at least 2 players.' });
    if (room.phase !== 'lobby') return;

    room.phase = 'playing';
    room.calledLetters = [];
    room.currentTurnIndex = 0;
    room.playersPlacedThisTurn = new Set();
    room.letterCalledThisTurn = false;
    room.turnTimer = turnTimer;
    if (room.turnTimeout) clearTimeout(room.turnTimeout);

    const TOTAL_TURNS = 25;
    room.lettersLeft = TOTAL_TURNS;

    let generatedTurnOrder = [];
    let playerIds = room.players.map(p => p.id);

    while (generatedTurnOrder.length < TOTAL_TURNS) {
      let shuffled = shuffle([...playerIds]);
      let needed = TOTAL_TURNS - generatedTurnOrder.length;
      generatedTurnOrder = generatedTurnOrder.concat(shuffled.slice(0, needed));
    }

    room.turnOrder = generatedTurnOrder;

    const currentPlayer = room.players.find(p => p.id === room.turnOrder[0]);
    io.to(roomId).emit('game_started', {
      turnOrder: room.turnOrder.map(id => room.players.find(p => p.id === id)?.name),
      currentTurn: {
        playerId: room.turnOrder[0],
        playerName: currentPlayer?.name
      },
      totalTurns: room.lettersLeft,
      turnTimer: room.turnTimer
    });

    startCallTimer(roomId, room, room.turnOrder[0]);
    console.log(`Game started in room ${roomId} with ${room.players.length} players. Timer: ${turnTimer}s`);
  });

  // PLAYER CALLS A LETTER
  socket.on('call_letter', ({ letter }) => {
    const roomId = socket.data.roomId;
    const room = rooms[roomId];
    if (!room || room.phase !== 'playing') return;

    const expectedId = room.turnOrder[room.currentTurnIndex];
    if (socket.id !== expectedId) return socket.emit('error', { message: "It's not your turn." });

    const l = letter.toUpperCase().trim();
    if (!/^[A-Z]$/.test(l)) return socket.emit('error', { message: 'Invalid letter.' });

    room.calledLetters.push({ letter: l, calledBy: socket.data.playerName });
    room.letterCalledThisTurn = true;
    room.playersPlacedThisTurn = new Set();

    io.to(roomId).emit('letter_called', {
      letter: l,
      calledBy: socket.data.playerName,
      calledLetters: room.calledLetters,
      turnsLeft: room.turnOrder.length - room.calledLetters.length,
      turnTimer: room.turnTimer
    });

    startPlaceTimer(roomId, room, l);
  });

  // PLAYER PLACES A LETTER
  socket.on('letter_placed', ({ grid }) => {
    const roomId = socket.data.roomId;
    const room = rooms[roomId];
    if (!room || room.phase !== 'playing') return;

    // Update server-side board state for this player
    const player = room.players.find(p => p.id === socket.id);
    if (player && Array.isArray(grid) && grid.length === 25) {
      player.board = grid;
    }

    room.playersPlacedThisTurn.add(socket.id);

    if (room.playersPlacedThisTurn.size >= room.players.length && room.letterCalledThisTurn) {
      advanceTurn(roomId, room);
    }
  });

  // DISCONNECT
  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    if (!roomId || !rooms[roomId]) return;
    const room = rooms[roomId];

    room.players = room.players.filter(p => p.id !== socket.id);
    console.log(`${socket.data.playerName} disconnected from ${roomId}`);

    if (room.players.length === 0) {
      delete rooms[roomId];
      console.log(`Room ${roomId} deleted (empty)`);
      return;
    }

    // Transfer host if needed
    if (room.hostId === socket.id) {
      room.hostId = room.players[0].id;
      io.to(roomId).emit('host_changed', { newHostId: room.hostId, newHostName: room.players[0].name });
    }

    io.to(roomId).emit('player_left', {
      playerName: socket.data.playerName,
      players: room.players.map(p => ({ id: p.id, name: p.name }))
    });

    // In playing phase, replace all future turns of the disconnected player with a random remaining player
    if (room.phase === 'playing') {
      const remainingIds = room.players.map(p => p.id);
      let wasTheirTurn = (room.turnOrder[room.currentTurnIndex] === socket.id);

      for (let i = room.currentTurnIndex; i < room.turnOrder.length; i++) {
        if (room.turnOrder[i] === socket.id) {
          room.turnOrder[i] = remainingIds[Math.floor(Math.random() * remainingIds.length)];
        }
      }

      if (wasTheirTurn && !room.letterCalledThisTurn) {
        const nextId = room.turnOrder[room.currentTurnIndex];
        const nextPlayer = room.players.find(p => p.id === nextId);
        io.to(roomId).emit('next_turn', {
          playerId: nextId,
          playerName: nextPlayer?.name,
          turnIndex: room.currentTurnIndex,
          totalTurns: room.turnOrder.length,
          turnTimer: room.turnTimer
        });
        startCallTimer(roomId, room, nextId);
      }

      if (room.letterCalledThisTurn) {
        if (room.playersPlacedThisTurn) room.playersPlacedThisTurn.delete(socket.id);
        if (room.playersPlacedThisTurn && room.playersPlacedThisTurn.size >= room.players.length) {
          advanceTurn(roomId, room);
        }
      }
    }
  });
});

function advanceTurn(roomId, room) {
  room.letterCalledThisTurn = false;
  room.currentTurnIndex++;
  const isLastTurn = room.currentTurnIndex >= room.turnOrder.length;

  if (room.turnTimeout) clearTimeout(room.turnTimeout);

  if (isLastTurn) {
    room.phase = 'scoring';
    scoreAllAndEnd(roomId, room);
  } else {
    const nextId = room.turnOrder[room.currentTurnIndex];
    const nextPlayer = room.players.find(p => p.id === nextId);
    io.to(roomId).emit('next_turn', {
      playerId: nextId,
      playerName: nextPlayer?.name,
      turnIndex: room.currentTurnIndex,
      totalTurns: room.turnOrder.length,
      turnTimer: room.turnTimer
    });
    startCallTimer(roomId, room, nextId);
  }
}

function scoreAllAndEnd(roomId, room) {
  room.players.forEach(p => {
    const { words, total } = scoreBoard(p.board || Array(25).fill(''));
    p.score = total;
    p.words = words;
  });

  const leaderboard = room.players
    .map(p => ({ name: p.name, score: p.score, words: p.words, board: p.board }))
    .sort((a, b) => b.score - a.score);

  io.to(roomId).emit('game_over', { leaderboard });
  console.log(`Game over in room ${roomId}`);
}

function startCallTimer(roomId, room, nextId) {
  if (room.turnTimeout) clearTimeout(room.turnTimeout);
  if (room.turnTimer > 0) {
    room.turnTimeout = setTimeout(() => {
      if (room.phase !== 'playing') return;
      const expectedId = room.turnOrder[room.currentTurnIndex];
      if (expectedId === nextId) {
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
        const randomLetter = alphabet[Math.floor(Math.random() * alphabet.length)];
        const p = room.players.find(pl => pl.id === nextId);
        const playerName = p ? p.name : 'Server';

        room.calledLetters.push({ letter: randomLetter, calledBy: playerName + ' (Auto)' });
        room.letterCalledThisTurn = true;
        room.playersPlacedThisTurn = new Set();

        io.to(roomId).emit('letter_called', {
          letter: randomLetter,
          calledBy: playerName + ' (Auto)',
          calledLetters: room.calledLetters,
          turnsLeft: room.turnOrder.length - room.calledLetters.length,
          turnTimer: room.turnTimer
        });

        startPlaceTimer(roomId, room, randomLetter);
      }
    }, room.turnTimer * 1000);
  }
}

function startPlaceTimer(roomId, room, letter) {
  if (room.turnTimeout) clearTimeout(room.turnTimeout);
  if (room.turnTimer > 0) {
    room.turnTimeout = setTimeout(() => {
      if (room.phase !== 'playing') return;
      io.to(roomId).emit('force_place', { letter });
      // Wait 600ms for clients to send their grids before scoring
      setTimeout(() => {
        if (room.phase !== 'playing') return;
        room.playersPlacedThisTurn = new Set(room.players.map(p => p.id));
        if (room.letterCalledThisTurn) {
          advanceTurn(roomId, room);
        }
      }, 600);
    }, room.turnTimer * 1000);
  }
}

function sanitiseRoom(room) {
  return {
    id: room.id,
    hostId: room.hostId,
    phase: room.phase,
    players: room.players.map(p => ({ id: p.id, name: p.name })),
    calledLetters: room.calledLetters,
    currentTurnIndex: room.currentTurnIndex,
    turnOrder: room.turnOrder
  };
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Wordsworth server running on port ${PORT}`));
