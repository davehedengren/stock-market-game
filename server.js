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

// Bust die: d6 face (0-indexed) -> which asset index busts
// Faces 1-2 = bonds (1/6 each), faces 3-6 = stocks (2/6 each = higher bust risk)
const BUST_DIE_MAP = [1, 2, 3, 4, 3, 4];

const START_CASH = 1000;
const START_PRICE = 100;
const MAX_SHARES = 20;
const MAX_ROUNDS = 10;
const ROOM_EXPIRY_MS = 4 * 60 * 60 * 1000; // 4 hours

// --------------- In-Memory State ---------------

const rooms = {};

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
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
  rooms[code] = {
    code,
    phase: 'lobby',
    round: 0,
    prices: ASSETS.map(() => START_PRICE),
    priceHistory: ASSETS.map(() => [START_PRICE]),
    players: {},
    diceResults: null,
    cashFlowResult: null,
    bustResult: null,
    bustEvents: [],
    netWorthHistory: {},
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
    .map(p => ({
      name: p.name,
      netWorth: netWorth(p, room.prices),
      cash: p.cash,
      shares: [...p.shares],
      connected: p.connected,
    }))
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

function recordNetWorth(room) {
  for (const player of Object.values(room.players)) {
    const name = player.name;
    if (!room.netWorthHistory[name]) {
      room.netWorthHistory[name] = [START_CASH];
    }
    // Pad with nulls if player joined late
    while (room.netWorthHistory[name].length < room.round) {
      room.netWorthHistory[name].push(null);
    }
    room.netWorthHistory[name].push(netWorth(player, room.prices));
  }
}

function recoverBustedAssets(room) {
  if (room.bustResult) {
    const idx = room.bustResult.assetIndex;
    room.prices[idx] = START_PRICE;
    // Don't push to priceHistory here — next roll will record naturally
    room.bustResult = null;
  }
}

function applyDice(room, assetDiceIndices, cashFlowDieIdx, bustDieIdx) {
  // assetDiceIndices: array of 5 values, each 0-5
  // cashFlowDieIdx: 0-5
  // bustDieIdx: 0-5 or null

  // Store dice results for display
  room.diceResults = assetDiceIndices.map((dieIdx, i) => ({
    asset: ASSETS[i].name,
    color: ASSETS[i].color,
    dieValue: dieIdx + 1,
    returnPct: ASSETS[i].returns[dieIdx],
  }));
  room.cashFlowResult = {
    dieValue: cashFlowDieIdx + 1,
    amount: CASH_FLOW_VALUES[cashFlowDieIdx],
  };

  // Update prices
  for (let i = 0; i < ASSETS.length; i++) {
    const pct = ASSETS[i].returns[assetDiceIndices[i]];
    room.prices[i] = Math.round(room.prices[i] * (1 + pct / 100) * 100) / 100;
    room.priceHistory[i].push(room.prices[i]);
  }

  // Apply cash flow to all players
  const cashFlowAmount = CASH_FLOW_VALUES[cashFlowDieIdx];
  for (const player of Object.values(room.players)) {
    player.cash = Math.round((player.cash + cashFlowAmount) * 100) / 100;
  }

  // Bust die on even rounds
  if (room.round % 2 === 0 && bustDieIdx !== null && bustDieIdx !== undefined) {
    const bustAssetIdx = BUST_DIE_MAP[bustDieIdx];

    // Collapse price to 0, overwrite the price we just recorded
    room.prices[bustAssetIdx] = 0;
    room.priceHistory[bustAssetIdx][room.priceHistory[bustAssetIdx].length - 1] = 0;

    // Wipe all player shares in that asset
    for (const player of Object.values(room.players)) {
      player.shares[bustAssetIdx] = 0;
    }

    room.bustResult = {
      assetIndex: bustAssetIdx,
      asset: ASSETS[bustAssetIdx].name,
      color: ASSETS[bustAssetIdx].color,
      dieValue: bustDieIdx + 1,
    };

    room.bustEvents.push({
      round: room.round,
      assetIndex: bustAssetIdx,
      assetName: ASSETS[bustAssetIdx].name,
    });
  } else {
    room.bustResult = null;
  }

  // Snapshot net worth for all players
  recordNetWorth(room);
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
    bustResult: room.bustResult,
    bustEvents: room.bustEvents,
    netWorthHistory: room.netWorthHistory,
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
      const taken = Object.values(room.players).some(
        p => p.name.toLowerCase() === name.toLowerCase()
      );
      if (taken) {
        return callback({ ok: false, error: 'Name already taken in this room.' });
      }
      const player = createPlayer(name);
      room.players[socket.id] = player;
      // Initialize net worth history for new player
      if (!room.netWorthHistory[name]) {
        room.netWorthHistory[name] = [START_CASH];
      }
    }

    socket.join(code);
    socket.roomCode = code;
    socket.isTeacher = false;

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

  // --- Teacher: Start Trading ---
  socket.on('start-trading', (callback) => {
    const room = rooms[socket.roomCode];
    if (!room || !socket.isTeacher) return callback({ ok: false });
    if (room.phase !== 'lobby' && room.phase !== 'rolling') return callback({ ok: false });

    recoverBustedAssets(room);
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

  // --- Teacher: Roll Dice (auto) ---
  socket.on('roll-dice', (callback) => {
    const room = rooms[socket.roomCode];
    if (!room || !socket.isTeacher) return callback({ ok: false });
    if (room.phase !== 'rolling') return callback({ ok: false });

    const assetDice = ASSETS.map(() => rollDie());
    const cashFlowDie = rollDie();
    const bustDie = (room.round % 2 === 0) ? rollDie() : null;

    applyDice(room, assetDice, cashFlowDie, bustDie);

    io.to(room.code).emit('room-update', roomState(room));
    io.to(room.code).emit('dice-rolled', {
      diceResults: room.diceResults,
      cashFlowResult: room.cashFlowResult,
      bustResult: room.bustResult,
    });
    callback({ ok: true });
  });

  // --- Teacher: Submit Manual Dice ---
  socket.on('submit-manual-dice', ({ assetDice, cashFlowDie, bustDie }, callback) => {
    const room = rooms[socket.roomCode];
    if (!room || !socket.isTeacher) return callback({ ok: false });
    if (room.phase !== 'rolling') return callback({ ok: false });

    // Validate: values are 1-6 (user-facing), convert to 0-5 (internal)
    if (!Array.isArray(assetDice) || assetDice.length !== ASSETS.length) {
      return callback({ ok: false, error: 'Need exactly 5 asset dice values.' });
    }
    for (const v of assetDice) {
      if (typeof v !== 'number' || v < 1 || v > 6) {
        return callback({ ok: false, error: 'Dice values must be 1-6.' });
      }
    }
    if (typeof cashFlowDie !== 'number' || cashFlowDie < 1 || cashFlowDie > 6) {
      return callback({ ok: false, error: 'Cash flow die must be 1-6.' });
    }

    const assetDiceIdx = assetDice.map(v => v - 1);
    const cashFlowDieIdx = cashFlowDie - 1;

    let bustDieIdx = null;
    if (room.round % 2 === 0) {
      if (typeof bustDie === 'number' && bustDie >= 1 && bustDie <= 6) {
        bustDieIdx = bustDie - 1;
      } else {
        bustDieIdx = rollDie(); // auto-roll if not provided
      }
    }

    applyDice(room, assetDiceIdx, cashFlowDieIdx, bustDieIdx);

    io.to(room.code).emit('room-update', roomState(room));
    io.to(room.code).emit('dice-rolled', {
      diceResults: room.diceResults,
      cashFlowResult: room.cashFlowResult,
      bustResult: room.bustResult,
    });
    callback({ ok: true });
  });

  // --- Teacher: Next Round ---
  socket.on('next-round', (callback) => {
    const room = rooms[socket.roomCode];
    if (!room || !socket.isTeacher) return callback({ ok: false });
    if (room.phase !== 'rolling') return callback({ ok: false });

    if (room.round >= MAX_ROUNDS) {
      room.phase = 'finished';
    } else {
      recoverBustedAssets(room);
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
      // Keep room alive for reconnect
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Stock Simulation running on http://localhost:${PORT}`);
});
