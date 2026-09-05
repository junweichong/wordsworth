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

function activePlayers(room) {
  return room.players.filter(player => !player.spectator);
}

function connectedActivePlayers(room) {
  return room.players.filter(player => !player.spectator && player.connected);
}

function emitPlacementStatus(roomId, room) {
  const active = activePlayers(room);
  const connectedActive = connectedActivePlayers(room);
  io.to(roomId).emit('placement_status', {
    turnId: room.activeTurnId,
    completedPlayerIds: [...(room.playersPlacedThisTurn || [])],
    players: room.players.map(player => {
      const isDisconnected = !player.connected;
      const timeLeft = isDisconnected && player.disconnectExpiresAt
        ? Math.max(0, Math.ceil((player.disconnectExpiresAt - Date.now()) / 1000))
        : 0;
      return {
        playerId: player.id,
        completed: player.spectator || room.playersPlacedThisTurn?.has(player.id) === true,
        disconnected: isDisconnected,
        reconnectTimeLeft: timeLeft,
        spectator: !!player.spectator
      };
    }),
    completed: room.playersPlacedThisTurn?.size || 0,
    total: connectedActive.length
  });
}

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

function getRandomEmptyIndex(board) {
  const currentBoard = Array.isArray(board) && board.length === 25
    ? board
    : Array(25).fill('');
  const emptyIndices = [];
  for (let i = 0; i < 25; i++) {
    if (!currentBoard[i]) emptyIndices.push(i);
  }
  if (emptyIndices.length === 0) return -1;
  return emptyIndices[Math.floor(Math.random() * emptyIndices.length)];
}

