const socket = io();

// ============== STATE ==============
let myId = null;
let myRole = null;
let myTasks = [];
let roomState = null;
let keys = {};
let canvas, ctx;
let animationId;
let isMobile = false;
let joystick = { active: false, dx: 0, dy: 0 };
let lastMoveSent = 0;

// ============== DOM ==============
const screens = {
  menu: document.getElementById('menuScreen'),
  lobby: document.getElementById('lobbyScreen'),
  game: document.getElementById('gameScreen'),
  end: document.getElementById('endScreen')
};

function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.remove('active'));
  screens[name].classList.add('active');
}

function toast(msg, color = '#238636') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.style.background = color;
  t.style.display = 'block';
  setTimeout(() => t.style.display = 'none', 2500);
}

// ============== MENU ==============
document.getElementById('btnCreate').onclick = () => {
  const name = document.getElementById('playerName').value.trim() || 'Host';
  socket.emit('createRoom', { name });
};

document.getElementById('btnJoin').onclick = () => {
  const name = document.getElementById('playerName').value.trim() || 'Player';
  const code = document.getElementById('joinCode').value.trim().toUpperCase();
  if (!code) return toast('Enter a room code', '#da3633');
  socket.emit('joinRoom', { code, name });
};

socket.on('roomCreated', (data) => {
  myId = socket.id;
  roomState = data.state;
  document.getElementById('roomCodeDisplay').textContent = data.code;
  document.getElementById('shareInfo').textContent =
    `Friends open http://${data.localIP}:3000 and join with code ${data.code}`;
  document.getElementById('hostControls').classList.remove('hidden');
  document.getElementById('waitingText').classList.add('hidden');
  updateLobby(data.state);
  showScreen('lobby');
});

socket.on('joined', (state) => {
  myId = socket.id;
  roomState = state;
  document.getElementById('roomCodeDisplay').textContent = state.code;
  document.getElementById('hostControls').classList.add('hidden');
  document.getElementById('waitingText').classList.remove('hidden');
  updateLobby(state);
  showScreen('lobby');
});

socket.on('playerJoined', updateLobby);
socket.on('playerLeft', updateLobby);
socket.on('settingsUpdated', (s) => {
  if (roomState) roomState.settings = s;
});

socket.on('error', (msg) => toast(msg, '#da3633'));

function updateLobby(state) {
  roomState = state;
  const container = document.getElementById('lobbyPlayers');
  container.innerHTML = '';
  state.players.forEach(p => {
    const chip = document.createElement('div');
    chip.className = 'player-chip';
    chip.innerHTML = `<div class="color-dot" style="background:${p.color}"></div>${p.name}${p.isBot ? ' 🤖' : ''}`;
    container.appendChild(chip);
  });
}

// Host settings
const botSlider = document.getElementById('botSlider');
const impSlider = document.getElementById('impSlider');
botSlider.oninput = () => {
  document.getElementById('botCountLabel').textContent = botSlider.value;
  socket.emit('updateSettings', { botCount: parseInt(botSlider.value) });
};
impSlider.oninput = () => {
  document.getElementById('impLabel').textContent = impSlider.value;
  socket.emit('updateSettings', { impostors: parseInt(impSlider.value) });
};

document.getElementById('btnStart').onclick = () => {
  socket.emit('startGame');
};

// ============== GAME START ==============
socket.on('yourRole', ({ role, tasks }) => {
  myRole = role;
  myTasks = tasks || [];
  document.getElementById('roleBadge').textContent = `Role: ${role.toUpperCase()}`;
  document.getElementById('roleBadge').style.color = role === 'impostor' ? '#ff4757' : '#3fb950';

  const reveal = document.getElementById('roleReveal');
  const roleText = document.getElementById('roleText');
  const roleDesc = document.getElementById('roleDesc');
  roleText.textContent = role.toUpperCase();
  roleText.style.color = role === 'impostor' ? '#ff4757' : '#3fb950';
  roleDesc.textContent = role === 'impostor'
    ? 'Kill everyone without getting caught'
    : 'Complete tasks and find the murderer';
  reveal.classList.add('active');
});

