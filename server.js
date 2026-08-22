const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

// ============== GAME STATE (IN-MEMORY ONLY) ==============
const rooms = new Map(); // roomCode -> Room

const COLORS = [
  '#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6',
  '#e67e22', '#1abc9c', '#e91e63', '#00bcd4', '#ff5722'
];

const TASKS = [
  { id: 'wires', name: 'Fix Wires', time: 4 },
  { id: 'download', name: 'Download Data', time: 5 },
  { id: 'upload', name: 'Upload Data', time: 5 },
  { id: 'fuel', name: 'Fuel Engines', time: 6 },
  { id: 'scan', name: 'Medbay Scan', time: 7 },
  { id: 'card', name: 'Swipe Card', time: 3 },
  { id: 'calibrate', name: 'Calibrate Distributor', time: 5 },
  { id: 'clean', name: 'Clean Vent', time: 4 }
];

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function createRoom(hostId, hostName) {
  let code;
  do { code = generateCode(); } while (rooms.has(code));

  const room = {
    code,
    hostId,
    state: 'lobby', // lobby | playing | meeting | ended
    players: new Map(),
    bots: [],
    settings: {
      maxPlayers: 10,
      impostors: 1,
      botCount: 0,
      killCooldown: 25,
      meetingCooldown: 20,
      taskCount: 4
    },
    bodies: [],
    votes: {},
    meetingTimer: null,
    meetingEndsAt: 0,
    discussionTime: 30,
    votingTime: 45,
    winner: null
  };

  rooms.set(code, room);
  return room;
}

function addPlayer(room, id, name, isBot = false) {
  const usedColors = [...room.players.values()].map(p => p.color);
  const color = COLORS.find(c => !usedColors.includes(c)) || COLORS[Math.floor(Math.random() * COLORS.length)];

  const player = {
    id,
    name: name || (isBot ? `Bot ${room.players.size + 1}` : 'Player'),
    color,
    x: 400 + (Math.random() - 0.5) * 200,
    y: 300 + (Math.random() - 0.5) * 150,
    role: null, // crewmate | impostor
    alive: true,
    isBot,
    tasks: [],
    completedTasks: 0,
    killCooldown: 0,
    lastKill: 0,
    venting: false,
    voted: false
  };

  room.players.set(id, player);
  return player;
}

function getAlivePlayers(room) {
  return [...room.players.values()].filter(p => p.alive);
}

function getAliveCrew(room) {
  return getAlivePlayers(room).filter(p => p.role === 'crewmate');
}

function getAliveImpostors(room) {
  return getAlivePlayers(room).filter(p => p.role === 'impostor');
}

function startGame(room) {
  // Fill with bots if needed
  const humanCount = [...room.players.values()].filter(p => !p.isBot).length;
  const targetBots = Math.max(0, room.settings.botCount);
  const currentBots = [...room.players.values()].filter(p => p.isBot).length;

  for (let i = currentBots; i < targetBots; i++) {
    const botId = 'bot_' + Date.now() + '_' + i;
    addPlayer(room, botId, `Bot ${i + 1}`, true);
  }

  const players = [...room.players.values()];
  if (players.length < 2) return false;

  // Assign roles
  const impostorCount = Math.min(room.settings.impostors, Math.floor(players.length / 3) || 1);
  const shuffled = players.sort(() => Math.random() - 0.5);

  shuffled.forEach((p, i) => {
    p.role = i < impostorCount ? 'impostor' : 'crewmate';
    p.alive = true;
    p.completedTasks = 0;
    p.voted = false;
    p.tasks = [];

    // Give crewmates tasks
    if (p.role === 'crewmate') {
      const shuffledTasks = [...TASKS].sort(() => Math.random() - 0.5);
      p.tasks = shuffledTasks.slice(0, room.settings.taskCount).map(t => ({
        ...t,
        progress: 0,
        done: false
      }));
    }
  });

  room.state = 'playing';
  room.bodies = [];
  room.votes = {};
  room.winner = null;

  // Start bot AI loop
  if (!room.botInterval) {
    room.botInterval = setInterval(() => updateBots(room), 800);
  }

  return true;
}

function updateBots(room) {
  if (room.state !== 'playing') return;

  const players = [...room.players.values()];
  const alive = players.filter(p => p.alive);

  for (const bot of players.filter(p => p.isBot && p.alive)) {
    // Simple movement: wander randomly
    if (Math.random() < 0.4) {
      bot.x += (Math.random() - 0.5) * 60;
      bot.y += (Math.random() - 0.5) * 60;
      bot.x = Math.max(40, Math.min(760, bot.x));
      bot.y = Math.max(40, Math.min(560, bot.y));
    }

    // Impostor bots: try to kill nearby crewmates
    if (bot.role === 'impostor') {
      const now = Date.now();
      if (now - bot.lastKill > room.settings.killCooldown * 1000) {
        const nearby = alive.filter(p =>
          p.id !== bot.id &&
          p.role === 'crewmate' &&
          Math.hypot(p.x - bot.x, p.y - bot.y) < 70
        );
        if (nearby.length > 0 && Math.random() < 0.35) {
          const victim = nearby[Math.floor(Math.random() * nearby.length)];
          killPlayer(room, bot.id, victim.id);
          bot.lastKill = now;
        }
      }
    }

    // Crewmate bots: slowly complete tasks
    if (bot.role === 'crewmate' && bot.tasks.length > 0) {
      const task = bot.tasks.find(t => !t.done);
      if (task && Math.random() < 0.15) {
        task.progress += 1;
        if (task.progress >= task.time) {
          task.done = true;
          bot.completedTasks++;
          checkTaskWin(room);
        }
      }
    }
  }

  // Broadcast positions of bots
  io.to(room.code).emit('gameUpdate', getPublicState(room));
}

