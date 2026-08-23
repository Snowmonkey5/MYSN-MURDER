const COLORS = [
  '#e74c3c','#3498db','#2ecc71','#f1c40f','#9b59b6',
  '#e67e22','#1abc9c','#e91e63','#00bcd4','#ff5722','#8e44ad','#16a085'
];

const TASKS = [
  { id: 'wires', name: 'Fix Wires' },
  { id: 'download', name: 'Download Data' },
  { id: 'upload', name: 'Upload Data' },
  { id: 'fuel', name: 'Fuel Engines' },
  { id: 'scan', name: 'Medbay Scan' },
  { id: 'card', name: 'Swipe Card' },
  { id: 'calibrate', name: 'Calibrate' },
  { id: 'clean', name: 'Clean Filters' },
  { id: 'steer', name: 'Stabilize Steering' },
  { id: 'trash', name: 'Empty Garbage' }
];

export class GameRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sessions = new Map(); // ws -> { id }
    this.room = null;
    this.botTimer = null;
  }

  async fetch(request) {
    const upgrade = request.headers.get('Upgrade');
    if (!upgrade || upgrade.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket. Room is alive.', {
        status: 426,
        headers: { 'Content-Type': 'text/plain' }
      });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // Hibernation API (required for free-plan SQLite Durable Objects)
    this.ctx.acceptWebSocket(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  // ---- Hibernation handlers (these actually fire on free plan) ----
  async webSocketMessage(ws, message) {
    let msg;
    try {
      msg = typeof message === 'string' ? JSON.parse(message) : JSON.parse(new TextDecoder().decode(message));
    } catch {
      this.send(ws, { type: 'error', data: 'Bad JSON' });
      return;
    }
    const { type, data } = msg || {};
    try {
      if (type === 'join') this.join(ws, data || {});
      else if (type === 'settings') this.updateSettings(ws, data || {});
      else if (type === 'start') this.startGame(ws);
      else if (type === 'move') this.move(ws, data || {});
      else if (type === 'kill') this.kill(ws, data || {});
      else if (type === 'report') this.report(ws);
      else if (type === 'emergency') this.emergency(ws);
      else if (type === 'task') this.completeTask(ws, data || {});
      else if (type === 'vote') this.vote(ws, data || {});
      else if (type === 'ping') this.send(ws, { type: 'pong' });
      else this.send(ws, { type: 'error', data: 'Unknown type: ' + type });
    } catch (err) {
      this.send(ws, { type: 'error', data: 'Server error: ' + (err.message || String(err)) });
    }
  }

  async webSocketClose(ws) {
    this.handleClose(ws);
  }

  async webSocketError(ws) {
    this.handleClose(ws);
  }

  ensureRoom(code) {
    if (!this.room) {
      this.room = {
        code,
        hostId: null,
        state: 'lobby',
        players: new Map(),
        settings: { maxPlayers: 12, impostors: 1, botCount: 3, killCooldown: 20, taskCount: 5 },
        bodies: [],
        votes: {},
        discussionTime: 25,
        votingTime: 40,
        winner: null
      };
    }
    return this.room;
  }

  join(ws, { name, code, hostOnly }) {
    const room = this.ensureRoom((code || 'XXXX').toUpperCase());
    if (room.state !== 'lobby') return this.send(ws, { type: 'error', data: 'Game already started' });
    if (room.players.size >= room.settings.maxPlayers) return this.send(ws, { type: 'error', data: 'Room full' });

    const id = crypto.randomUUID();
    const used = [...room.players.values()].map(p => p.color);
    const color = hostOnly ? '#1C9455' : (COLORS.find(c => !used.includes(c)) || COLORS[0]);

    const player = {
      id,
      name: String(name || (hostOnly ? 'Host' : 'Player')).slice(0, 12),
      color,
      x: 400 + (Math.random() - 0.5) * 100,
      y: 300 + (Math.random() - 0.5) * 80,
      role: null,
      alive: true,
      isBot: false,
      hostOnly: !!hostOnly,
      tasks: [],
      completedTasks: 0,
      lastKill: 0,
      voted: false
    };

    room.players.set(id, player);
    this.sessions.set(ws, { id });
    if (!room.hostId) room.hostId = id;

    this.send(ws, {
      type: 'joined',
      data: { id, isHost: room.hostId === id, hostOnly: !!hostOnly, state: this.publicState() }
    });
    this.broadcast({ type: 'update', data: this.publicState() }, ws);
  }

  updateSettings(ws, settings) {
    const s = this.sessions.get(ws);
    if (!s || !this.room || this.room.hostId !== s.id || this.room.state !== 'lobby') return;
    Object.assign(this.room.settings, settings);
    this.broadcast({ type: 'settings', data: this.room.settings });
  }

  startGame(ws) {
    const s = this.sessions.get(ws);
    if (!s || !this.room || this.room.hostId !== s.id || this.room.state !== 'lobby') {
      return this.send(ws, { type: 'error', data: 'Only host can start' });
    }

    const curBots = [...this.room.players.values()].filter(p => p.isBot).length;
    const target = this.room.settings.botCount || 0;
    for (let i = curBots; i < target; i++) {
      const bid = 'bot_' + crypto.randomUUID().slice(0, 8);
      const used = [...this.room.players.values()].map(p => p.color);
      this.room.players.set(bid, {
        id: bid, name: 'Bot ' + (i + 1),
        color: COLORS.find(c => !used.includes(c)) || COLORS[i % COLORS.length],
        x: 400 + (Math.random() - 0.5) * 200, y: 300 + (Math.random() - 0.5) * 150,
        role: null, alive: true, isBot: true, hostOnly: false,
        tasks: [], completedTasks: 0, lastKill: 0, voted: false
      });
    }

    const playable = [...this.room.players.values()].filter(p => !p.hostOnly);
    if (playable.length < 2) {
      return this.send(ws, { type: 'error', data: 'Need at least 2 players (add bots!)' });
    }

    const impCount = Math.min(this.room.settings.impostors, Math.max(1, Math.floor(playable.length / 3)));
    const shuffled = [...playable].sort(() => Math.random() - 0.5);
    shuffled.forEach((p, i) => {
      p.role = i < impCount ? 'impostor' : 'crewmate';
      p.alive = true; p.completedTasks = 0; p.voted = false; p.lastKill = 0; p.tasks = [];
      if (p.role === 'crewmate') {
        p.tasks = [...TASKS].sort(() => Math.random() - 0.5)
          .slice(0, this.room.settings.taskCount)
          .map(t => ({ ...t, done: false }));
      }
    });
    for (const p of this.room.players.values()) {
      if (p.hostOnly) { p.role = null; p.alive = true; }
    }

    this.room.state = 'playing';
    this.room.bodies = [];
    this.room.votes = {};
    this.room.winner = null;

    for (const [sock, sess] of this.sessions) {
      const p = this.room.players.get(sess.id);
      if (p && !p.hostOnly) {
        this.send(sock, { type: 'role', data: { role: p.role, tasks: p.tasks } });
      }
    }
    this.broadcast({ type: 'started', data: this.publicState() });

    if (this.botTimer) clearInterval(this.botTimer);
    this.botTimer = setInterval(() => this.updateBots(), 700);
  }

  updateBots() {
    if (!this.room || this.room.state !== 'playing') return;
    const alive = [...this.room.players.values()].filter(p => p.alive && !p.hostOnly);
    for (const bot of alive.filter(p => p.isBot)) {
      if (Math.random() < 0.45) {
        bot.x = Math.max(30, Math.min(770, bot.x + (Math.random() - 0.5) * 55));
        bot.y = Math.max(30, Math.min(570, bot.y + (Math.random() - 0.5) * 55));
      }
      if (bot.role === 'impostor') {
        const now = Date.now();
        if (now - bot.lastKill > this.room.settings.killCooldown * 1000) {
          const targets = alive.filter(p =>
            p.id !== bot.id && p.role === 'crewmate' && Math.hypot(p.x - bot.x, p.y - bot.y) < 75
          );
          if (targets.length && Math.random() < 0.3) {
            this.doKill(bot, targets[Math.floor(Math.random() * targets.length)]);
            bot.lastKill = now;
          }
        }
      }
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
    const s = this.sessions.get(ws);
    if (!s || !this.room || this.room.state !== 'playing') return;
    const p = this.room.players.get(s.id);
    if (!p || !p.alive || p.hostOnly) return;
    p.x = Math.max(20, Math.min(780, Number(x) || p.x));
    p.y = Math.max(20, Math.min(580, Number(y) || p.y));
    this.broadcast({ type: 'moved', data: { id: p.id, x: p.x, y: p.y } }, ws);
  }

  kill(ws, { targetId }) {
    const s = this.sessions.get(ws);
    if (!s || !this.room || this.room.state !== 'playing') return;
    const killer = this.room.players.get(s.id);
    if (!killer || killer.hostOnly || killer.role !== 'impostor' || !killer.alive) return;
    if (Date.now() - killer.lastKill < this.room.settings.killCooldown * 1000) return;
    const target = this.room.players.get(targetId);
    if (!target || !target.alive || target.hostOnly) return;
    if (Math.hypot(target.x - killer.x, target.y - killer.y) > 85) return;
    killer.lastKill = Date.now();
    this.doKill(killer, target);
  }

  doKill(killer, victim) {
    victim.alive = false;
    this.room.bodies.push({ id: victim.id, name: victim.name, color: victim.color, x: victim.x, y: victim.y });
    this.broadcast({ type: 'killed', data: { victimId: victim.id, x: victim.x, y: victim.y } });
    this.checkWin();
  }

  report(ws) {
    const s = this.sessions.get(ws);
    if (!s || !this.room || this.room.state !== 'playing') return;
    const p = this.room.players.get(s.id);
    if (!p || !p.alive || p.hostOnly) return;
    const near = this.room.bodies.some(b => Math.hypot(b.x - p.x, b.y - p.y) < 90);
    if (!near && !this.room.bodies.length) return;
    this.startMeeting(p.name + ' reported a body');
  }

  emergency(ws) {
    const s = this.sessions.get(ws);
    if (!s || !this.room || this.room.state !== 'playing') return;
    const p = this.room.players.get(s.id);
    if (!p || !p.alive || p.hostOnly) return;
    this.startMeeting(p.name + ' called emergency meeting');
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
    setTimeout(() => this.endMeeting(), (this.room.discussionTime + this.room.votingTime) * 1000);
  }

  vote(ws, { targetId }) {
    const s = this.sessions.get(ws);
    if (!s || !this.room || this.room.state !== 'meeting') return;
    const voter = this.room.players.get(s.id);
    if (!voter || !voter.alive || voter.voted || voter.hostOnly) return;
    voter.voted = true;
    this.room.votes[s.id] = targetId;
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
    let ep = null;
    if (ejected) {
      ep = this.room.players.get(ejected);
      if (ep) ep.alive = false;
    }
    this.room.state = 'playing';
    this.broadcast({
      type: 'meetingEnd',
      data: { ejected: ep ? { id: ep.id, name: ep.name, role: ep.role } : null, tie: !ep }
    });
    this.checkWin();
    if (this.room.state === 'playing') this.broadcast({ type: 'update', data: this.publicState() });
  }

  completeTask(ws, { taskId }) {
    const s = this.sessions.get(ws);
    if (!s || !this.room || this.room.state !== 'playing') return;
    const p = this.room.players.get(s.id);
    if (!p || p.hostOnly || p.role !== 'crewmate' || !p.alive) return;
    const task = p.tasks.find(t => t.id === taskId && !t.done);
    if (!task) return;
    task.done = true;
    p.completedTasks++;
    this.send(ws, { type: 'taskDone', data: { taskId, completed: p.completedTasks, total: p.tasks.length } });
    this.checkTaskWin();
    this.broadcast({ type: 'update', data: this.publicState() });
  }

  checkWin() {
    const alive = [...this.room.players.values()].filter(p => p.alive && !p.hostOnly);
    const crew = alive.filter(p => p.role === 'crewmate').length;
    const imp = alive.filter(p => p.role === 'impostor').length;
    if (imp === 0) this.endGame('crew');
    else if (imp >= crew) this.endGame('impostor');
  }

  checkTaskWin() {
    const crew = [...this.room.players.values()].filter(p => p.role === 'crewmate' && !p.hostOnly);
    if (crew.length && crew.every(c => c.completedTasks >= (c.tasks.length || 1))) this.endGame('crew');
  }

  endGame(winner) {
    this.room.state = 'ended';
    this.room.winner = winner;
    if (this.botTimer) { clearInterval(this.botTimer); this.botTimer = null; }
    this.broadcast({ type: 'gameOver', data: { winner, players: this.publicState().players } });
  }

  handleClose(ws) {
    const s = this.sessions.get(ws);
    this.sessions.delete(ws);
    if (!s || !this.room) return;
    this.room.players.delete(s.id);
    if (this.room.hostId === s.id) {
      const next = [...this.room.players.values()].find(p => !p.isBot);
      this.room.hostId = next ? next.id : null;
    }
    if (![...this.room.players.values()].some(p => !p.isBot)) {
      if (this.botTimer) clearInterval(this.botTimer);
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
        id: p.id, name: p.name, color: p.color, x: p.x, y: p.y,
        alive: p.alive, isBot: p.isBot, hostOnly: !!p.hostOnly,
        role: (this.room.state === 'ended' || !p.alive) ? p.role : undefined,
        completedTasks: p.completedTasks, taskTotal: p.tasks?.length || 0
      }))
    };
  }

  send(ws, msg) {
    try { ws.send(JSON.stringify(msg)); } catch {}
  }

  broadcast(msg, except) {
    const raw = JSON.stringify(msg);
    for (const ws of this.sessions.keys()) {
      if (ws !== except) try { ws.send(raw); } catch {}
    }
  }
}