document.getElementById('btnRoleOk').onclick = () => {
  document.getElementById('roleReveal').classList.remove('active');
};

socket.on('gameStarted', (state) => {
  roomState = state;
  showScreen('game');
  initCanvas();
  detectMobile();
  startGameLoop();
  updateTaskList();
});

socket.on('gameUpdate', (state) => {
  roomState = state;
});

socket.on('playerMoved', ({ id, x, y }) => {
  if (!roomState) return;
  const p = roomState.players.find(pl => pl.id === id);
  if (p) { p.x = x; p.y = y; }
});

socket.on('playerKilled', ({ victimId }) => {
  toast('Someone was killed!', '#da3633');
  if (roomState) {
    const p = roomState.players.find(pl => pl.id === victimId);
    if (p) p.alive = false;
  }
});

socket.on('taskCompleted', ({ completed, total }) => {
  toast(`Task done! (${completed}/${total})`);
  updateTaskList();
});

// ============== MEETING ==============
socket.on('meetingStarted', ({ reason, players, discussionTime, votingTime }) => {
  document.getElementById('meetingReason').textContent = reason;
  document.getElementById('meetingOverlay').classList.add('active');

  const list = document.getElementById('voteList');
  list.innerHTML = '';
  players.filter(p => p.alive).forEach(p => {
    const btn = document.createElement('button');
    btn.className = 'vote-btn';
    btn.innerHTML = `<div class="color-dot" style="background:${p.color}"></div>${p.name}`;
    btn.onclick = () => {
      document.querySelectorAll('.vote-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      socket.emit('vote', { targetId: p.id });
    };
    list.appendChild(btn);
  });

  let timeLeft = discussionTime + votingTime;
  const timerEl = document.getElementById('meetingTimer');
  const interval = setInterval(() => {
    timeLeft--;
    timerEl.textContent = timeLeft > votingTime
      ? `Discussion: ${timeLeft - votingTime}s`
      : `Voting: ${timeLeft}s`;
    if (timeLeft <= 0) clearInterval(interval);
  }, 1000);
});

document.getElementById('btnSkip').onclick = () => {
  socket.emit('vote', { targetId: null });
  toast('Skipped vote');
};

socket.on('meetingEnded', ({ ejected, wasTie }) => {
  document.getElementById('meetingOverlay').classList.remove('active');
  if (wasTie || !ejected) {
    toast('No one was ejected (tie/skip)');
  } else {
    toast(`${ejected.name} was ejected (${ejected.role})`, '#da3633');
  }
});

socket.on('gameOver', ({ winner, players }) => {
  cancelAnimationFrame(animationId);
  showScreen('end');
  const title = document.getElementById('endTitle');
  const sub = document.getElementById('endSubtitle');
  if (winner === 'crew') {
    title.textContent = 'CREWMATES WIN';
    title.style.color = '#3fb950';
    sub.textContent = 'All tasks completed or impostors eliminated!';
  } else {
    title.textContent = 'IMPOSTORS WIN';
    title.style.color = '#ff4757';
    sub.textContent = 'The murderers took over...';
  }

  const container = document.getElementById('endPlayers');
  container.innerHTML = '';
  players.forEach(p => {
    const div = document.createElement('div');
    div.style.margin = '4px';
    div.innerHTML = `<span style="color:${p.color}">●</span> ${p.name} — ${p.role}${p.isBot ? ' 🤖' : ''}`;
    container.appendChild(div);
  });
});

document.getElementById('btnBackMenu').onclick = () => location.reload();

// ============== CANVAS & CONTROLS ==============
function initCanvas() {
  canvas = document.getElementById('gameCanvas');
  ctx = canvas.getContext('2d');
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);
}

function resizeCanvas() {
  canvas.width = canvas.clientWidth * devicePixelRatio;
  canvas.height = canvas.clientHeight * devicePixelRatio;
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
}