function killPlayer(room, killerId, victimId) {
  const victim = room.players.get(victimId);
  const killer = room.players.get(killerId);
  if (!victim || !victim.alive || !killer || killer.role !== 'impostor') return;

  victim.alive = false;
  room.bodies.push({
    id: victim.id,
    name: victim.name,
    color: victim.color,
    x: victim.x,
    y: victim.y
  });

  io.to(room.code).emit('playerKilled', {
    victimId,
    killerId: killer.isBot ? null : killerId, // hide bot killers a bit
    x: victim.x,
    y: victim.y
  });

  checkWin(room);
}

function checkWin(room) {
  const aliveCrew = getAliveCrew(room).length;
  const aliveImp = getAliveImpostors(room).length;

  if (aliveImp === 0) {
    endGame(room, 'crew');
  } else if (aliveImp >= aliveCrew) {
    endGame(room, 'impostor');
  }
}

function checkTaskWin(room) {
  const crewmates = [...room.players.values()].filter(p => p.role === 'crewmate');
  if (crewmates.length === 0) return;

  const allDone = crewmates.every(c => {
    const total = c.tasks.length || 1;
    return c.completedTasks >= total;
  });

  if (allDone) endGame(room, 'crew');
}

function endGame(room, winner) {
  room.state = 'ended';
  room.winner = winner;
  if (room.botInterval) {
    clearInterval(room.botInterval);
    room.botInterval = null;
  }
  io.to(room.code).emit('gameOver', { winner, players: getPublicState(room).players });
}

function getPublicState(room) {
  return {
    code: room.code,
    state: room.state,
    settings: room.settings,
    players: [...room.players.values()].map(p => ({
      id: p.id,
      name: p.name,
      color: p.color,
      x: p.x,
      y: p.y,
      alive: p.alive,
      isBot: p.isBot,
      role: room.state === 'ended' || !p.alive ? p.role : undefined, // only show role when dead or game over
      completedTasks: p.completedTasks,
      taskTotal: p.tasks.length
    })),
    bodies: room.bodies,
    hostId: room.hostId,
    winner: room.winner
  };
}

