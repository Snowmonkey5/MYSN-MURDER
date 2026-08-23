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
    this.sessions = new Map(); // ws -> playerId
    this.room = null;
    this.botTimer = null;
    this._loaded = false;
  }

  async load() {
    if (this._loaded) return;
    const saved = await this.ctx.storage.get('room');
    if (saved) this.room = this.reviveRoom(saved);
    this._loaded = true;
  }

  reviveRoom(data) {
    const players = new Map();
    if (data.players) {
      for (const [id, p] of Object.entries(data.players)) {
        players.set(id, p);
      }
    }
    return { ...data, players };
  }

  async save() {
    if (!this.room) {
      await this.ctx.storage.delete('room');
      return;
    }
    const players = {};
    for (const [id, p] of this.room.players) {
      players[id] = p;
    }
    await this.ctx.storage.put('room', { ...this.room, players });
  }

  async fetch(request) {
    await this.load();

    if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
      return new Response('WebSocket only. Room: ' + (this.room ? this.room.code : 'empty'), { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);
    // attachment set on join

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    await this.load();

    let msg;
    try {
      const text = typeof message === 'string' ? message : new TextDecoder().decode(message);
      msg = JSON.parse(text);
    } catch {
      this.safeSend(ws, { type: 'error', data: 'Bad JSON' });
      return;
    }

    const { type, data } = msg || {};
    try {
      if (type === 'join') await this.join(ws, data || {});
      else if (type === 'settings') await this.updateSettings(ws, data || {});
      else if (type === 'start') await this.startGame(ws);
      else if (type === 'move') await this.move(ws, data || {});
      else if (type === 'kill') await this.kill(ws, data || {});
      else if (type === 'report') await this.report(ws);
      else if (type === 'emergency') await this.emergency(ws);
      else if (type === 'task') await this.completeTask(ws, data || {});
      else if (type === 'vote') await this.vote(ws, data || {});
      else if (type === 'ping') this.safeSend(ws, { type: 'pong' });
      else this.safeSend(ws, { type: 'error', data: 'Unknown: ' + type });
    } catch (err) {
      this.safeSend(ws, { type: 'error', data: 'Error: ' + (err && err.message ? err.message : String(err)) });
    }
  }

  async webSocketClose(ws) {
    await this.load();
    await this.handleClose(ws);
  }

  async webSocketError(ws) {
    await this.load();
    await this.handleClose(ws);
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

  async join(ws, { name, code, hostOnly }) {
    const room = this.ensureRoom((code || 'XXXX').toUpperCase());
    if (room.state !== 'lobby') {
      this.safeSend(ws, { type: 'error', data: 'Game already started' });
      return;
    }
    if (room.players.size >= room.settings.maxPlayers) {
      this.safeSend(ws, { type: 'error', data: 'Room full' });
      return;
    }

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
    this.sessions.set(ws, id);
    try { ws.serializeAttachment({ id }); } catch {}

    if (!room.hostId) room.hostId = id;

    await this.save();

    this.safeSend(ws, {
      type: 'joined',
      data: { id, isHost: room.hostId === id, hostOnly: !!hostOnly, state: this.publicState() }
    });
    this.broadcast({ type: 'update', data: this.publicState() }, ws);
  }

  getPlayerId(ws) {
    if (this.sessions.has(ws)) return this.sessions.get(ws);
    try {
      const att = ws.deserializeAttachment();
      if (att && att.id) {
        this.sessions.set(ws, att.id);
        return att.id;
      }
    } catch {}
    return null;
  }

  async updateSettings(ws, settings) {
    const pid = this.getPlayerId(ws);
    if (!pid || !this.room || this.room.hostId !== pid || this.room.state !== 'lobby') return;
    Object.assign(this.room.settings, settings);
    await this.save();
    this.broadcast({ type: 'settings', data: this.room.settings });
  }

  async startGame(ws) {
    const pid = this.getPlayerId(ws);
    if (!pid || !this.room || this.room.hostId !== pid || this.room.state !== 'lobby') {
      this.safeSend(ws, { type: 'error', data: 'Only host can start' });
      return;
    }

    const curBots = [...this.room.players.values()].filter(p => p.isBot).length;
    const target = this.room.settings.botCount || 0;
    for (let i = curBots; i < target; i++) {
      const bid = 'bot_' + crypto.randomUUID().slice(0, 8);
      const used = [...this.room.players.values()].map(p => p.color);
      this.room.players.set(bid, {
        id: bid, name: 'Bot ' + (i + 1),
        color: COLORS.find(c => !used.includes(c)) || COLORS[i % COLORS.length],
        x: 400 + (Math.random() - 0.5) * 200,
        y: 300 + (Math.random() - 0.5) * 150,
        role: null, alive: true, isBot: true, hostOnly: false,
        tasks: [], completedTasks: 0, lastKill: 0, voted: false
      });
    }

    const playable = [...this.room.players.values()].filter(p => !p.hostOnly);
    if (playable.length < 2) {
      this.safeSend(ws, { type: 'error', data: 'Need at least 2 players (add bots!)' });
      return;
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
    await this.save();

    // Send roles to connected sockets
    for (const [sock, id] of this.sessions) {
      const p = this.room.players.get(id);
      if (p && !p.hostOnly) {
        this.safeSend(sock, { type: 'role', data: { role: p.role, tasks: p.tasks } });
      }
    }
    // Also try all hibernated sockets from ctx
    try {
      for (const sock of this.ctx.getWebSockets()) {
        const id = this.getPlayerId(sock);
        const p = id && this.room.players.get(id);
        if (p && !p.hostOnly) {
          this.safeSend(sock, { type: 'role', data: { role: p.role, tasks: p.tasks } });
        }
      }
    } catch {}

    this.broadcast({ type: 'started', data: this.publicState() });

    if (this.botTimer) clearInterval(this.botTimer);
    this.botTimer = setInterval(() => this.updateBots(), 800);
  }

  async updateBots() {
    await this.load();
    if (!this.room || this.room.state !== 'playing') return;
    const alive = [...this.room.players.values()].filter(p => p.alive && !p.hostOnly);
    for (const bot of alive.filter(p => p.isBot)) {
      if (Math.random() < 0.4) {
        bot.x = Math.max(30, Math.min(770, bot.x + (Math.random() - 0.5) * 50));
        bot.y = Math.max(30, Math.min(570, bot.y + (Math.random() - 0.5) * 50));
      }
      if (bot.role === 'impostor') {
        const now = Date.now();
        if (now - bot.lastKill > this.room.settings.killCooldown * 1000) {
          const targets = alive.filter(p =>
            p.id !== bot.id && p.role === 'crewmate' && Math.hypot(p.x - bot.x, p.y - bot.y) < 75
          );
          if (targets.length && Math.random() < 0.25) {
            this.doKill(bot, targets[Math.floor(Math.random() * targets.length)]);
            bot.lastKill = now;
          }
        }
      }
      if (bot.role === 'crewmate') {
        const task = bot.tasks.find(t => !t.done);
        if (task && Math.random() < 0.1) {
          task.done = true;
          bot.completedTasks++;
          this.checkTaskWin();
        }
      }
    }
    await this.save();
    this.broadcast({ type: 'update', data: this.publicState() });
  }

  async move(ws, { x, y }) {
    const pid = this.getPlayerId(ws);
    if (!pid || !this.room || this.room.state !== 'playing') return;
    const p = this.room.players.get(pid);
    if (!p || !p.alive || p.hostOnly) return;
    p.x = Math.max(20, Math.min(780, Number(x) || p.x));
    p.y = Math.max(20, Math.min(580, Number(y) || p.y));
    this.broadcast({ type: 'moved', data: { id: p.id, x: p.x, y: p.y } }, ws);
  }

  async kill(ws, { targetId }) {
    const pid = this.getPlayerId(ws);
    if (!pid || !this.room || this.room.state !== 'playing') return;
    const killer = this.room.players.get(pid);
    if (!killer || killer.hostOnly || killer.role !== 'impostor' || !killer.alive) return;
    if (Date.now() - killer.lastKill < this.room.settings.killCooldown * 1000) return;
    const target = this.room.players.get(targetId);
    if (!target || !target.alive || target.hostOnly) return;
    if (Math.hypot(target.x - killer.x, target.y - killer.y) > 85) return;
    killer.lastKill = Date.now();
    this.doKill(killer, target);
    await this.save();
  }

  doKill(killer, victim) {
    victim.alive = false;
    this.room.bodies.push({ id: victim.id, name: victim.name, color: victim.color, x: victim.x, y: victim.y });
    this.broadcast({ type: 'killed', data: { victimId: victim.id, x: victim.x, y: victim.y } });
    this.checkWin();
  }

  async report(ws) {
    const pid = this.getPlayerId(ws);
    if (!pid || !this.room || this.room.state !== 'playing') return;
    const p = this.room.players.get(pid);
    if (!p || !p.alive || p.hostOnly) return;
    const near = this.room.bodies.some(b => Math.hypot(b.x - p.x, b.y - p.y) < 90);
    if (!near && !this.room.bodies.length) return;
    await this.startMeeting(p.name + ' reported a body');
  }

  async emergency(ws) {
    const pid = this.getPlayerId(ws);
    if (!pid || !this.room || this.room.state !== 'playing') return;
    const p = this.room.players.get(pid);
    if (!p || !p.alive || p.hostOnly) return;
    await this.startMeeting(p.name + ' called emergency meeting');
  }

  async startMeeting(reason) {
    this.room.state = 'meeting';
    this.room.votes = {};
    this.room.bodies = [];
    for (const p of this.room.players.values()) p.voted = false;
    await this.save();
    this.broadcast({
      type: 'meeting',
      data: {
        reason,
        players: this.publicState().players,
        discussion: this.room.discussionTime,
        voting: this.room.votingTime
      }
    });
    // Use alarm for meeting end if possible
    try {
      await this.ctx.storage.setAlarm(Date.now() + (this.room.discussionTime + this.room.votingTime) * 1000);
    } catch {
      setTimeout(() => this.endMeeting(), (this.room.discussionTime + this.room.votingTime) * 1000);
    }
  }

  async alarm() {
    await this.load();
    await this.endMeeting();
  }

  async vote(ws, { targetId }) {
    const pid = this.getPlayerId(ws);
    if (!pid || !this.room || this.room.state !== 'meeting') return;
    const voter = this.room.players.get(pid);
    if (!voter || !voter.alive || voter.voted || voter.hostOnly) return;
    voter.voted = true;
    this.room.votes[pid] = targetId;
    await this.save();
  }

  async endMeeting() {
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
    await this.save();
    this.broadcast({
      type: 'meetingEnd',
      data: { ejected: ep ? { id: ep.id, name: ep.name, role: ep.role } : null, tie: !ep }
    });
    this.checkWin();
    if (this.room && this.room.state === 'playing') {
      this.broadcast({ type: 'update', data: this.publicState() });
    }
  }

  async completeTask(ws, { taskId }) {
    const pid = this.getPlayerId(ws);
    if (!pid || !this.room || this.room.state !== 'playing') return;
    const p = this.room.players.get(pid);
    if (!p || p.hostOnly || p.role !== 'crewmate' || !p.alive) return;
    const task = p.tasks.find(t => t.id === taskId && !t.done);
    if (!task) return;
    task.done = true;
    p.completedTasks++;
    await this.save();
    this.safeSend(ws, { type: 'taskDone', data: { taskId, completed: p.completedTasks, total: p.tasks.length } });
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

  async endGame(winner) {
    this.room.state = 'ended';
    this.room.winner = winner;
    if (this.botTimer) { clearInterval(this.botTimer); this.botTimer = null; }
    await this.save();
    this.broadcast({ type: 'gameOver', data: { winner, players: this.publicState().players } });
  }

  async handleClose(ws) {
    const pid = this.getPlayerId(ws);
    this.sessions.delete(ws);
    if (!pid || !this.room) return;
    this.room.players.delete(pid);
    if (this.room.hostId === pid) {
      const next = [...this.room.players.values()].find(p => !p.isBot);
      this.room.hostId = next ? next.id : null;
    }
    if (![...this.room.players.values()].some(p => !p.isBot)) {
      if (this.botTimer) clearInterval(this.botTimer);
      this.room = null;
      await this.save();
      return;
    }
    await this.save();
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
      bodies: this.room.bodies || [],
      players: [...this.room.players.values()].map(p => ({
        id: p.id, name: p.name, color: p.color, x: p.x, y: p.y,
        alive: p.alive, isBot: p.isBot, hostOnly: !!p.hostOnly,
        role: (this.room.state === 'ended' || !p.alive) ? p.role : undefined,
        completedTasks: p.completedTasks, taskTotal: (p.tasks && p.tasks.length) || 0
      }))
    };
  }

  safeSend(ws, msg) {
    try { ws.send(JSON.stringify(msg)); } catch {}
  }

  broadcast(msg, except) {
    const raw = JSON.stringify(msg);
    // Memory sessions
    for (const [ws] of this.sessions) {
      if (ws !== except) try { ws.send(raw); } catch {}
    }
    // Hibernated sockets
    try {
      for (const ws of this.ctx.getWebSockets()) {
        if (ws !== except) try { ws.send(raw); } catch {}
      }
    } catch {}
  }
}
