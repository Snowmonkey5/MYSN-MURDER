const COLORS = [
  '#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6',
  '#e67e22', '#1abc9c', '#e91e63', '#00bcd4', '#ff5722',
  '#8e44ad', '#16a085'
];

const TASKS = [
  { id: 'wires', name: 'Fix Wires', time: 4 },
  { id: 'download', name: 'Download Data', time: 5 },
  { id: 'upload', name: 'Upload Data', time: 5 },
  { id: 'fuel', name: 'Fuel Engines', time: 6 },
  { id: 'scan', name: 'Medbay Scan', time: 7 },
  { id: 'card', name: 'Swipe Card', time: 3 },
  { id: 'calibrate', name: 'Calibrate Distributor', time: 5 },
  { id: 'clean', name: 'Clean Filters', time: 4 },
  { id: 'stabilize', name: 'Stabilize Steering', time: 5 },
  { id: 'empty', name: 'Empty Garbage', time: 4 }
];

export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map(); // webSocket -> { id, name }
    this.room = null;
    this.botInterval = null;
  }

  async fetch(request) {
    const upgrade = request.headers.get('Upgrade');
    if (upgrade !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.state.acceptWebSocket(server);
    server.addEventListener('message', (event) => this.handleMessage(server, event.data));
    server.addEventListener('close', () => this.handleClose(server));
    server.addEventListener('error', () => this.handleClose(server));

    return new Response(null, { status: 101, webSocket: client });
  }

  ensureRoom(code) {
    if (!this.room) {
      this.room = {
        code,
        hostId: null,
        state: 'lobby',
        players: new Map(),
        settings: {
          maxPlayers: 12,
          impostors: 1,
          botCount: 3,
          killCooldown: 22,
          taskCount: 5
        },
        bodies: [],
        votes: {},
        discussionTime: 25,
        votingTime: 40,
        winner: null,
        meetingTimer: null
      };
    }
    return this.room;
  }

  handleMessage(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    const { type, data } = msg;

    switch (type) {
      case 'join':
        this.join(ws, data);
        break;
      case 'settings':
        this.updateSettings(ws, data);
        break;
      case 'start':
        this.startGame(ws);
        break;
      case 'move':
        this.move(ws, data);
        break;
      case 'kill':
        this.kill(ws, data);
        break;
      case 'report':
        this.report(ws);
        break;
      case 'emergency':
        this.emergency(ws);
        break;
      case 'task':
        this.completeTask(ws, data);
        break;
      case 'vote':
        this.vote(ws, data);
        break;
      case 'ping':
        this.send(ws, { type: 'pong' });
        break;
    }
  }

  join(ws, { name, code }) {
    const room = this.ensureRoom((code || 'XXXX').toUpperCase());
    if (room.state !== 'lobby') {
      return this.send(ws, { type: 'error', data: 'Game already started' });
    }
    if (room.players.size >= room.settings.maxPlayers) {
      return this.send(ws, { type: 'error', data: 'Room is full' });
    }

    const id = crypto.randomUUID();
    const used = [...room.players.values()].map(p => p.color);
    const color = COLORS.find(c => !used.includes(c)) || COLORS[Math.floor(Math.random() * COLORS.length)];

    const player = {
      id,
      name: (name || 'Player').slice(0, 12),
      color,
      x: 400 + (Math.random() - 0.5) * 180,
      y: 300 + (Math.random() - 0.5) * 120,
      role: null,
      alive: true,
      isBot: false,
      tasks: [],
      completedTasks: 0,
      lastKill: 0,
      voted: false
    };

    room.players.set(id, player);
    this.sessions.set(ws, { id, name: player.name });

    if (!room.hostId) room.hostId = id;

    this.send(ws, {
      type: 'joined',
      data: {
        id,
        isHost: room.hostId === id,
        state: this.publicState()
      }
    });

    this.broadcast({ type: 'update', data: this.publicState() }, ws);
  }

  updateSettings(ws, settings) {
    const session = this.sessions.get(ws);
    if (!session || !this.room || this.room.hostId !== session.id) return;
    if (this.room.state !== 'lobby') return;

    Object.assign(this.room.settings, settings);
    this.broadcast({ type: 'settings', data: this.room.settings });
  }

  startGame(ws) {
    const session = this.sessions.get(ws);
    if (!session || !this.room || this.room.hostId !== session.id) return;
    if (this.room.state !== 'lobby') return;

    // Fill bots
    const currentBots = [...this.room.players.values()].filter(p => p.isBot).length;
    const target = this.room.settings.botCount || 0;
    for (let i = currentBots; i < target; i++) {
      const botId = 'bot_' + crypto.randomUUID().slice(0, 8);
      const used = [...this.room.players.values()].map(p => p.color);
      const color = COLORS.find(c => !used.includes(c)) || COLORS[i % COLORS.length];
      this.room.players.set(botId, {
        id: botId,
        name: `Bot ${i + 1}`,
        color,
        x: 400 + (Math.random() - 0.5) * 200,
        y: 300 + (Math.random() - 0.5) * 150,
        role: null,
        alive: true,
        isBot: true,
        tasks: [],
        completedTasks: 0,
        lastKill: 0,
        voted: false
      });
    }

    const players = [...this.room.players.values()];
    if (players.length < 2) {
      return this.send(ws, { type: 'error', data: 'Need at least 2 players (add bots!)' });
    }

    // Assign roles
    const impCount = Math.min(
      this.room.settings.impostors,
      Math.max(1, Math.floor(players.length / 3))
    );
    const shuffled = [...players].sort(() => Math.random() - 0.5);

    shuffled.forEach((p, i) => {
      p.role = i < impCount ? 'impostor' : 'crewmate';
      p.alive = true;
      p.completedTasks = 0;
      p.voted = false;
      p.tasks = [];
      p.lastKill = 0;

      if (p.role === 'crewmate') {
        const t = [...TASKS].sort(() => Math.random() - 0.5)
          .slice(0, this.room.settings.taskCount)
          .map(task => ({ ...task, done: false }));
        p.tasks = t;
      }
    });

    this.room.state = 'playing';
    this.room.bodies = [];
    this.room.votes = {};
    this.room.winner = null;

    // Send private roles
    for (const [sock, sess] of this.sessions) {
      const p = this.room.players.get(sess.id);
      if (p) {
        this.send(sock, {
          type: 'role',
          data: { role: p.role, tasks: p.tasks }
        });
      }
    }

    this.broadcast({ type: 'started', data: this.publicState() });

    // Bot AI loop
    if (this.botInterval) clearInterval(this.botInterval);
    this.botInterval = setInterval(() => this.updateBots(), 700);
  }

  updateBots() {
    if (!this.room || this.room.state !== 'playing') return;

    const alive = [...this.room.players.values()].filter(p => p.alive);

    for (const bot of alive.filter(p => p.isBot)) {
      // Wander
      if (Math.random() < 0.45) {
        bot.x += (Math.random() - 0.5) * 55;
        bot.y += (Math.random() - 0.5) * 55;
        bot.x = Math.max(30, Math.min(770, bot.x));
        bot.y = Math.max(30, Math.min(570, bot.y));
      }

      // Impostor kill
      if (bot.role === 'impostor') {
        const now = Date.now();
        if (now - bot.lastKill > this.room.settings.killCooldown * 1000) {
          const targets = alive.filter(p =>
            p.id !== bot.id &&
            p.role === 'crewmate' &&
            Math.hypot(p.x - bot.x, p.y - bot.y) < 75
          );
          if (targets.length && Math.random() < 0.3) {
            const victim = targets[Math.floor(Math.random() * targets.length)];
            this.doKill(bot, victim);
            bot.lastKill = now;
          }
        }
      }

      // Crewmate tasks
      if (bot.role === 'crewmate') {
        const task = bot.tasks.find(t => !t.done);
        if (task && Math.random() < 0.12) {
          task.done = true;
          bot.completedTasks++;
          this.checkTaskWin();
        }
      }
    }

    this.broadcast({ type: 'update', data: this.publicState() });
  }

  move(ws, { x, y }) {
    const session = this.sessions.get(ws);
    if (!session || !this.room || this.room.state !== 'playing') return;
    const p = this.room.players.get(session.id);
    if (!p || !p.alive) return;

    p.x = Math.max(20, Math.min(780, x));
    p.y = Math.max(20, Math.min(580, y));

    // Light broadcast of just this player
    this.broadcast({
      type: 'moved',
      data: { id: p.id, x: p.x, y: p.y }
    }, ws);
  }

  kill(ws, { targetId }) {
    const session = this.sessions.get(ws);
    if (!session || !this.room || this.room.state !== 'playing') return;
    const killer = this.room.players.get(session.id);
    if (!killer || killer.role !== 'impostor' || !killer.alive) return;

    const now = Date.now();
    if (now - killer.lastKill < this.room.settings.killCooldown * 1000) return;

    const target = this.room.players.get(targetId);
    if (!target || !target.alive) return;
    if (Math.hypot(target.x - killer.x, target.y - killer.y) > 85) return;

    killer.lastKill = now;
    this.doKill(killer, target);
  }

  doKill(killer, victim) {
    victim.alive = false;
    this.room.bodies.push({
      id: victim.id,
      name: victim.name,
      color: victim.color,
      x: victim.x,
      y: victim.y
    });

    this.broadcast({
      type: 'killed',
      data: { victimId: victim.id, x: victim.x, y: victim.y }
    });

    this.checkWin();
  }

  report(ws) {
    const session = this.sessions.get(ws);
    if (!session || !this.room || this.room.state !== 'playing') return;
    const p = this.room.players.get(session.id);
    if (!p || !p.alive) return;

    const near = this.room.bodies.some(b => Math.hypot(b.x - p.x, b.y - p.y) < 90);
    if (!near && this.room.bodies.length === 0) return;

    this.startMeeting(`${p.name} reported a body`);
  }

  emergency(ws) {
    const session = this.sessions.get(ws);
    if (!session || !this.room || this.room.state !== 'playing') return;
    const p = this.room.players.get(session.id);
    if (!p || !p.alive) return;

    this.startMeeting(`${p.name} called an emergency meeting`);
  }

  startMeeting(reason) {
    this.room.state = 'meeting';
    this.room.votes = {};
    this.room.bodies = [];
    for (const p of this.room.players.values()) p.voted = false;

    this.broadcast({
      type: 'meeting',
      data: {
        reason,
        players: this.publicState().players,
        discussion: this.room.discussionTime,
        voting: this.room.votingTime
      }
    });

    const total = (this.room.discussionTime + this.room.votingTime) * 1000;
    if (this.room.meetingTimer) clearTimeout(this.room.meetingTimer);
    this.room.meetingTimer = setTimeout(() => this.endMeeting(), total);
  }

  vote(ws, { targetId }) {
    const session = this.sessions.get(ws);
    if (!session || !this.room || this.room.state !== 'meeting') return;
    const voter = this.room.players.get(session.id);
    if (!voter || !voter.alive || voter.voted) return;

    voter.voted = true;
    this.room.votes[session.id] = targetId;

    this.broadcast({
      type: 'voteUpdate',
      data: {
        voted: Object.keys(this.room.votes).length,
        total: [...this.room.players.values()].filter(p => p.alive).length
      }
    });
  }

  endMeeting() {
    if (!this.room || this.room.state !== 'meeting') return;

    const counts = {};
    let skips = 0;
    for (const t of Object.values(this.room.votes)) {
      if (!t || t === 'skip') skips++;
      else counts[t] = (counts[t] || 0) + 1;
    }

    let max = 0, ejected = null, tie = false;
    for (const [id, c] of Object.entries(counts)) {
      if (c > max) { max = c; ejected = id; tie = false; }
      else if (c === max) tie = true;
    }

    if (tie || max === 0 || skips >= max) ejected = null;

    let ejectedPlayer = null;
    if (ejected) {
      ejectedPlayer = this.room.players.get(ejected);
      if (ejectedPlayer) ejectedPlayer.alive = false;
    }

    this.room.state = 'playing';
    this.broadcast({
      type: 'meetingEnd',
      data: {
        ejected: ejectedPlayer
          ? { id: ejectedPlayer.id, name: ejectedPlayer.name, role: ejectedPlayer.role }
          : null,
        tie: !ejectedPlayer
      }
    });

    this.checkWin();
    if (this.room.state === 'playing') {
      this.broadcast({ type: 'update', data: this.publicState() });
    }
  }

  completeTask(ws, { taskId }) {
    const session = this.sessions.get(ws);
    if (!session || !this.room || this.room.state !== 'playing') return;
    const p = this.room.players.get(session.id);
    if (!p || p.role !== 'crewmate' || !p.alive) return;

    const task = p.tasks.find(t => t.id === taskId && !t.done);
    if (!task) return;

    task.done = true;
    p.completedTasks++;
    this.send(ws, {
      type: 'taskDone',
      data: { taskId, completed: p.completedTasks, total: p.tasks.length }
    });
    this.checkTaskWin();
    this.broadcast({ type: 'update', data: this.publicState() });
  }

  checkWin() {
    const alive = [...this.room.players.values()].filter(p => p.alive);
    const crew = alive.filter(p => p.role === 'crewmate').length;
    const imp = alive.filter(p => p.role === 'impostor').length;

    if (imp === 0) this.endGame('crew');
    else if (imp >= crew) this.endGame('impostor');
  }

  checkTaskWin() {
    const crew = [...this.room.players.values()].filter(p => p.role === 'crewmate');
    if (crew.length === 0) return;
    const allDone = crew.every(c => c.completedTasks >= (c.tasks.length || 1));
    if (allDone) this.endGame('crew');
  }

  endGame(winner) {
    this.room.state = 'ended';
    this.room.winner = winner;
    if (this.botInterval) {
      clearInterval(this.botInterval);
      this.botInterval = null;
    }
    this.broadcast({
      type: 'gameOver',
      data: { winner, players: this.publicState().players }
    });
  }

  handleClose(ws) {
    const session = this.sessions.get(ws);
    this.sessions.delete(ws);
    if (!session || !this.room) return;

    this.room.players.delete(session.id);

    // Transfer host
    if (this.room.hostId === session.id) {
      const next = [...this.room.players.values()].find(p => !p.isBot);
      this.room.hostId = next ? next.id : null;
    }

    // Cleanup empty room
    const humans = [...this.room.players.values()].filter(p => !p.isBot);
    if (humans.length === 0) {
      if (this.botInterval) clearInterval(this.botInterval);
      this.room = null;
      return;
    }

    this.broadcast({ type: 'update', data: this.publicState() });
  }

  publicState() {
    if (!this.room) return null;
    return {
      code: this.room.code,
      state: this.room.state,
      settings: this.room.settings,
      hostId: this.room.hostId,
      winner: this.room.winner,
      bodies: this.room.bodies,
      players: [...this.room.players.values()].map(p => ({
        id: p.id,
        name: p.name,
        color: p.color,
        x: p.x,
        y: p.y,
        alive: p.alive,
        isBot: p.isBot,
        role: (this.room.state === 'ended' || !p.alive) ? p.role : undefined,
        completedTasks: p.completedTasks,
        taskTotal: p.tasks?.length || 0
      }))
    };
  }

  send(ws, msg) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {}
  }

  broadcast(msg, except = null) {
    const raw = JSON.stringify(msg);
    for (const ws of this.sessions.keys()) {
      if (ws !== except) {
        try { ws.send(raw); } catch {}
      }
    }
  }
}
