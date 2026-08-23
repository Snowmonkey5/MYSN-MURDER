// MYSN MURDER client - Cloudflare + Host Only + color #1C9455
const params = new URLSearchParams(location.search);
let roomCode = (params.get('room') || '').toUpperCase();
let ws = null;
let myId = null;
let myRole = null;
let myTasks = [];
let roomState = null;
let isHost = false;
let isHostOnly = false;
let keys = {};
let canvas, ctx;
let animId = null;
let isMobile = false;
let joystick = { active: false, dx: 0, dy: 0 };
let lastMove = 0;

const screens = {
  menu: document.getElementById('menuScreen'),
  lobby: document.getElementById('lobbyScreen'),
  game: document.getElementById('gameScreen'),
  end: document.getElementById('endScreen')
};

function show(name) {
  Object.values(screens).forEach(s => s.classList.remove('active'));
  screens[name].classList.add('active');
}

function toast(msg, color = '#1C9455') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.style.background = color;
  t.style.display = 'block';
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.style.display = 'none', 2800);
}

function connect(code, hostOnly = false) {
  isHostOnly = hostOnly;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${location.host}/ws/${code}`;
  ws = new WebSocket(url);

  ws.onopen = () => {
    const name = document.getElementById('playerName').value.trim() || (hostOnly ? 'Host' : 'Player');
    send('join', { name, code, hostOnly });
  };

  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    handle(msg);
  };

  ws.onclose = () => {};
}

function send(type, data = {}) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type, data }));
}

function handle(msg) {
  const { type, data } = msg;

  switch (type) {
    case 'joined':
      myId = data.id;
      isHost = data.isHost;
      isHostOnly = !!data.hostOnly;
      roomState = data.state;
      roomCode = data.state.code;
      document.getElementById('roomCodeDisplay').textContent = roomCode;
      document.getElementById('shareInfo').textContent =
        `Share code or link: ${location.origin}?room=${roomCode}`;

      if (isHost) {
        document.getElementById('hostControls').classList.remove('hidden');
        document.getElementById('waitingText').classList.add('hidden');
      } else {
        document.getElementById('hostControls').classList.add('hidden');
        document.getElementById('waitingText').classList.remove('hidden');
      }

      if (isHostOnly) {
        document.getElementById('hostOnlyNote').classList.remove('hidden');
      } else {
        document.getElementById('hostOnlyNote').classList.add('hidden');
      }

      updateLobby(data.state);
      show('lobby');
      history.replaceState(null, '', `?room=${roomCode}`);
      break;

    case 'update':
      roomState = data;
      if (data.state === 'lobby') updateLobby(data);
      break;

    case 'settings':
      if (roomState) roomState.settings = data;
      break;

    case 'role':
      if (isHostOnly) return; // host only never gets a role
      myRole = data.role;
      myTasks = data.tasks || [];
      document.getElementById('roleBadge').textContent = `Role: ${myRole.toUpperCase()}`;
      document.getElementById('roleBadge').style.color = myRole === 'impostor' ? '#ff4757' : '#1C9455';
      const reveal = document.getElementById('roleReveal');
      const rt = document.getElementById('roleText');
      const rd = document.getElementById('roleDesc');
      rt.textContent = myRole.toUpperCase();
      rt.style.color = myRole === 'impostor' ? '#ff4757' : '#1C9455';
      rd.textContent = myRole === 'impostor'
        ? 'Eliminate the crewmates without getting caught'
        : 'Finish your tasks and find the impostor';
      reveal.classList.add('active');
      break;

    case 'started':
      roomState = data;
      if (isHostOnly) {
        // Host only stays in a simple view or goes to game as spectator
        document.getElementById('roleBadge').textContent = 'HOST (watching)';
        document.getElementById('roleBadge').style.color = '#1C9455';
        document.getElementById('tasksContent').textContent = 'Spectator mode';
      }
      show('game');
      initCanvas();
      detectMobile();
      startLoop();
      if (!isHostOnly) updateTasks();
      break;

    case 'moved':
      if (!roomState) return;
      const p = roomState.players.find(pl => pl.id === data.id);
      if (p) { p.x = data.x; p.y = data.y; }
      break;

    case 'killed':
      toast('A body was found!', '#da3633');
      if (roomState) {
        const vic = roomState.players.find(pl => pl.id === data.victimId);
        if (vic) vic.alive = false;
      }
      break;

    case 'taskDone':
      toast(`Task complete (${data.completed}/${data.total})`);
      updateTasks();
      break;

    case 'meeting':
      document.getElementById('meetingReason').textContent = data.reason;
      document.getElementById('meetingOverlay').classList.add('active');
      const list = document.getElementById('voteList');
      list.innerHTML = '';
      data.players.filter(p => p.alive && !p.hostOnly).forEach(p => {
        const btn = document.createElement('button');
        btn.className = 'vote-btn';
        btn.innerHTML = `<div class="color-dot" style="background:${p.color}"></div>${p.name}`;
        btn.onclick = () => {
          if (isHostOnly) return; // host only can't vote
          document.querySelectorAll('.vote-btn').forEach(b => b.classList.remove('selected'));
          btn.classList.add('selected');
          send('vote', { targetId: p.id });
        };
        list.appendChild(btn);
      });
      let left = data.discussion + data.voting;
      const timer = document.getElementById('meetingTimer');
      const iv = setInterval(() => {
        left--;
        timer.textContent = left > data.voting
          ? `Discussion: ${left - data.voting}s`
          : `Voting: ${left}s`;
        if (left <= 0) clearInterval(iv);
      }, 1000);
      break;

    case 'meetingEnd':
      document.getElementById('meetingOverlay').classList.remove('active');
      if (data.tie || !data.ejected) toast('No one was ejected');
      else toast(`${data.ejected.name} was ejected (${data.ejected.role})`, '#da3633');
      break;

    case 'gameOver':
      cancelAnimationFrame(animId);
      show('end');
      const title = document.getElementById('endTitle');
      const sub = document.getElementById('endSubtitle');
      if (data.winner === 'crew') {
        title.textContent = 'CREWMATES WIN';
        title.style.color = '#1C9455';
        sub.textContent = 'Tasks finished or impostors eliminated!';
      } else {
        title.textContent = 'IMPOSTORS WIN';
        title.style.color = '#ff4757';
        sub.textContent = 'The murderers took control...';
      }
      const box = document.getElementById('endPlayers');
      box.innerHTML = '';
      data.players.filter(p => !p.hostOnly).forEach(p => {
        const d = document.createElement('div');
        d.style.margin = '6px';
        d.innerHTML = `<span style="color:${p.color}">●</span> ${p.name} — <strong>${p.role || '?'}</strong>${p.isBot ? ' 🤖' : ''}`;
        box.appendChild(d);
      });
      break;

    case 'error':
      toast(data, '#da3633');
      break;
  }
}

function updateLobby(state) {
  roomState = state;
  const c = document.getElementById('lobbyPlayers');
  c.innerHTML = '';
  (state.players || []).forEach(p => {
    const chip = document.createElement('div');
    chip.className = 'player-chip';
    let label = p.name;
    if (p.isBot) label += ' 🤖';
    if (p.hostOnly) label += ' (Host)';
    chip.innerHTML = `<div class="color-dot" style="background:${p.color || '#1C9455'}"></div>${label}`;
    c.appendChild(chip);
  });
}

// Buttons
document.getElementById('btnCreate').onclick = () => {
  const code = Array.from({ length: 4 }, () =>
    'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]
  ).join('');
  connect(code, false);
};

document.getElementById('btnCreateHost').onclick = () => {
  const code = Array.from({ length: 4 }, () =>
    'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]
  ).join('');
  connect(code, true);
};

document.getElementById('btnJoin').onclick = () => {
  const code = document.getElementById('joinCode').value.trim().toUpperCase();
  if (code.length !== 4) return toast('Enter a 4-letter code', '#da3633');
  connect(code, false);
};

if (roomCode && roomCode.length === 4) {
  document.getElementById('joinCode').value = roomCode;
}

document.getElementById('botSlider').oninput = (e) => {
  document.getElementById('botCountLabel').textContent = e.target.value;
  send('settings', { botCount: +e.target.value });
};
document.getElementById('impSlider').oninput = (e) => {
  document.getElementById('impLabel').textContent = e.target.value;
  send('settings', { impostors: +e.target.value });
};
document.getElementById('btnStart').onclick = () => send('start');
document.getElementById('btnRoleOk').onclick = () => {
  document.getElementById('roleReveal').classList.remove('active');
};
document.getElementById('btnSkip').onclick = () => {
  if (!isHostOnly) {
    send('vote', { targetId: null });
    toast('Vote skipped');
  }
};
document.getElementById('btnBackMenu').onclick = () => location.href = location.pathname;

// Canvas & controls
function initCanvas() {
  canvas = document.getElementById('gameCanvas');
  ctx = canvas.getContext('2d');
  resize();
  window.addEventListener('resize', resize);
}
function resize() {
  canvas.width = canvas.clientWidth * devicePixelRatio;
  canvas.height = canvas.clientHeight * devicePixelRatio;
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
}

function detectMobile() {
  isMobile = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  if (isMobile && !isHostOnly) {
    document.getElementById('mobileControls').classList.add('visible');
    setupJoystick();
    setupButtons();
  }
}

window.addEventListener('keydown', e => { keys[e.key.toLowerCase()] = true; });
window.addEventListener('keyup', e => { keys[e.key.toLowerCase()] = false; });
window.addEventListener('keydown', e => {
  if (isHostOnly) return;
  if (e.key === 'q') tryKill();
  if (e.key === 'r') send('report');
  if (e.key === 'e') tryTask();
  if (e.key === 'f') send('emergency');
});

function setupJoystick() {
  const zone = document.getElementById('joystickZone');
  const knob = document.getElementById('joystickKnob');
  const max = 42;
  const start = e => { e.preventDefault(); joystick.active = true; };
  const move = e => {
    if (!joystick.active) return;
    e.preventDefault();
    const t = e.touches ? e.touches[0] : e;
    const r = zone.getBoundingClientRect();
    let dx = t.clientX - (r.left + r.width / 2);
    let dy = t.clientY - (r.top + r.height / 2);
    const d = Math.hypot(dx, dy);
    if (d > max) { dx = dx / d * max; dy = dy / d * max; }
    knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
    joystick.dx = dx / max;
    joystick.dy = dy / max;
  };
  const end = e => {
    e.preventDefault();
    joystick.active = false;
    joystick.dx = joystick.dy = 0;
    knob.style.transform = 'translate(-50%, -50%)';
  };
  zone.addEventListener('touchstart', start, { passive: false });
  zone.addEventListener('touchmove', move, { passive: false });
  zone.addEventListener('touchend', end, { passive: false });
  zone.addEventListener('mousedown', start);
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', end);
}

function setupButtons() {
  document.getElementById('btnKill').onclick = tryKill;
  document.getElementById('btnReport').onclick = () => send('report');
  document.getElementById('btnUse').onclick = tryTask;
  document.getElementById('btnMeeting').onclick = () => send('emergency');
}

function tryKill() {
  if (isHostOnly || myRole !== 'impostor' || !roomState) return;
  const me = roomState.players.find(p => p.id === myId);
  if (!me || !me.alive) return;
  let closest = null, min = 85;
  roomState.players.forEach(p => {
    if (p.id === myId || !p.alive || p.hostOnly) return;
    const d = Math.hypot(p.x - me.x, p.y - me.y);
    if (d < min) { min = d; closest = p; }
  });
  if (closest) send('kill', { targetId: closest.id });
}

function tryTask() {
  if (isHostOnly || myRole !== 'crewmate' || !myTasks.length) return;
  const t = myTasks.find(t => !t.done);
  if (t) {
    send('task', { taskId: t.id });
    t.done = true;
    updateTasks();
  }
}

function updateTasks() {
  const el = document.getElementById('tasksContent');
  if (isHostOnly) { el.textContent = 'Spectator'; return; }
  if (myRole === 'impostor') {
    el.innerHTML = '<div style="color:#ff4757">Kill the crew</div>';
    return;
  }
  if (!myTasks.length) { el.textContent = '—'; return; }
  el.innerHTML = myTasks.map(t =>
    `<div class="${t.done ? 'task-done' : ''}">${t.name}</div>`
  ).join('');
}

function startLoop() {
  function loop() {
    update();
    draw();
    animId = requestAnimationFrame(loop);
  }
  loop();
}

function update() {
  if (isHostOnly || !roomState || roomState.state !== 'playing') return;
  const me = roomState.players.find(p => p.id === myId);
  if (!me || !me.alive) return;

  let dx = 0, dy = 0;
  const spd = 3.4;
  if (keys['w'] || keys['arrowup']) dy -= 1;
  if (keys['s'] || keys['arrowdown']) dy += 1;
  if (keys['a'] || keys['arrowleft']) dx -= 1;
  if (keys['d'] || keys['arrowright']) dx += 1;
  if (joystick.active) { dx += joystick.dx; dy += joystick.dy; }

  if (dx || dy) {
    const len = Math.hypot(dx, dy) || 1;
    me.x += (dx / len) * spd;
    me.y += (dy / len) * spd;
    me.x = Math.max(20, Math.min(780, me.x));
    me.y = Math.max(20, Math.min(580, me.y));
    const now = Date.now();
    if (now - lastMove > 35) {
      send('move', { x: me.x, y: me.y });
      lastMove = now;
    }
  }
}

function draw() {
  if (!ctx || !roomState) return;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;

  ctx.fillStyle = '#0d1117';
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = '#161b22';
  ctx.lineWidth = 1;
  for (let x = 0; x < w; x += 48) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
  }
  for (let y = 0; y < h; y += 48) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }

  const scale = Math.min(w / 800, h / 600);
  const ox = (w - 800 * scale) / 2;
  const oy = (h - 600 * scale) / 2;

  ctx.save();
  ctx.translate(ox, oy);
  ctx.scale(scale, scale);

  const rooms = [
    { x: 40, y: 40, w: 220, h: 160, c: '#1a2332', l: 'Cafeteria' },
    { x: 290, y: 40, w: 220, h: 130, c: '#1a2a1a', l: 'Medbay' },
    { x: 540, y: 40, w: 220, h: 160, c: '#2a1a1a', l: 'Electrical' },
    { x: 40, y: 240, w: 200, h: 160, c: '#1a1a2a', l: 'Security' },
    { x: 280, y: 210, w: 240, h: 180, c: '#2a2a1a', l: 'Admin' },
    { x: 540, y: 240, w: 220, h: 160, c: '#1a2a2a', l: 'Weapons' },
    { x: 140, y: 450, w: 520, h: 110, c: '#1c1c22', l: 'Hallway' }
  ];
  rooms.forEach(r => {
    ctx.fillStyle = r.c;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(r.x, r.y, r.w, r.h, 10);
    else ctx.rect(r.x, r.y, r.w, r.h);
    ctx.fill();
    ctx.strokeStyle = '#30363d';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#6e7681';
    ctx.font = 'bold 13px sans-serif';
    ctx.fillText(r.l, r.x + 12, r.y + 22);
  });

  (roomState.bodies || []).forEach(b => {
    ctx.globalAlpha = 0.55;
    ctx.beginPath();
    ctx.ellipse(b.x, b.y + 6, 20, 12, 0, 0, Math.PI * 2);
    ctx.fillStyle = b.color;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.font = '16px serif';
    ctx.fillText('💀', b.x - 9, b.y - 12);
  });

  roomState.players.forEach(p => {
    if (!p.alive || p.hostOnly) return;

    ctx.beginPath();
    ctx.ellipse(p.x, p.y + 18, 14, 6, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fill();

    ctx.beginPath();
    ctx.arc(p.x, p.y, 17, 0, Math.PI * 2);
    ctx.fillStyle = p.color;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 2.5;
    ctx.stroke();

    ctx.beginPath();
    ctx.ellipse(p.x + 5, p.y - 3, 8, 6, 0.2, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(180,220,255,0.75)';
    ctx.fill();

    ctx.fillStyle = '#e6edf3';
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(p.name + (p.isBot ? ' 🤖' : ''), p.x, p.y - 26);

    if (p.id === myId) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 24, 0, Math.PI * 2);
      ctx.strokeStyle = '#1C9455';
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }
  });

  ctx.restore();
}
