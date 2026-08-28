const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 60000,
  pingInterval: 25000
});

app.use(express.static(path.join(__dirname, 'public')));

// ── In-memory store ──────────────────────────────────────────────
const rooms = {};
const GRACE_PERIOD_MS = 120000;

// ── Local dictionary ────────────────────────────────────────────
const definitions = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'definitions.json'), 'utf8')
);
const DICTIONARY = new Map(
  Object.entries(definitions)
    .map(([word, wordDefinitions]) => [
      word.trim().toLowerCase(),
      Array.isArray(wordDefinitions)
        ? wordDefinitions.filter(definition => typeof definition === 'string' && definition.trim())
        : []
    ])
    .filter(([word, wordDefinitions]) => word.length >= 3 && wordDefinitions.length > 0)
);
console.log(`Dictionary loaded: ${DICTIONARY.size} words with local definitions`);

// ── Helpers ──────────────────────────────────────────────────────
function generateRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 4; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

function generatePlayerId() {
  return 'p_' + Math.random().toString(36).substring(2, 10);
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
        const wordDefinitions = DICTIONARY.get(word);
        if (wordDefinitions) {
          words.push({
            word,
            score: word.length === 5 ? 10 : word.length,
            meanings: [{
              partOfSpeech: 'definition',
              definitions: wordDefinitions.slice(0, 2)
            }]
          });
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

    const playerId = generatePlayerId();

    rooms[roomId] = {
      id: roomId,
      hostId: playerId,
      players: [{
        id: playerId,
        socketId: socket.id,
        name: playerName,
        connected: true,
        disconnectTimer: null,
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
    socket.data.playerId = playerId;
    socket.data.playerName = playerName;

    socket.emit('room_created', { roomId, playerId, playerName });
    socket.emit('room_state', sanitiseRoom(rooms[roomId]));
    console.log(`Room ${roomId} created by ${playerName} (${playerId})`);
  });

  function rejoinPlayer(socket, room, player) {
    if (player.disconnectTimer) {
      clearTimeout(player.disconnectTimer);
      player.disconnectTimer = null;
    }

    player.connected = true;
    player.socketId = socket.id;

    socket.join(room.id);
    socket.data.roomId = room.id;
    socket.data.playerId = player.id;
    socket.data.playerName = player.name;

    const currentTurnPlayer = room.turnOrder ? room.players.find(p => p.id === room.turnOrder[room.currentTurnIndex]) : null;
    const hasPlacedThisTurn = room.playersPlacedThisTurn ? room.playersPlacedThisTurn.has(player.id) : false;
    const lastCalled = room.calledLetters && room.calledLetters.length > 0 ? room.calledLetters[room.calledLetters.length - 1] : null;

    socket.emit('rejoined_success', {
      roomId: room.id,
      playerId: player.id,
      playerName: player.name,
      isHost: room.hostId === player.id,
      hostId: room.hostId,
      phase: room.phase,
      players: sanitiseRoom(room).players,
      grid: player.board || Array(25).fill(''),
      calledLetters: room.calledLetters || [],
      currentTurnPlayerId: currentTurnPlayer ? currentTurnPlayer.id : null,
      currentTurnPlayerName: currentTurnPlayer ? currentTurnPlayer.name : null,
      turnIndex: room.currentTurnIndex || 0,
      totalTurns: room.turnOrder ? room.turnOrder.length : 0,
      turnTimer: room.turnTimer || 0,
      currentLetter: room.letterCalledThisTurn && lastCalled ? lastCalled.letter : null,
      currentLetterCaller: room.letterCalledThisTurn && lastCalled ? lastCalled.calledBy : null,
      placedThisTurn: hasPlacedThisTurn,
      letterCalledThisTurn: room.letterCalledThisTurn || false
    });

    io.to(room.id).emit('player_reconnected', {
      playerId: player.id,
      playerName: player.name,
      players: sanitiseRoom(room).players
    });

    console.log(`${player.name} (${player.id}) reconnected to room ${room.id}`);
  }

  // JOIN ROOM
  socket.on('join_room', ({ roomId, playerName }) => {
    const room = rooms[roomId];
    if (!room) return socket.emit('error', { message: 'Room not found.' });

    const existingPlayer = room.players.find(p => p.name.trim().toLowerCase() === playerName.trim().toLowerCase());

    if (room.phase !== 'lobby') {
      if (existingPlayer && !existingPlayer.connected) {
        return rejoinPlayer(socket, room, existingPlayer);
      }
      return socket.emit('error', { message: 'Game already in progress. New players cannot join.' });
    }

    if (room.players.length >= 50) return socket.emit('error', { message: 'Room is full.' });
    if (existingPlayer) {
      if (!existingPlayer.connected) {
        return rejoinPlayer(socket, room, existingPlayer);
      }
      return socket.emit('error', { message: 'Name already taken in this room.' });
    }

    const playerId = generatePlayerId();

    room.players.push({
      id: playerId,
      socketId: socket.id,
      name: playerName,
      connected: true,
      disconnectTimer: null,
      board: null,
      score: null,
      words: null
    });

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.playerId = playerId;
    socket.data.playerName = playerName;

    socket.emit('room_joined', { roomId, playerId, playerName });
    io.to(roomId).emit('room_state', sanitiseRoom(room));
    console.log(`${playerName} (${playerId}) joined room ${roomId}`);
  });

  // REJOIN ROOM (Session Restore)
  socket.on('rejoin_room', ({ roomId, playerId, playerName }) => {
    const room = rooms[roomId];
    if (!room) {
      return socket.emit('rejoin_failed', { message: 'Room no longer exists.' });
    }

    const player = room.players.find(p => p.id === playerId || (p.name.trim().toLowerCase() === playerName.trim().toLowerCase() && !p.connected));
    if (!player) {
      return socket.emit('rejoin_failed', { message: 'Session expired or player not in room.' });
    }

    rejoinPlayer(socket, room, player);
  });

  // HOST STARTS GAME
  socket.on('start_game', (data) => {
    const turnTimer = data && data.turnTimer ? data.turnTimer : 0;
    const roomId = socket.data.roomId;
    const room = rooms[roomId];
    if (!room) return;
    if (room.hostId !== socket.data.playerId) return socket.emit('error', { message: 'Only the host can start.' });
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
    if (socket.data.playerId !== expectedId) return socket.emit('error', { message: "It's not your turn." });

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
    const player = room.players.find(p => p.id === socket.data.playerId);
    if (player && Array.isArray(grid) && grid.length === 25) {
      player.board = grid;
    }

    if (socket.data.playerId) {
      room.playersPlacedThisTurn.add(socket.data.playerId);
    }

    if (room.playersPlacedThisTurn.size >= room.players.length && room.letterCalledThisTurn) {
      advanceTurn(roomId, room);
    }
  });

  // DISCONNECT
  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    const playerId = socket.data.playerId;
    if (!roomId || !rooms[roomId] || !playerId) return;

    const room = rooms[roomId];
    const player = room.players.find(p => p.id === playerId);
    if (!player) return;

    player.connected = false;
    console.log(`${player.name} (${player.id}) temporarily disconnected from ${roomId}`);

    io.to(roomId).emit('player_disconnected', {
      playerId: player.id,
      playerName: player.name,
      players: sanitiseRoom(room).players
    });

    // Start 45-second grace period timer for player to reconnect
    player.disconnectTimer = setTimeout(() => {
      if (!rooms[roomId]) return;
      const currentRoom = rooms[roomId];
      const pIndex = currentRoom.players.findIndex(p => p.id === playerId);
      if (pIndex === -1) return;

      const targetPlayer = currentRoom.players[pIndex];
      if (targetPlayer.connected) return; // Player reconnected in time!

      currentRoom.players.splice(pIndex, 1);
      console.log(`${targetPlayer.name} grace period expired. Permanently removed from ${roomId}`);

      if (currentRoom.players.length === 0) {
        delete rooms[roomId];
        console.log(`Room ${roomId} deleted (empty)`);
        return;
      }

      // Transfer host if host was disconnected permanently
      if (currentRoom.hostId === playerId) {
        const nextHost = currentRoom.players.find(pl => pl.connected) || currentRoom.players[0];
        currentRoom.hostId = nextHost.id;
        io.to(roomId).emit('host_changed', { newHostId: currentRoom.hostId, newHostName: nextHost.name });
      }

      io.to(roomId).emit('player_left', {
        playerName: targetPlayer.name,
        players: sanitiseRoom(currentRoom).players
      });

      // In playing phase, replace future turns of permanently disconnected player
      if (currentRoom.phase === 'playing') {
        const remainingIds = currentRoom.players.map(p => p.id);
        let wasTheirTurn = (currentRoom.turnOrder[currentRoom.currentTurnIndex] === playerId);

        for (let i = currentRoom.currentTurnIndex; i < currentRoom.turnOrder.length; i++) {
          if (currentRoom.turnOrder[i] === playerId) {
            currentRoom.turnOrder[i] = remainingIds[Math.floor(Math.random() * remainingIds.length)];
          }
        }

        if (wasTheirTurn && !currentRoom.letterCalledThisTurn) {
          const nextId = currentRoom.turnOrder[currentRoom.currentTurnIndex];
          const nextPlayer = currentRoom.players.find(p => p.id === nextId);
          io.to(roomId).emit('next_turn', {
            playerId: nextId,
            playerName: nextPlayer?.name,
            turnIndex: currentRoom.currentTurnIndex,
            totalTurns: currentRoom.turnOrder.length,
            turnTimer: currentRoom.turnTimer
          });
          startCallTimer(roomId, currentRoom, nextId);
        }

        if (currentRoom.letterCalledThisTurn) {
          if (currentRoom.playersPlacedThisTurn) currentRoom.playersPlacedThisTurn.delete(playerId);
          if (currentRoom.playersPlacedThisTurn && currentRoom.playersPlacedThisTurn.size >= currentRoom.players.length) {
            advanceTurn(roomId, currentRoom);
          }
        }
      }
    }, GRACE_PERIOD_MS);
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
    players: room.players.map(p => ({ id: p.id, name: p.name, connected: p.connected !== false })),
    calledLetters: room.calledLetters,
    currentTurnIndex: room.currentTurnIndex,
    turnOrder: room.turnOrder
  };
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Wordsworth server running on port ${PORT}`));