// ============== SOCKET HANDLERS ==============
io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);

  socket.on('createRoom', ({ name }) => {
    const room = createRoom(socket.id, name);
    addPlayer(room, socket.id, name || 'Host');
    socket.join(room.code);
    socket.roomCode = room.code;

    socket.emit('roomCreated', {
      code: room.code,
      localIP: getLocalIP(),
      state: getPublicState(room)
    });
  });

  socket.on('joinRoom', ({ code, name }) => {
    const room = rooms.get((code || '').toUpperCase());
    if (!room) return socket.emit('error', 'Room not found');
    if (room.state !== 'lobby') return socket.emit('error', 'Game already started');
    if (room.players.size >= room.settings.maxPlayers) return socket.emit('error', 'Room full');

    addPlayer(room, socket.id, name || 'Player');
    socket.join(room.code);
    socket.roomCode = room.code;

    io.to(room.code).emit('playerJoined', getPublicState(room));
    socket.emit('joined', getPublicState(room));
  });

  socket.on('updateSettings', (settings) => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.hostId !== socket.id || room.state !== 'lobby') return;

    Object.assign(room.settings, settings);
    io.to(room.code).emit('settingsUpdated', room.settings);
  });

  socket.on('startGame', () => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.hostId !== socket.id || room.state !== 'lobby') return;

    if (startGame(room)) {
      // Send private role info to each player
      for (const [id, player] of room.players) {
        if (!player.isBot) {
          io.to(id).emit('yourRole', {
            role: player.role,
            tasks: player.tasks
          });
        }
      }
      io.to(room.code).emit('gameStarted', getPublicState(room));
    } else {
      socket.emit('error', 'Need at least 2 players (use bots!)');
    }
  });

  socket.on('move', ({ x, y }) => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.state !== 'playing') return;
    const player = room.players.get(socket.id);
    if (!player || !player.alive) return;

    player.x = Math.max(20, Math.min(780, x));
    player.y = Math.max(20, Math.min(580, y));

    // Broadcast to others (not self to reduce lag feel)
    socket.to(room.code).emit('playerMoved', { id: socket.id, x: player.x, y: player.y });
  });

  socket.on('kill', ({ targetId }) => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.state !== 'playing') return;
    const killer = room.players.get(socket.id);
    if (!killer || killer.role !== 'impostor' || !killer.alive) return;

    const now = Date.now();
    if (now - killer.lastKill < room.settings.killCooldown * 1000) return;

    const target = room.players.get(targetId);
    if (!target || !target.alive) return;
    if (Math.hypot(target.x - killer.x, target.y - killer.y) > 80) return;

    killer.lastKill = now;
    killPlayer(room, socket.id, targetId);
  });

  socket.on('report', () => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.state !== 'playing') return;
    const player = room.players.get(socket.id);
    if (!player || !player.alive) return;

    // Check if near a body
    const nearBody = room.bodies.find(b => Math.hypot(b.x - player.x, b.y - player.y) < 80);
    if (!nearBody && room.bodies.length === 0) return;

    startMeeting(room, player.name + ' reported a body');
  });

  socket.on('emergency', () => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.state !== 'playing') return;
    const player = room.players.get(socket.id);
    if (!player || !player.alive) return;

    startMeeting(room, player.name + ' called an emergency meeting');
  });

  socket.on('completeTask', ({ taskId }) => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.state !== 'playing') return;
    const player = room.players.get(socket.id);
    if (!player || player.role !== 'crewmate' || !player.alive) return;

    const task = player.tasks.find(t => t.id === taskId && !t.done);
    if (!task) return;

    task.done = true;
    player.completedTasks++;
    socket.emit('taskCompleted', { taskId, completed: player.completedTasks, total: player.tasks.length });
    checkTaskWin(room);
    io.to(room.code).emit('gameUpdate', getPublicState(room));
  });

  socket.on('vote', ({ targetId }) => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.state !== 'meeting') return;
    const voter = room.players.get(socket.id);
    if (!voter || !voter.alive || voter.voted) return;

    voter.voted = true;
    room.votes[socket.id] = targetId; // null = skip

    io.to(room.code).emit('voteUpdate', {
      votedCount: Object.keys(room.votes).length,
      total: getAlivePlayers(room).length
    });
  });

  socket.on('disconnect', () => {
    const code = socket.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;

    room.players.delete(socket.id);

    if (room.players.size === 0 || [...room.players.values()].every(p => p.isBot)) {
      if (room.botInterval) clearInterval(room.botInterval);
      rooms.delete(code);
      console.log('Room deleted:', code);
      return;
    }

    // Transfer host if needed
    if (room.hostId === socket.id) {
      const next = [...room.players.values()].find(p => !p.isBot);
      if (next) room.hostId = next.id;
    }

    io.to(code).emit('playerLeft', getPublicState(room));
  });
});

function startMeeting(room, reason) {
  room.state = 'meeting';
  room.votes = {};
  room.bodies = []; // clear bodies after report

  for (const p of room.players.values()) {
    p.voted = false;
  }

  io.to(room.code).emit('meetingStarted', {
    reason,
    players: getPublicState(room).players,
    discussionTime: room.discussionTime,
    votingTime: room.votingTime
  });

  // Auto end meeting after discussion + voting
  const totalTime = (room.discussionTime + room.votingTime) * 1000;
  room.meetingTimer = setTimeout(() => endMeeting(room), totalTime);
}

function endMeeting(room) {
  if (room.state !== 'meeting') return;

  // Count votes
  const voteCount = {};
  let skip = 0;
  for (const target of Object.values(room.votes)) {
    if (target === null || target === 'skip') skip++;
    else voteCount[target] = (voteCount[target] || 0) + 1;
  }

  let maxVotes = 0;
  let ejected = null;
  let tie = false;

  for (const [id, count] of Object.entries(voteCount)) {
    if (count > maxVotes) {
      maxVotes = count;
      ejected = id;
      tie = false;
    } else if (count === maxVotes) {
      tie = true;
    }
  }

  if (tie || maxVotes === 0 || skip >= maxVotes) {
    ejected = null;
  }

  let ejectedPlayer = null;
  if (ejected) {
    ejectedPlayer = room.players.get(ejected);
    if (ejectedPlayer) {
      ejectedPlayer.alive = false;
    }
  }

  room.state = 'playing';
  io.to(room.code).emit('meetingEnded', {
    ejected: ejectedPlayer ? { id: ejectedPlayer.id, name: ejectedPlayer.name, role: ejectedPlayer.role } : null,
    wasTie: tie || !ejected
  });

  checkWin(room);
  if (room.state === 'playing') {
    io.to(room.code).emit('gameUpdate', getPublicState(room));
  }
}

// ============== START SERVER ==============
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  console.log('\n========================================');
  console.log('   MYSN MURDER - Server Running!');
  console.log('========================================');
  console.log(`  Local:   http://localhost:${PORT}`);
  console.log(`  Network: http://${ip}:${PORT}`);
  console.log('  Share the Network URL with friends on the same WiFi');
  console.log('========================================\n');
});