function detectMobile() {
  isMobile = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  if (isMobile) {
    document.getElementById('mobileControls').classList.add('visible');
    setupJoystick();
    setupActionButtons();
  }
}

// Keyboard
window.addEventListener('keydown', e => { keys[e.key.toLowerCase()] = true; });
window.addEventListener('keyup', e => { keys[e.key.toLowerCase()] = false; });

// Joystick
function setupJoystick() {
  const zone = document.getElementById('joystickZone');
  const knob = document.getElementById('joystickKnob');
  const maxDist = 40;

  function handleStart(e) {
    e.preventDefault();
    joystick.active = true;
  }
  function handleMove(e) {
    if (!joystick.active) return;
    e.preventDefault();
    const touch = e.touches ? e.touches[0] : e;
    const rect = zone.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    let dx = touch.clientX - cx;
    let dy = touch.clientY - cy;
    const dist = Math.hypot(dx, dy);
    if (dist > maxDist) {
      dx = (dx / dist) * maxDist;
      dy = (dy / dist) * maxDist;
    }
    knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
    joystick.dx = dx / maxDist;
    joystick.dy = dy / maxDist;
  }
  function handleEnd(e) {
    e.preventDefault();
    joystick.active = false;
    joystick.dx = 0;
    joystick.dy = 0;
    knob.style.transform = 'translate(-50%, -50%)';
  }

  zone.addEventListener('touchstart', handleStart, { passive: false });
  zone.addEventListener('touchmove', handleMove, { passive: false });
  zone.addEventListener('touchend', handleEnd, { passive: false });
  zone.addEventListener('mousedown', handleStart);
  window.addEventListener('mousemove', handleMove);
  window.addEventListener('mouseup', handleEnd);
}

function setupActionButtons() {
  document.getElementById('btnKill').onclick = () => tryKill();
  document.getElementById('btnReport').onclick = () => socket.emit('report');
  document.getElementById('btnUse').onclick = () => tryCompleteTask();
  document.getElementById('btnMeeting').onclick = () => socket.emit('emergency');
}

// Also keyboard shortcuts
window.addEventListener('keydown', e => {
  if (e.key === 'q' || e.key === 'Q') tryKill();
  if (e.key === 'r' || e.key === 'R') socket.emit('report');
  if (e.key === 'e' || e.key === 'E') tryCompleteTask();
  if (e.key === 'f' || e.key === 'F') socket.emit('emergency');
});

function tryKill() {
  if (myRole !== 'impostor' || !roomState) return;
  const me = roomState.players.find(p => p.id === myId);
  if (!me || !me.alive) return;

  let closest = null;
  let minDist = 80;
  roomState.players.forEach(p => {
    if (p.id === myId || !p.alive) return;
    const d = Math.hypot(p.x - me.x, p.y - me.y);
    if (d < minDist) { minDist = d; closest = p; }
  });
  if (closest) socket.emit('kill', { targetId: closest.id });
}

function tryCompleteTask() {
  if (myRole !== 'crewmate' || !myTasks.length) return;
  const task = myTasks.find(t => !t.done);
  if (task) {
    socket.emit('completeTask', { taskId: task.id });
    task.done = true;
    updateTaskList();
  }
}

function updateTaskList() {
  const el = document.getElementById('tasksContent');
  if (myRole === 'impostor') {
    el.innerHTML = '<div style="color:#ff4757">Sabotage & Kill</div>';
    return;
  }
  if (!myTasks.length) {
    el.textContent = '—';
    return;
  }
  el.innerHTML = myTasks.map(t =>
    `<div class="${t.done ? 'task-done' : ''}">${t.name}</div>`
  ).join('');
}

// ============== GAME LOOP ==============
function startGameLoop() {
  function loop() {
    update();
    draw();
    animationId = requestAnimationFrame(loop);
  }
  loop();
}