// Score a 5x5 board (array of 25 cells, row-major)
function scoreBoard(grid) {
  const words = [];
  const size = 5;

  function checkLine(cells, positions) {
    const line = cells.map(c => (c || '').toLowerCase());
    for (let start = 0; start < size; start++) {
      for (let end = start + 3; end <= size; end++) {
        const slice = line.slice(start, end);
        const slicePositions = positions.slice(start, end);
        // skip if any cell in slice is empty
        if (slice.some(c => !c)) continue;
        const word = slice.join('');
        const wordDefinitions = DICTIONARY.get(word);
        if (wordDefinitions) {
          words.push({
            word,
            score: word.length === 5 ? 10 : word.length,
            positions: slicePositions,
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
    const rowPositions = Array.from({ length: size }, (_, c) => r * size + c);
    checkLine(grid.slice(r * size, r * size + size), rowPositions);
  }
  // Columns
  for (let c = 0; c < size; c++) {
    const col = [];
    const colPositions = [];
    for (let r = 0; r < size; r++) {
      col.push(grid[r * size + c]);
      colPositions.push(r * size + c);
    }
    checkLine(col, colPositions);
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
        disconnectExpiresAt: null,
        board: null,
        score: null,
        words: null,
        spectator: false
      }],
      phase: 'lobby',       // lobby | playing | scoring
      turnOrder: [],
      currentTurnIndex: 0,
      calledLetters: [],    // [{letter, calledBy}]
      lettersLeft: 25,
      activeTurnId: null,
      finalTurnStarted: false,
      finalTurnSelections: new Map()
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
    const previousSocketId = player.socketId;
    if (player.disconnectTimer) {
      clearTimeout(player.disconnectTimer);
      player.disconnectTimer = null;
    }

    player.connected = true;
    player.socketId = socket.id;
    player.disconnectExpiresAt = null;

    if (previousSocketId && previousSocketId !== socket.id) {
      const previousSocket = io.sockets.sockets.get(previousSocketId);
      if (previousSocket) previousSocket.disconnect(true);
    }

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
      activeTurnId: room.activeTurnId || null,
      placementStatus: room.players.map(currentPlayer => {
        const isDisconnected = !currentPlayer.connected;
        const timeLeft = isDisconnected && currentPlayer.disconnectExpiresAt
          ? Math.max(0, Math.ceil((currentPlayer.disconnectExpiresAt - Date.now()) / 1000))
          : 0;
        return {
          playerId: currentPlayer.id,
          completed: currentPlayer.spectator || room.playersPlacedThisTurn?.has(currentPlayer.id) === true,
          disconnected: isDisconnected,
          reconnectTimeLeft: timeLeft,
          spectator: !!currentPlayer.spectator
        };
      }),
      placedThisTurn: hasPlacedThisTurn,
      letterCalledThisTurn: room.letterCalledThisTurn || false,
      finalTurnStarted: room.finalTurnStarted || false,
      spectator: !!player.spectator,
      leaderboard: room.phase === 'scoring'
        ? activePlayers(room)
          .map(p => ({ name: p.name, score: p.score, words: p.words, board: p.board }))
          .sort((a, b) => (b.score || 0) - (a.score || 0))
        : null
    });

    const host = room.players.find(p => p.id === room.hostId && p.connected);
    if (host && host.socketId) {
      io.to(host.socketId).emit('player_reconnected', {
        playerId: player.id,
        playerName: player.name,
        players: sanitiseRoom(room).players
      });
    }
    emitPlacementStatus(room.id, room);

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
      disconnectExpiresAt: null,
      board: null,
      score: null,
      words: null,
      spectator: false
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

  function handleActivePlayerRemoval(roomId, room, playerId) {
    if (room.phase !== 'playing') return;

    const remainingActive = activePlayers(room);
    const remainingIds = remainingActive.map(p => p.id);

    if (remainingIds.length === 0) {
      if (room.turnTimeout) clearTimeout(room.turnTimeout);
      if (room.finalTurnTimeout) clearTimeout(room.finalTurnTimeout);
      delete rooms[roomId];
      console.log(`Room ${roomId} deleted (no active players left)`);
      return;
    }

    let wasTheirTurn = (room.turnOrder && room.turnOrder[room.currentTurnIndex] === playerId);

    if (room.turnOrder) {
      for (let i = room.currentTurnIndex; i < room.turnOrder.length; i++) {
        if (room.turnOrder[i] === playerId) {
          room.turnOrder[i] = remainingIds[Math.floor(Math.random() * remainingIds.length)];
        }
      }
    }

    if (room.finalTurnStarted) {
      if (room.finalTurnSelections) room.finalTurnSelections.delete(playerId);
      const connectedActive = connectedActivePlayers(room);
      if (room.finalTurnSelections && room.finalTurnSelections.size >= connectedActive.length) {
        finishFinalTurnAndScore(roomId, room);
      }
    } else {
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
        if (room.playersPlacedThisTurn) room.playersPlacedThisTurn.delete(playerId);
        const connectedActive = connectedActivePlayers(room);
        if (room.playersPlacedThisTurn && room.playersPlacedThisTurn.size >= connectedActive.length) {
          resolveTurnPlacements(roomId, room, room.activeTurnId);
        }
      }
    }

    emitPlacementStatus(roomId, room);
  }

  // LEAVE ROOM
  socket.on('leave_room', () => {
    const roomId = socket.data.roomId;
    const playerId = socket.data.playerId;
    const room = rooms[roomId];
    if (!room || !playerId) return;

    const playerIndex = room.players.findIndex(player => player.id === playerId);
    if (playerIndex === -1) return;

    const [leavingPlayer] = room.players.splice(playerIndex, 1);
    if (leavingPlayer.disconnectTimer) clearTimeout(leavingPlayer.disconnectTimer);
    socket.leave(roomId);
    socket.data.roomId = null;
    socket.data.playerId = null;
    socket.data.playerName = null;

    console.log(`${leavingPlayer.name} (${leavingPlayer.id}) left room ${roomId}`);

    if (room.players.length === 0) {
      if (room.turnTimeout) clearTimeout(room.turnTimeout);
      if (room.finalTurnTimeout) clearTimeout(room.finalTurnTimeout);
      delete rooms[roomId];
      console.log(`Room ${roomId} deleted (empty)`);
      return;
    }

    if (room.hostId === playerId) {
      const nextHost = room.players.find(player => player.connected) || room.players[0];
      room.hostId = nextHost.id;
      io.to(roomId).emit('host_changed', {
        newHostId: nextHost.id,
        newHostName: nextHost.name
      });
    }

    io.to(roomId).emit('player_left', {
      playerName: leavingPlayer.name,
      players: sanitiseRoom(room).players
    });

    handleActivePlayerRemoval(roomId, room, playerId);
  });

  // HOST KICKS A PLAYER
  socket.on('kick_player', ({ targetPlayerId }) => {
    const roomId = socket.data.roomId;
    const room = rooms[roomId];
    if (!room) return;

    if (room.hostId !== socket.data.playerId) {
      return socket.emit('error', { message: 'Only the host can kick players.' });
    }
    if (targetPlayerId === room.hostId) {
      return socket.emit('error', { message: 'Host cannot kick themselves.' });
    }

    const playerIndex = room.players.findIndex(p => p.id === targetPlayerId);
    if (playerIndex === -1) return;

    const [kickedPlayer] = room.players.splice(playerIndex, 1);
    if (kickedPlayer.disconnectTimer) clearTimeout(kickedPlayer.disconnectTimer);

    if (kickedPlayer.socketId) {
      const kickedSocket = io.sockets.sockets.get(kickedPlayer.socketId);
      if (kickedSocket) {
        kickedSocket.leave(roomId);
        kickedSocket.data.roomId = null;
        kickedSocket.data.playerId = null;
        kickedSocket.data.playerName = null;
        kickedSocket.emit('kicked_from_room', { message: 'You have been kicked by the host.' });
      }
    }

    io.to(roomId).emit('player_kicked', {
      kickedPlayerId: targetPlayerId,
      kickedPlayerName: kickedPlayer.name,
      players: sanitiseRoom(room).players
    });

    console.log(`${kickedPlayer.name} (${kickedPlayer.id}) was kicked from room ${roomId} by host`);

    handleActivePlayerRemoval(roomId, room, targetPlayerId);
  });

  // HOST STARTS GAME
  socket.on('start_game', (data) => {
    const turnTimer = data && data.turnTimer ? data.turnTimer : 0;
    const spectatorHost = data && data.spectatorHost === true;
    const roomId = socket.data.roomId;
    const room = rooms[roomId];
    if (!room) return;
    if (room.hostId !== socket.data.playerId) return socket.emit('error', { message: 'Only the host can start.' });
    const activePlayerCount = room.players.length - (spectatorHost ? 1 : 0);
    if (activePlayerCount < 2) return socket.emit('error', { message: 'Need at least 2 active players.' });
    if (room.phase !== 'lobby') return;

    room.phase = 'playing';
    room.players.forEach(player => { player.spectator = spectatorHost && player.id === socket.data.playerId; });
    room.calledLetters = [];
    room.currentTurnIndex = 0;
    room.playersPlacedThisTurn = new Set();
    room.letterCalledThisTurn = false;
    room.activeTurnId = null;
    room.turnTimer = turnTimer;
    room.finalTurnStarted = false;
    room.finalTurnSelections = new Map();
    if (room.turnTimeout) clearTimeout(room.turnTimeout);
    if (room.finalTurnTimeout) clearTimeout(room.finalTurnTimeout);

    const TOTAL_TURNS = 24;
    room.lettersLeft = TOTAL_TURNS;

    let generatedTurnOrder = [];
    let playerIds = activePlayers(room).map(p => p.id);

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
      turnTimer: room.turnTimer,
      spectatorHost
    });

    startCallTimer(roomId, room, room.turnOrder[0]);
    emitPlacementStatus(roomId, room);
    console.log(`Game started in room ${roomId} with ${room.players.length} players. Timer: ${turnTimer}s`);
  });

  // PLAYER CALLS A LETTER
  socket.on('call_letter', ({ letter }) => {
    const roomId = socket.data.roomId;
    const room = rooms[roomId];
    if (!room || room.phase !== 'playing') return;
    if (room.finalTurnStarted) {
      return socket.emit('error', { message: 'The final letter is personal to each player.' });
    }
    if (room.letterCalledThisTurn) {
      return socket.emit('error', { message: 'A letter has already been called for this turn.' });
    }

    const expectedId = room.turnOrder[room.currentTurnIndex];
    if (socket.data.playerId !== expectedId) return socket.emit('error', { message: "It's not your turn." });

    const l = letter.toUpperCase().trim();
    if (!/^[A-Z]$/.test(l)) return socket.emit('error', { message: 'Invalid letter.' });

    const turnId = `${room.currentTurnIndex}-${room.calledLetters.length + 1}`;
    room.activeTurnId = turnId;
    room.currentLetter = l;
    room.calledLetters.push({ letter: l, calledBy: socket.data.playerName, turnId });
    room.letterCalledThisTurn = true;
    room.playersPlacedThisTurn = new Set();

    io.to(roomId).emit('letter_called', {
      letter: l,
      calledBy: socket.data.playerName,
      calledLetters: room.calledLetters,
      turnId,
      turnsLeft: room.turnOrder.length - room.calledLetters.length,
      turnTimer: room.turnTimer
    });
    emitPlacementStatus(roomId, room);

    startPlaceTimer(roomId, room, l, turnId);
  });

  socket.on('final_letter_choice', ({ letter }) => {
    const roomId = socket.data.roomId;
    const room = rooms[roomId];
    if (!room || !room.finalTurnStarted || room.phase !== 'playing') return;

    const player = room.players.find(p => p.id === socket.data.playerId);
    if (!player) return;
    if (player.spectator) return socket.emit('error', { message: 'Spectators cannot choose letters.' });

    const l = String(letter || '').toUpperCase().trim();
    if (!/^[A-Z]$/.test(l)) return socket.emit('error', { message: 'Invalid final letter.' });
    if (room.finalTurnSelections.has(player.id)) {
      return socket.emit('error', { message: 'You already chose your final letter.' });
    }

    const emptyIndex = (player.board || []).findIndex(cell => !cell);
    if (emptyIndex === -1) {
      return socket.emit('error', { message: 'No empty cells left on your board.' });
    }

    player.board[emptyIndex] = l;
    room.finalTurnSelections.set(player.id, l);

    const connectedActive = connectedActivePlayers(room);
    io.to(roomId).emit('final_letter_confirmed', {
      playerId: player.id,
      playerName: player.name,
      letter: l,
      grid: player.board || Array(25).fill(''),
      emptyIndex,
      remaining: connectedActive.length - room.finalTurnSelections.size,
      allChosen: room.finalTurnSelections.size >= connectedActive.length
    });

    if (room.finalTurnSelections.size >= connectedActive.length) {
      finishFinalTurnAndScore(roomId, room);
    }
  });

  // PLAYER PLACES A LETTER
  socket.on('letter_placed', ({ grid, turnId }) => {
    const roomId = socket.data.roomId;
    const room = rooms[roomId];
    if (!room || room.phase !== 'playing') return;
    if (room.finalTurnStarted) return;

    const player = room.players.find(p => p.id === socket.data.playerId);
    if (!player || player.spectator || !room.letterCalledThisTurn || turnId !== room.activeTurnId) return;
    if (room.playersPlacedThisTurn.has(player.id)) return;
    if (!isValidPlacement(player.board, grid, room.currentLetter)) {
      return socket.emit('error', { message: 'Invalid placement for this turn.', rollback: true, grid: player.board || Array(25).fill('') });
    }

    player.board = grid.slice();
    room.playersPlacedThisTurn.add(player.id);
    emitPlacementStatus(roomId, room);

    const connectedActive = connectedActivePlayers(room);
    if (room.playersPlacedThisTurn.size >= connectedActive.length) {
      resolveTurnPlacements(roomId, room, turnId);
    }
  });

  function isValidPlacement(previousGrid, nextGrid, letter) {
    if (!Array.isArray(nextGrid) || nextGrid.length !== 25 || !/^[A-Z]$/.test(letter || '')) return false;
    if (nextGrid.some(cell => cell !== '' && !/^[A-Z]$/.test(cell))) return false;

    const previous = Array.isArray(previousGrid) && previousGrid.length === 25
      ? previousGrid
      : Array(25).fill('');
    let changedIndex = -1;
    for (let index = 0; index < 25; index++) {
      if (nextGrid[index] !== previous[index]) {
        if (changedIndex !== -1 || previous[index] !== '' || nextGrid[index] !== letter) return false;
        changedIndex = index;
      }
    }
    return changedIndex !== -1;
  }

  // DISCONNECT
  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    const playerId = socket.data.playerId;
    if (!roomId || !rooms[roomId] || !playerId) return;

    const room = rooms[roomId];
    const player = room.players.find(p => p.id === playerId);
    if (!player) return;
    if (player.socketId !== socket.id) return;

    player.connected = false;
    player.disconnectExpiresAt = Date.now() + GRACE_PERIOD_MS;
    console.log(`${player.name} (${player.id}) temporarily disconnected from ${roomId}`);

    const host = room.players.find(p => p.id === room.hostId && p.connected);
    if (host && host.socketId) {
      io.to(host.socketId).emit('player_disconnected', {
        playerId: player.id,
        playerName: player.name,
        players: sanitiseRoom(room).players,
        reconnectTimeLeft: Math.ceil(GRACE_PERIOD_MS / 1000)
      });
    }

    emitPlacementStatus(roomId, room);

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
          const connectedActive = connectedActivePlayers(currentRoom);
          if (currentRoom.playersPlacedThisTurn && currentRoom.playersPlacedThisTurn.size >= connectedActive.length) {
            resolveTurnPlacements(roomId, currentRoom, currentRoom.activeTurnId);
          }
        }
      }
    }, GRACE_PERIOD_MS);
  });
});

