const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// --------------- Game Constants ---------------

const ASSETS = [
  { name: 'Money Market',    color: '#34d399', returns: [0, 2, 3, 4, 5, 6] },
  { name: 'Low Risk Bonds',  color: '#fbbf24', returns: [-5, 0, 3, 6, 9, 12] },
  { name: 'High Risk Bonds', color: '#fb923c', returns: [-10, -5, 5, 12, 15, 20] },
  { name: 'Med Risk Stocks', color: '#a78bfa', returns: [-20, -10, 0, 15, 25, 40] },
  { name: 'High Risk Stocks',color: '#f87171', returns: [-30, -15, -5, 20, 35, 55] },
];

const CASH_FLOW_VALUES = [-50, 0, 10, 25, 50, 75];
const START_CASH = 1000;
const START_PRICE = 100;
const MAX_SHARES = 20;
const MAX_ROUNDS = 10;
const ROOM_EXPIRY_MS = 4 * 60 * 60 * 1000; // 4 hours

// --------------- In-Memory State ---------------

const rooms = {}; // roomCode -> room object

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/1/O/0 confusion
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms[code]);
  return code;
}

function rollDie() {
  return Math.floor(Math.random() * 6); // 0-5 index
}

function createRoom() {
  const code = generateRoomCode();
  const startPrices = ASSETS.map(() => START_PRICE);
  rooms[code] = {
    code,
    phase: 'lobby', // lobby | trading | rolling | finished
    round: 0,
    prices: startPrices,
    priceHistory: ASSETS.map(() => [START_PRICE]),
    players: {},     // socketId -> player
    diceResults: null,
    cashFlowResult: null,
    teacherSocketId: null,
    createdAt: Date.now(),
  };
  return rooms[code];
}

function createPlayer(name) {
  return {
    name,
    cash: START_CASH,
    shares: ASSETS.map(() => 0),
    connected: true,
  };
}

function netWorth(player, prices) {
  let total = player.cash;
  for (let i = 0; i < ASSETS.length; i++) {
    total += player.shares[i] * prices[i];
  }
  return Math.round(total * 100) / 100;
}

function buildLeaderboard(room) {
  return Object.values(room.players)
    .map(p => ({ name: p.name, netWorth: netWorth(p, room.prices), cash: p.cash, connected: p.connected }))
    .sort((a, b) => b.netWorth - a.netWorth);
}

function buildPlayerList(room) {
  return Object.values(room.players).map(p => ({
    name: p.name,
    cash: p.cash,
    shares: [...p.shares],
    netWorth: netWorth(p, room.prices),
    connected: p.connected,
  }));
}

function roomState(room) {
  return {
    code: room.code,
    phase: room.phase,
    round: room.round,
    prices: room.prices,
    priceHistory: room.priceHistory,
    assets: ASSETS.map(a => ({ name: a.name, color: a.color })),
    leaderboard: buildLeaderboard(room),
    players: buildPlayerList(room),
    diceResults: room.diceResults,
    cashFlowResult: room.cashFlowResult,
    maxShares: MAX_SHARES,
    maxRounds: MAX_ROUNDS,
  };
}

// --------------- Stale Room Cleanup ---------------

setInterval(() => {
  const now = Date.now();
  for (const code of Object.keys(rooms)) {
    if (now - rooms[code].createdAt > ROOM_EXPIRY_MS) {
      io.to(code).emit('room-expired');
      delete rooms[code];
    }
  }
}, 60 * 1000);

// --------------- Socket.IO ---------------

