const COLORS = [
  '#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6',
  '#e67e22', '#1abc9c', '#e91e63', '#00bcd4', '#ff5722'
];

const TASKS = [
  { id: 'wires', name: 'Fix Wires' },
  { id: 'download', name: 'Download Data' },
  { id: 'fuel', name: 'Fuel Engines' },
  { id: 'scan', name: 'Medbay Scan' },
  { id: 'card', name: 'Swipe Card' },
  { id: 'clean', name: 'Clean Filters' }
];

export class GameRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sessions = new Map();
    this.room = null;
    this.botTimer = null;
  }

  async fetch(request) {
    const upgrade = request.headers.get('Upgrade') || '';
    if (upgrade.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // Prefer hibernation API
    try {
      this.ctx.acceptWebSocket(server);
    } catch (e) {
      server.accept();
    }

    server.addEventListener('message', (event) => {
      try {
        this.onMessage(server, event.data);
      } catch (err) {
        try {
          server.send(JSON.stringify({ type: 'error', data: 'Server error: ' + err.message }));
        } catch (_) {}
      }
    });

    server.addEventListener('close', () => this.onClose(server));
    server.addEventListener('error', () => this.onClose(server));

    // Also handle hibernation webSocketMessage if available
    return new Response(null, { status: 101, webSocket: client });
  }

  // Hibernation handlers
  async webSocketMessage(ws, message) {
    try {
      this.onMessage(ws, message);
    } catch (err) {
      try {
        ws.send(JSON.stringify({ type: 'error', data: String(err.message || err) }));
      } catch (_) {}
    }
  }

  async webSocketClose(ws) {
    this.onClose(ws);
  }

  async webSocketError(ws) {
    this.onClose(ws);
  }

  ensure(code) {
    if (!this.room) {
      this.room = {
        code,
        hostId: null,
        state: 'lobby',
        players: new Map(),
        settings: { maxPlayers: 12, impostors: 1, botCount: 3, killCooldown: 20, taskCount: 4 },
        bodies: [],
        votes: {},
        discussion: 20,
        voting: 35,
        winner: null
      };
    }
    return this.room;
  }

  onMessage(ws, raw) {
    let msg;
    try {
      msg = typeof raw === 'string' ? JSON.parse(raw) : JSON.parse(String(raw));
    } catch {
      return;
    }
    const type = msg.type;
    const data = msg.data || {};

    if (type === 'join') this.join(ws, data);
    else if (type === 'settings') this.settings(ws, data);
    else if (type === 'start') this.start(ws);
    else if (type === 'move') this.move(ws, data);
    else if (type === 'kill') this.kill(ws, data);
    else if (type === 'report') this.report(ws);
    else if (type === 'emergency') this.emergency(ws);
    else if (type === 'task') this.task(ws, data);
    else if (type === 'vote') this.vote(ws, data);
    else if (type === 'ping') this.send(ws, { type: 'pong' });
  }

  join(ws, { name, code, hostOnly }) {
    const room = this.ensure((code || 'TEST').toUpperCase());
    if (room.state !== 'lobby') {
      return this.send(ws, { type: 'error', data: 'Game already started' });
    }

    const id = crypto.randomUUID();
    const used = [...room.players.values()].map((p) => p.color);
    const color = hostOnly
      ? '#1C9455'
      : COLORS.find((c) => !used.includes(c)) || COLORS[Math.floor(Math.random() * COLORS.length)];

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
      data: {
        id,
        isHost: room.hostId === id,
        hostOnly: !!hostOnly,
        state: this.pub()
      }
    });
    this.broadcast({ type: 'update', data: this.pub() }, ws);
  }

  settings(ws, s) {
    const sess = this.sessions.get(ws);
    if (!sess || !this.room || this.room.hostId !== sess.id || this.room.state !== 'lobby') return;
    Object.assign(this.room.settings, s);
    this.broadcast({ type: 'settings', data: this.room.settings });
  }

  start(ws) {
    const sess = this.sessions.get(ws);
    if (!sess || !this.room || this.room.hostId !== sess.id || this.room.state !== 'lobby') return;

    const curBots = [...this.room.players.values()].filter((p) => p.isBot).length;
    for (let i = curBots; i < (this.room.settings.botCount || 0); i++) {
      const bid = 'bot_' + crypto.randomUUID().slice(0, 6);
      const used = [...this.room.players.values()].map((p) => p.color);
      this.room.players.set(bid, {
        id: bid,
        name: 'Bot ' + (i + 1),
        color: COLORS.find((c) => !used.includes(c)) || COLORS[i % COLORS.length],
        x: 400 + (Math.random() - 0.5) * 200,
        y: 300 + (Math.random() - 0.5) * 150,
        role: null,
        alive: true,
        isBot: true,
        hostOnly: false,
        tasks: [],
        completedTasks: 0,
        lastKill: 0,
        voted: false
      });
    }

    const playable = [...this.room.players.values()].filter((p) => !p.hostOnly);
    if (playable.length < 2) {
      return this.send(ws, { type: 'error', data: 'Need at least 2 players (add bots!)' });
    }

    const impCount = Math.min(
      this.room.settings.impostors,
      Math.max(1, Math.floor(playable.length / 3))
    );
    const shuffled = [...playable].sort(() => Math.random() - 0.5);
    shuffled.forEach((p, i) => {
      p.role = i < impCount ? 'impostor' : 'crewmate';
      p.alive = true;
      p.completedTasks = 0;
      p.voted = false;
      p.tasks = [];
      p.lastKill = 0;
      if (p.role === 'crewmate') {
        p.tasks = [...TASKS]
          .sort(() => Math.random() - 0.5)
          .slice(0, this.room.settings.taskCount)
          .map((t) => ({ ...t, done: false }));
      }
    });

    for (const p of this.room.players.values()) {
      if (p.hostOnly) {
        p.role = null;
        p.alive = true;
      }
    }

    this.room.state = 'playing';
    this.room.bodies = [];
    this.room.votes = {};
    this.room.winner = null;

    for (const [sock, s] of this.sessions) {
      const p = this.room.players.get(s.id);
      if (p && !p.hostOnly) {
        this.send(sock, { type: 'role', data: { role: p.role, tasks: p.tasks } });
      }
    }

    this.broadcast({ type: 'started', data: this.pub() });

    if (this.botTimer) clearInterval(this.botTimer);
    this.botTimer = setInterval(() => this.bots(), 700);
  }

  bots() {
    if (!this.room || this.room.state !== 'playing') return;
    const alive = [...this.room.players.values()].filter((p) => p.alive && !p.hostOnly);
    for (const bot of alive.filter((p) => p.isBot)) {
      if (Math.random() < 0.4) {
        bot.x = Math.max(30, Math.min(770, bot.x + (Math.random() - 0.5) * 50));
        bot.y = Math.max(30, Math.min(570, bot.y + (Math.random() - 0.5) * 50));
      }
      if (bot.role === 'impostor') {
        const now = Date.now();
        if (now - bot.lastKill > this.room.settings.killCooldown * 1000) {
          const targets = alive.filter(
            (p) =>
              p.id !== bot.id &&
              p.role === 'crewmate' &&
              Math.hypot(p.x - bot.x, p.y - bot.y) < 70
          );
          if (targets.length && Math.random() < 0.25) {
            const v = targets[Math.floor(Math.random() * targets.length)];
            this.doKill(bot, v);
            bot.lastKill = now;
          }
        }
      }
      if (bot.role === 'crewmate') {
        const task = bot.tasks.find((t) => !t.done);
        if (task && Math.random() < 0.1) {
          task.done = true;
          bot.completedTasks++;
          this.checkTasks();
        }
      }
    }
    this.broadcast({ type: 'update', data: this.pub() });
  }

  move(ws, { x, y }) {
    const s = this.sessions.get(ws);
    if (!s || !this.room || this.room.state !== 'playing') return;
    const p = this.room.players.get(s.id);
    if (!p || !p.alive || p.hostOnly) return;
    p.x = Math.max(20, Math.min(780, x));
    p.y = Math.max(20, Math.min(580, y));
    this.broadcast({ type: 'moved', data: { id: p.id, x: p.x, y: p.y } }, ws);
  }

  kill(ws, { targetId }) {
    const s = this.sessions.get(ws);
    if (!s || !this.room || this.room.state !== 'playing') return;
    const k = this.room.players.get(s.id);
    if (!k || k.hostOnly || k.role !== 'impostor' || !k.alive) return;
    if (Date.now() - k.lastKill < this.room.settings.killCooldown * 1000) return;
    const t = this.room.players.get(targetId);
    if (!t || !t.alive || t.hostOnly) return;
    if (Math.hypot(t.x - k.x, t.y - k.y) > 85) return;
    k.lastKill = Date.now();
    this.doKill(k, t);
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
    this.broadcast({ type: 'killed', data: { victimId: victim.id, x: victim.x, y: victim.y } });
    this.checkWin();
  }

  report(ws) {
    const s = this.sessions.get(ws);
    if (!s || !this.room || this.room.state !== 'playing') return;
    const p = this.room.players.get(s.id);
    if (!p || !p.alive || p.hostOnly) return;
    const near = this.room.bodies.some((b) => Math.hypot(b.x - p.x, b.y - p.y) < 90);
    if (!near && !this.room.bodies.length) return;
    this.meeting(p.name + ' reported a body');
  }

  emergency(ws) {
    const s = this.sessions.get(ws);
    if (!s || !this.room || this.room.state !== 'playing') return;
    const p = this.room.players.get(s.id);
    if (!p || !p.alive || p.hostOnly) return;
    this.meeting(p.name + ' called emergency');
  }

  meeting(reason) {
    this.room.state = 'meeting';
    this.room.votes = {};
    this.room.bodies = [];
    for (const p of this.room.players.values()) p.voted = false;
    this.broadcast({
      type: 'meeting',
      data: {
        reason,
        players: this.pub().players,
        discussion: this.room.discussion,
        voting: this.room.voting
      }
    });
    setTimeout(() => this.endMeeting(), (this.room.discussion + this.room.voting) * 1000);
  }

  vote(ws, { targetId }) {
    const s = this.sessions.get(ws);
    if (!s || !this.room || this.room.state !== 'meeting') return;
    const v = this.room.players.get(s.id);
    if (!v || !v.alive || v.voted || v.hostOnly) return;
    v.voted = true;
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
    let max = 0,
      ejected = null,
      tie = false;
    for (const [id, c] of Object.entries(counts)) {
      if (c > max) {
        max = c;
        ejected = id;
        tie = false;
      } else if (c === max) tie = true;
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
      data: {
        ejected: ep ? { id: ep.id, name: ep.name, role: ep.role } : null,
        tie: !ep
      }
    });
    this.checkWin();
    if (this.room.state === 'playing') this.broadcast({ type: 'update', data: this.pub() });
  }

  task(ws, { taskId }) {
    const s = this.sessions.get(ws);
    if (!s || !this.room || this.room.state !== 'playing') return;
    const p = this.room.players.get(s.id);
    if (!p || p.hostOnly || p.role !== 'crewmate' || !p.alive) return;
    const t = p.tasks.find((x) => x.id === taskId && !x.done);
    if (!t) return;
    t.done = true;
    p.completedTasks++;
    this.send(ws, {
      type: 'taskDone',
      data: { taskId, completed: p.completedTasks, total: p.tasks.length }
    });
    this.checkTasks();
    this.broadcast({ type: 'update', data: this.pub() });
  }

  checkWin() {
    const alive = [...this.room.players.values()].filter((p) => p.alive && !p.hostOnly);
    const crew = alive.filter((p) => p.role === 'crewmate').length;
    const imp = alive.filter((p) => p.role === 'impostor').length;
    if (imp === 0) this.end('crew');
    else if (imp >= crew) this.end('impostor');
  }

  checkTasks() {
    const crew = [...this.room.players.values()].filter((p) => p.role === 'crewmate' && !p.hostOnly);
    if (crew.length && crew.every((c) => c.completedTasks >= (c.tasks.length || 1))) this.end('crew');
  }

  end(winner) {
    this.room.state = 'ended';
    this.room.winner = winner;
    if (this.botTimer) {
      clearInterval(this.botTimer);
      this.botTimer = null;
    }
    this.broadcast({ type: 'gameOver', data: { winner, players: this.pub().players } });
  }

  onClose(ws) {
    const s = this.sessions.get(ws);
    this.sessions.delete(ws);
    if (!s || !this.room) return;
    this.room.players.delete(s.id);
    if (this.room.hostId === s.id) {
      const next = [...this.room.players.values()].find((p) => !p.isBot);
      this.room.hostId = next ? next.id : null;
    }
    if (![...this.room.players.values()].some((p) => !p.isBot)) {
      if (this.botTimer) clearInterval(this.botTimer);
      this.room = null;
      return;
    }
    this.broadcast({ type: 'update', data: this.pub() });
  }

  pub() {
    if (!this.room) return null;
    return {
      code: this.room.code,
      state: this.room.state,
      settings: this.room.settings,
      hostId: this.room.hostId,
      winner: this.room.winner,
      bodies: this.room.bodies,
      players: [...this.room.players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        x: p.x,
        y: p.y,
        alive: p.alive,
        isBot: p.isBot,
        hostOnly: !!p.hostOnly,
        role: this.room.state === 'ended' || !p.alive ? p.role : undefined,
        completedTasks: p.completedTasks,
        taskTotal: p.tasks?.length || 0
      }))
    };
  }

  send(ws, msg) {
    try {
      ws.send(JSON.stringify(msg));
    } catch (_) {}
  }

  broadcast(msg, except) {
    const raw = JSON.stringify(msg);
    for (const ws of this.sessions.keys()) {
      if (ws !== except) {
        try {
          ws.send(raw);
        } catch (_) {}
      }
    }
  }
}