function update() {
  if (!roomState || roomState.state !== 'playing') return;
  const me = roomState.players.find(p => p.id === myId);
  if (!me || !me.alive) return;

  let dx = 0, dy = 0;
  const speed = 3.2;

  if (keys['w'] || keys['arrowup']) dy -= 1;
  if (keys['s'] || keys['arrowdown']) dy += 1;
  if (keys['a'] || keys['arrowleft']) dx -= 1;
  if (keys['d'] || keys['arrowright']) dx += 1;

  if (joystick.active) {
    dx += joystick.dx;
    dy += joystick.dy;
  }

  if (dx !== 0 || dy !== 0) {
    const len = Math.hypot(dx, dy) || 1;
    me.x += (dx / len) * speed;
    me.y += (dy / len) * speed;
    me.x = Math.max(20, Math.min(780, me.x));
    me.y = Math.max(20, Math.min(580, me.y));

    const now = Date.now();
    if (now - lastMoveSent > 40) {
      socket.emit('move', { x: me.x, y: me.y });
      lastMoveSent = now;
    }
  }
}

function draw() {
  if (!ctx || !roomState) return;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;

  // Clear
  ctx.fillStyle = '#0d1117';
  ctx.fillRect(0, 0, w, h);

  // Simple map background (grid + zones)
  ctx.strokeStyle = '#21262d';
  ctx.lineWidth = 1;
  for (let x = 0; x < w; x += 40) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
  }
  for (let y = 0; y < h; y += 40) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }

  // Scale factor so game world (800x600) fits screen
  const scaleX = w / 800;
  const scaleY = h / 600;
  const scale = Math.min(scaleX, scaleY);
  const offsetX = (w - 800 * scale) / 2;
  const offsetY = (h - 600 * scale) / 2;

  ctx.save();
  ctx.translate(offsetX, offsetY);
  ctx.scale(scale, scale);

  // Draw rooms (simple colored areas)
  const rooms = [
    { x: 50, y: 50, w: 200, h: 150, color: '#1a2332', label: 'Cafeteria' },
    { x: 300, y: 50, w: 200, h: 120, color: '#1a2a1a', label: 'Medbay' },
    { x: 550, y: 50, w: 200, h: 150, color: '#2a1a1a', label: 'Electrical' },
    { x: 50, y: 250, w: 180, h: 150, color: '#1a1a2a', label: 'Security' },
    { x: 300, y: 220, w: 200, h: 160, color: '#2a2a1a', label: 'Admin' },
    { x: 550, y: 250, w: 200, h: 150, color: '#1a2a2a', label: 'Weapons' },
    { x: 150, y: 450, w: 500, h: 100, color: '#222', label: 'Hallway' }
  ];
  rooms.forEach(r => {
    ctx.fillStyle = r.color;
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeStyle = '#30363d';
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    ctx.fillStyle = '#8b949e';
    ctx.font = '12px sans-serif';
    ctx.fillText(r.label, r.x + 8, r.y + 18);
  });

  // Bodies
  (roomState.bodies || []).forEach(b => {
    ctx.beginPath();
    ctx.ellipse(b.x, b.y + 8, 18, 10, 0, 0, Math.PI * 2);
    ctx.fillStyle = b.color;
    ctx.globalAlpha = 0.5;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#ff4757';
    ctx.font = 'bold 11px sans-serif';
    ctx.fillText('💀', b.x - 8, b.y - 10);
  });

  // Players
  roomState.players.forEach(p => {
    if (!p.alive) return;

    // Body
    ctx.beginPath();
    ctx.arc(p.x, p.y, 16, 0, Math.PI * 2);
    ctx.fillStyle = p.color;
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Visor
    ctx.beginPath();
    ctx.ellipse(p.x + 4, p.y - 2, 7, 5, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(200,230,255,0.7)';
    ctx.fill();

    // Name
    ctx.fillStyle = '#e6edf3';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(p.name + (p.isBot ? ' 🤖' : ''), p.x, p.y - 24);

    // Highlight me
    if (p.id === myId) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 22, 0, Math.PI * 2);
      ctx.strokeStyle = '#58a6ff';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  });

  ctx.restore();
}