io.on('connection', (socket) => {

  // --- Create Room (teacher) ---
  socket.on('create-room', (callback) => {
    const room = createRoom();
    room.teacherSocketId = socket.id;
    socket.join(room.code);
    socket.roomCode = room.code;
    socket.isTeacher = true;
    callback({ ok: true, room: roomState(room) });
  });

  // --- Join Room (student) ---
  socket.on('join-room', ({ code, name }, callback) => {
    code = (code || '').toUpperCase().trim();
    name = (name || '').trim();

    if (!name || name.length > 20) {
      return callback({ ok: false, error: 'Name must be 1-20 characters.' });
    }
    const room = rooms[code];
    if (!room) {
      return callback({ ok: false, error: 'Room not found.' });
    }
    if (room.phase === 'finished') {
      return callback({ ok: false, error: 'Game is already over.' });
    }

    // Reconnection: if a player with same name exists and is disconnected, reclaim
    let existingId = null;
    for (const [sid, p] of Object.entries(room.players)) {
      if (p.name.toLowerCase() === name.toLowerCase() && !p.connected) {
        existingId = sid;
        break;
      }
    }

    if (existingId) {
      const player = room.players[existingId];
      delete room.players[existingId];
      player.connected = true;
      room.players[socket.id] = player;
    } else {
      // Check for duplicate name among connected players
      const taken = Object.values(room.players).some(
        p => p.name.toLowerCase() === name.toLowerCase()
      );
      if (taken) {
        return callback({ ok: false, error: 'Name already taken in this room.' });
      }
      room.players[socket.id] = createPlayer(name);
    }

    socket.join(code);
    socket.roomCode = code;
    socket.isTeacher = false;

    // Notify teacher + all players
    io.to(code).emit('room-update', roomState(room));
    callback({ ok: true, room: roomState(room), playerName: room.players[socket.id].name });
  });

  // --- Buy Share ---
  socket.on('buy', ({ assetIndex }, callback) => {
    const room = rooms[socket.roomCode];
    if (!room || room.phase !== 'trading') return callback({ ok: false, error: 'Trading is not open.' });

    const player = room.players[socket.id];
    if (!player) return callback({ ok: false, error: 'Player not found.' });

    if (assetIndex < 0 || assetIndex >= ASSETS.length) return callback({ ok: false, error: 'Invalid asset.' });
    if (player.shares[assetIndex] >= MAX_SHARES) return callback({ ok: false, error: `Max ${MAX_SHARES} shares.` });
    if (player.cash < room.prices[assetIndex]) return callback({ ok: false, error: 'Not enough cash.' });

    player.cash = Math.round((player.cash - room.prices[assetIndex]) * 100) / 100;
    player.shares[assetIndex]++;

    io.to(socket.roomCode).emit('room-update', roomState(room));
    callback({ ok: true });
  });

  // --- Sell Share ---
  socket.on('sell', ({ assetIndex }, callback) => {
    const room = rooms[socket.roomCode];
    if (!room || room.phase !== 'trading') return callback({ ok: false, error: 'Trading is not open.' });

    const player = room.players[socket.id];
    if (!player) return callback({ ok: false, error: 'Player not found.' });

    if (assetIndex < 0 || assetIndex >= ASSETS.length) return callback({ ok: false, error: 'Invalid asset.' });
    if (player.shares[assetIndex] <= 0) return callback({ ok: false, error: 'No shares to sell.' });

    player.cash = Math.round((player.cash + room.prices[assetIndex]) * 100) / 100;
    player.shares[assetIndex]--;

    io.to(socket.roomCode).emit('room-update', roomState(room));
    callback({ ok: true });
  });

  // --- Teacher: Start Trading (begin round) ---
  socket.on('start-trading', (callback) => {
    const room = rooms[socket.roomCode];
    if (!room || !socket.isTeacher) return callback({ ok: false });
    if (room.phase !== 'lobby' && room.phase !== 'rolling') return callback({ ok: false });

    room.round++;
    room.phase = 'trading';
    room.diceResults = null;
    room.cashFlowResult = null;
    io.to(room.code).emit('room-update', roomState(room));
    callback({ ok: true });
  });

  // --- Teacher: Lock Trading ---
  socket.on('lock-trading', (callback) => {
    const room = rooms[socket.roomCode];
    if (!room || !socket.isTeacher) return callback({ ok: false });
    if (room.phase !== 'trading') return callback({ ok: false });

    room.phase = 'rolling';
    io.to(room.code).emit('room-update', roomState(room));
    callback({ ok: true });
  });

  // --- Teacher: Roll Dice ---
  socket.on('roll-dice', (callback) => {
    const room = rooms[socket.roomCode];
    if (!room || !socket.isTeacher) return callback({ ok: false });
    if (room.phase !== 'rolling') return callback({ ok: false });

    // Roll asset dice
    const assetDice = ASSETS.map(() => rollDie());
    const cashFlowDie = rollDie();

    // Store results for display
    room.diceResults = assetDice.map((dieIdx, i) => ({
      asset: ASSETS[i].name,
      color: ASSETS[i].color,
      dieValue: dieIdx + 1,
      returnPct: ASSETS[i].returns[dieIdx],
    }));
    room.cashFlowResult = {
      dieValue: cashFlowDie + 1,
      amount: CASH_FLOW_VALUES[cashFlowDie],
    };

    // Update prices
    for (let i = 0; i < ASSETS.length; i++) {
      const pct = ASSETS[i].returns[assetDice[i]];
      room.prices[i] = Math.round(room.prices[i] * (1 + pct / 100) * 100) / 100;
      room.priceHistory[i].push(room.prices[i]);
    }

    // Apply cash flow to all players
    const cashFlowAmount = CASH_FLOW_VALUES[cashFlowDie];
    for (const player of Object.values(room.players)) {
      player.cash = Math.round((player.cash + cashFlowAmount) * 100) / 100;
    }

    io.to(room.code).emit('room-update', roomState(room));
    io.to(room.code).emit('dice-rolled', {
      diceResults: room.diceResults,
      cashFlowResult: room.cashFlowResult,
    });
    callback({ ok: true });
  });

  // --- Teacher: Next Round (open trading again) ---
  socket.on('next-round', (callback) => {
    const room = rooms[socket.roomCode];
    if (!room || !socket.isTeacher) return callback({ ok: false });
    if (room.phase !== 'rolling') return callback({ ok: false });

    if (room.round >= MAX_ROUNDS) {
      room.phase = 'finished';
    } else {
      room.round++;
      room.phase = 'trading';
      room.diceResults = null;
      room.cashFlowResult = null;
    }

    io.to(room.code).emit('room-update', roomState(room));
    callback({ ok: true });
  });

  // --- Teacher: End Game ---
  socket.on('end-game', (callback) => {
    const room = rooms[socket.roomCode];
    if (!room || !socket.isTeacher) return callback({ ok: false });

    room.phase = 'finished';
    io.to(room.code).emit('room-update', roomState(room));
    callback({ ok: true });
  });

  // --- Disconnect ---
  socket.on('disconnect', () => {
    const room = rooms[socket.roomCode];
    if (!room) return;

    if (socket.isTeacher) {
      // Teacher disconnect — keep room alive, they can reconnect as a new teacher
    } else {
      const player = room.players[socket.id];
      if (player) {
        player.connected = false;
        io.to(room.code).emit('room-update', roomState(room));
      }
    }
  });

  // --- Teacher Reconnect ---
  socket.on('rejoin-teacher', ({ code }, callback) => {
    code = (code || '').toUpperCase().trim();
    const room = rooms[code];
    if (!room) return callback({ ok: false, error: 'Room not found.' });

    room.teacherSocketId = socket.id;
    socket.join(code);
    socket.roomCode = code;
    socket.isTeacher = true;
    callback({ ok: true, room: roomState(room) });
  });
});

// --------------- Start Server ---------------

const PORT = process.env.PORT || 5000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Stock Simulation running on port ${PORT}`);
});
