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

// ── Word list (built-in common English words, 3+ letters) ────────
// We ship a small but solid dictionary. For production, swap with
// a full /usr/share/dict/words file or a words npm package.
let DICTIONARY = new Set();
try {
  const raw = fs.readFileSync(path.join(__dirname, 'words.txt'), 'utf8');
  raw.split('\n').forEach(w => {
    w = w.trim().toLowerCase();
    if (w.length >= 3) DICTIONARY.add(w);
  });
  console.log(`Dictionary loaded: ${DICTIONARY.size} words`);
} catch (e) {
  console.warn('words.txt not found — using fallback mini-dictionary');
  // Fallback: a small set so the game still runs
  const fallback = ['the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had',
    'her', 'was', 'one', 'our', 'out', 'day', 'get', 'has', 'him', 'his', 'how', 'its', 'now',
    'old', 'see', 'two', 'way', 'who', 'boy', 'did', 'does', 'got', 'let', 'man', 'new', 'put',
    'say', 'she', 'too', 'use', 'cat', 'dog', 'run', 'sat', 'hit', 'big', 'cup', 'fun', 'hot',
    'ice', 'jar', 'key', 'law', 'map', 'net', 'oak', 'pan', 'rat', 'sun', 'tax', 'van', 'wax',
    'zip', 'able', 'area', 'army', 'away', 'baby', 'back', 'ball', 'band', 'bank', 'base',
    'bath', 'bear', 'beat', 'been', 'bell', 'best', 'bird', 'blow', 'blue', 'boat', 'body',
    'bomb', 'bond', 'bone', 'book', 'bore', 'born', 'both', 'bowl', 'burn', 'call', 'came',
    'card', 'care', 'case', 'cash', 'cast', 'cave', 'cell', 'chat', 'chin', 'chip', 'city',
    'clap', 'clay', 'clip', 'club', 'coal', 'coat', 'code', 'coin', 'cold', 'come', 'cook',
    'cool', 'cope', 'copy', 'cord', 'core', 'corn', 'cost', 'coup', 'crew', 'crop', 'cure',
    'dark', 'data', 'date', 'dawn', 'dead', 'deal', 'dear', 'debt', 'deep', 'deny', 'desk',
    'diet', 'dirt', 'disk', 'door', 'dose', 'down', 'draw', 'drew', 'drop', 'drug', 'drum',
    'dual', 'dull', 'dumb', 'dump', 'dust', 'duty', 'each', 'earn', 'ease', 'east', 'edge',
    'else', 'even', 'ever', 'evil', 'exam', 'face', 'fact', 'fail', 'fair', 'fall', 'fame',
    'farm', 'fast', 'fate', 'fear', 'feel', 'feet', 'fell', 'felt', 'file', 'fill', 'film',
    'find', 'fine', 'fire', 'firm', 'fish', 'fist', 'five', 'flag', 'flat', 'flew', 'flip',
    'flow', 'foam', 'fold', 'folk', 'fond', 'font', 'food', 'fool', 'foot', 'ford', 'fore',
    'fork', 'form', 'fort', 'foul', 'four', 'free', 'from', 'full', 'fund', 'fury', 'fuse',
    'gain', 'game', 'gang', 'gave', 'gear', 'gene', 'gift', 'girl', 'give', 'glad', 'glow',
    'glue', 'goal', 'goes', 'gold', 'golf', 'gone', 'good', 'grab', 'gray', 'grew', 'grid',
    'grip', 'grow', 'gulf', 'guru', 'gust', 'guys', 'hack', 'half', 'hall', 'hand', 'hang',
    'hard', 'harm', 'hate', 'have', 'head', 'heal', 'heap', 'hear', 'heat', 'heel', 'held',
    'help', 'here', 'hero', 'hide', 'high', 'hill', 'hint', 'hire', 'hold', 'hole', 'home',
    'hook', 'hope', 'horn', 'host', 'hour', 'huge', 'hung', 'hunt', 'hurt', 'idea', 'idle',
    'inch', 'info', 'into', 'iron', 'item', 'join', 'joke', 'jump', 'just', 'keen', 'kept',
    'kick', 'kill', 'kind', 'king', 'kiss', 'knee', 'knew', 'know', 'lack', 'laid', 'lake',
    'land', 'lane', 'last', 'late', 'lead', 'leaf', 'lean', 'left', 'lend', 'lens', 'less',
    'lied', 'life', 'lift', 'like', 'lime', 'line', 'link', 'lion', 'list', 'live', 'load',
    'loan', 'lock', 'loft', 'long', 'look', 'loop', 'lord', 'lose', 'loss', 'lost', 'loud',
    'love', 'luck', 'lung', 'made', 'mail', 'main', 'make', 'mall', 'many', 'mark', 'mass',
    'mate', 'math', 'meal', 'mean', 'meat', 'meet', 'melt', 'memo', 'mere', 'mesh', 'mild',
    'mile', 'milk', 'mill', 'mind', 'mine', 'miss', 'mode', 'mood', 'moon', 'more', 'most',
    'move', 'much', 'must', 'myth', 'nail', 'name', 'navy', 'near', 'neck', 'need', 'news',
    'next', 'nice', 'nine', 'node', 'none', 'noon', 'norm', 'nose', 'note', 'null', 'open',
    'oral', 'over', 'pace', 'pack', 'page', 'paid', 'pain', 'pair', 'palm', 'park', 'part',
    'pass', 'past', 'path', 'pave', 'peak', 'peel', 'pelt', 'pick', 'pile', 'pill', 'pine',
    'pink', 'pipe', 'plan', 'play', 'plot', 'plow', 'plug', 'plus', 'poem', 'poet', 'pole',
    'poll', 'pond', 'pool', 'poor', 'port', 'pose', 'post', 'pour', 'pray', 'prep', 'prey',
    'pull', 'pump', 'pure', 'push', 'quit', 'quiz', 'race', 'rack', 'rage', 'raid', 'rail',
    'rain', 'rank', 'rape', 'rare', 'rash', 'rate', 'read', 'real', 'rear', 'rely', 'rent',
    'rest', 'rice', 'rich', 'ride', 'ring', 'riot', 'rise', 'risk', 'road', 'rock', 'role',
    'roll', 'roof', 'room', 'root', 'rope', 'rose', 'rude', 'rule', 'rush', 'rust', 'safe',
    'sail', 'sake', 'sale', 'salt', 'same', 'sand', 'save', 'scan', 'seal', 'seat', 'seed',
    'seek', 'self', 'sell', 'send', 'sent', 'ship', 'shop', 'shot', 'show', 'shut', 'sick',
    'side', 'sign', 'silk', 'sing', 'sink', 'site', 'size', 'skin', 'skip', 'slim', 'slip',
    'slow', 'snap', 'snow', 'soap', 'sock', 'soft', 'soil', 'sole', 'some', 'song', 'soon',
    'sore', 'soul', 'soup', 'span', 'spin', 'spot', 'spur', 'stab', 'star', 'stay', 'stem',
    'step', 'stir', 'stop', 'stub', 'such', 'suit', 'sure', 'surf', 'swap', 'swim', 'tail',
    'tale', 'talk', 'tall', 'tape', 'task', 'team', 'tear', 'tell', 'tend', 'tent', 'term',
    'test', 'text', 'than', 'that', 'them', 'then', 'they', 'thin', 'this', 'thus', 'tide',
    'till', 'time', 'tire', 'toad', 'told', 'toll', 'tomb', 'tone', 'took', 'tool', 'tops',
    'torn', 'tour', 'town', 'trap', 'tree', 'trim', 'trio', 'trip', 'true', 'tube', 'tune',
    'turn', 'type', 'unit', 'upon', 'user', 'vast', 'verb', 'very', 'view', 'vine', 'visa',
    'void', 'volt', 'vote', 'wade', 'wage', 'wait', 'wake', 'walk', 'wall', 'want', 'ward',
    'warm', 'warn', 'wary', 'wash', 'wave', 'weak', 'wear', 'weed', 'week', 'well', 'went',
    'were', 'west', 'what', 'when', 'whom', 'wide', 'wife', 'wild', 'will', 'wind', 'wine',
    'wing', 'wire', 'wish', 'with', 'wolf', 'wood', 'word', 'wore', 'work', 'worn', 'wrap',
    'yard', 'year', 'your', 'zero', 'zone'];
  fallback.forEach(w => DICTIONARY.add(w));
}

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