function finishFinalTurnAndScore(roomId, room) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  activePlayers(room).forEach(player => {
    if (room.finalTurnSelections.has(player.id)) return;
    const board = Array.isArray(player.board) && player.board.length === 25
      ? player.board.slice()
      : Array(25).fill('');
    const randomIndex = getRandomEmptyIndex(board);
    const fallbackLetter = alphabet[Math.floor(Math.random() * alphabet.length)];
    if (randomIndex !== -1) board[randomIndex] = fallbackLetter;
    player.board = board;
    room.finalTurnSelections.set(player.id, fallbackLetter);
  });
  scoreAllAndEnd(roomId, room);
}

function resolveTurnPlacements(roomId, room, turnId) {
  if (!room.letterCalledThisTurn || room.activeTurnId !== turnId) return;

  const missingPlayers = activePlayers(room).filter(player => !room.playersPlacedThisTurn.has(player.id));
  for (const player of missingPlayers) {
    const board = Array.isArray(player.board) && player.board.length === 25
      ? player.board.slice()
      : Array(25).fill('');
    const randomIndex = getRandomEmptyIndex(board);
    if (randomIndex !== -1) board[randomIndex] = room.currentLetter;
    player.board = board;
    room.playersPlacedThisTurn.add(player.id);
    if (player.connected && player.socketId) {
      io.to(player.socketId).emit('placement_applied', {
        turnId,
        letter: room.currentLetter,
        grid: board,
        automatic: true
      });
    }
  }

  // Safety verification: Ensure all active boards have exact letter count parity
  const targetCount = room.calledLetters.length;
  for (const player of activePlayers(room)) {
    const currentPlaced = (player.board || []).filter(cell => !!cell).length;
    if (currentPlaced < targetCount) {
      const board = Array.isArray(player.board) && player.board.length === 25
        ? player.board.slice()
        : Array(25).fill('');
      const randomIndex = getRandomEmptyIndex(board);
      if (randomIndex !== -1) board[randomIndex] = room.currentLetter;
      player.board = board;
    }
  }

  emitPlacementStatus(roomId, room);
  advanceTurn(roomId, room, turnId);
}

function advanceTurn(roomId, room, turnId) {
  if (turnId && room.activeTurnId !== turnId) return;
  room.letterCalledThisTurn = false;
  room.activeTurnId = null;
  room.currentLetter = null;
  room.currentTurnIndex++;
  const isLastTurn = room.currentTurnIndex >= room.turnOrder.length;

  if (room.turnTimeout) clearTimeout(room.turnTimeout);

  if (room.finalTurnStarted) return;

  if (isLastTurn) {
    startFinalLetterTurn(roomId, room);
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

function startFinalLetterTurn(roomId, room) {
  if (room.finalTurnStarted) return;

  room.phase = 'playing';
  room.finalTurnStarted = true;
  room.finalTurnSelections = new Map();
  if (room.turnTimeout) clearTimeout(room.turnTimeout);
  if (room.finalTurnTimeout) clearTimeout(room.finalTurnTimeout);

  io.to(roomId).emit('final_turn_started', {
    turnTimer: room.turnTimer,
    message: 'Final turn — choose your own last letter for the final empty cell.'
  });

  if (room.turnTimer > 0) {
    startFinalTurnTimeout(roomId, room);
  }

  console.log(`Final letter phase started in room ${roomId}`);
}

function startFinalTurnTimeout(roomId, room) {
  if (room.finalTurnTimeout) return;

  room.finalTurnTimeout = setTimeout(() => {
    if (room.phase !== 'playing' || !room.finalTurnStarted) return;
    room.finalTurnTimeout = null;

    activePlayers(room).forEach(player => {
      if (room.finalTurnSelections.has(player.id)) return;
      const board = Array.isArray(player.board) && player.board.length === 25
        ? player.board.slice()
        : Array(25).fill('');
      const randomIndex = getRandomEmptyIndex(board);
      const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
      const fallbackLetter = alphabet[Math.floor(Math.random() * alphabet.length)];
      if (randomIndex !== -1) board[randomIndex] = fallbackLetter;
      player.board = board;
      room.finalTurnSelections.set(player.id, fallbackLetter);
      io.to(roomId).emit('final_letter_confirmed', {
        playerId: player.id,
        playerName: player.name,
        letter: fallbackLetter,
        grid: player.board || Array(25).fill(''),
        emptyIndex: randomIndex === -1 ? null : randomIndex,
        remaining: room.players.length - room.finalTurnSelections.size,
        allChosen: room.finalTurnSelections.size >= room.players.length
      });
    });

    finishFinalTurnAndScore(roomId, room);
  }, room.turnTimer * 1000);
}

function scoreAllAndEnd(roomId, room) {
  activePlayers(room).forEach(p => {
    const { words, total } = scoreBoard(p.board || Array(25).fill(''));
    p.score = total;
    p.words = words;
  });

  const leaderboard = activePlayers(room)
    .map(p => ({ name: p.name, score: p.score, words: p.words, board: p.board }))
    .sort((a, b) => b.score - a.score);

  room.phase = 'scoring';
  room.finalTurnStarted = false;
  room.finalTurnSelections = new Map();
  if (room.finalTurnTimeout) clearTimeout(room.finalTurnTimeout);
  room.finalTurnTimeout = null;

  io.to(roomId).emit('game_over', { leaderboard });
  console.log(`Game over in room ${roomId}`);
}

function startCallTimer(roomId, room, nextId) {
  if (room.turnTimeout) clearTimeout(room.turnTimeout);
  if (room.turnTimer > 0) {
    room.turnTimeout = setTimeout(() => {
      if (room.phase !== 'playing') return;
      if (room.letterCalledThisTurn) return;
      const expectedId = room.turnOrder[room.currentTurnIndex];
      if (expectedId === nextId) {
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
        const randomLetter = alphabet[Math.floor(Math.random() * alphabet.length)];
        const p = room.players.find(pl => pl.id === nextId);
        const playerName = p ? p.name : 'Server';

        const turnId = `${room.currentTurnIndex}-${room.calledLetters.length + 1}`;
        room.activeTurnId = turnId;
        room.currentLetter = randomLetter;
        room.calledLetters.push({ letter: randomLetter, calledBy: playerName + ' (Auto)', turnId });
        room.letterCalledThisTurn = true;
        room.playersPlacedThisTurn = new Set();

        io.to(roomId).emit('letter_called', {
          letter: randomLetter,
          calledBy: playerName + ' (Auto)',
          calledLetters: room.calledLetters,
          turnId,
          turnsLeft: room.turnOrder.length - room.calledLetters.length,
          turnTimer: room.turnTimer
        });
        emitPlacementStatus(roomId, room);

        startPlaceTimer(roomId, room, randomLetter, turnId);
      }
    }, room.turnTimer * 1000);
  }
}

function startPlaceTimer(roomId, room, letter, turnId) {
  if (room.turnTimeout) clearTimeout(room.turnTimeout);
  if (room.turnTimer > 0) {
    room.turnTimeout = setTimeout(() => {
      if (room.phase !== 'playing' || !room.letterCalledThisTurn || room.activeTurnId !== turnId) return;
      io.to(roomId).emit('force_place', { letter });
      resolveTurnPlacements(roomId, room, turnId);
    }, room.turnTimer * 1000);
  }
}

function sanitiseRoom(room) {
  return {
    id: room.id,
    hostId: room.hostId,
    phase: room.phase,
    players: room.players.map(p => ({ id: p.id, name: p.name, connected: p.connected !== false, spectator: !!p.spectator })),
    calledLetters: room.calledLetters,
    currentTurnIndex: room.currentTurnIndex,
    turnOrder: room.turnOrder
  };
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Wordsworth server running on port ${PORT}`));

