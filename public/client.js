// MYSN MURDER client
(function () {
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

  function $(id) { return document.getElementById(id); }

  const screens = {
    menu: $('menuScreen'),
    lobby: $('lobbyScreen'),
    game: $('gameScreen'),
    end: $('endScreen')
  };

  function show(name) {
    Object.values(screens).forEach(s => s && s.classList.remove('active'));
    if (screens[name]) screens[name].classList.add('active');
  }

  function toast(msg, color) {
    const t = $('toast');
    if (!t) { alert(msg); return; }
    t.textContent = msg;
    t.style.background = color || '#1C9455';
    t.style.display = 'block';
    clearTimeout(t._timer);
    t._timer = setTimeout(() => { t.style.display = 'none'; }, 3000);
  }

  function connect(code, hostOnly) {
    isHostOnly = !!hostOnly;
    toast('Connecting...', '#1C9455');

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = proto + '://' + location.host + '/ws/' + code;

    try {
      ws = new WebSocket(url);
    } catch (err) {
      toast('WebSocket failed: ' + err.message, '#da3633');
      return;
    }

    ws.onopen = function () {
      const nameEl = $('playerName');
      const name = (nameEl && nameEl.value.trim()) || (hostOnly ? 'Host' : 'Player');
      send('join', { name: name, code: code, hostOnly: !!hostOnly });
      toast('Connected!', '#1C9455');
    };

    ws.onmessage = function (e) {
      let msg;
      try { msg = JSON.parse(e.data); } catch (err) { return; }
      handle(msg);
    };

    ws.onerror = function () {
      toast('Connection error. Redeploy may be needed.', '#da3633');
    };

    ws.onclose = function () {
      // silent
    };
  }

  function send(type, data) {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: type, data: data || {} }));
    }
  }

  function handle(msg) {
    const type = msg.type;
    const data = msg.data;

    if (type === 'joined') {
      myId = data.id;
      isHost = data.isHost;
      isHostOnly = !!data.hostOnly;
      roomState = data.state;
      roomCode = data.state.code;

      const codeEl = $('roomCodeDisplay');
      if (codeEl) codeEl.textContent = roomCode;

      const shareEl = $('shareInfo');
      if (shareEl) shareEl.textContent = 'Share: ' + location.origin + '?room=' + roomCode;

      if (isHost) {
        if ($('hostControls')) $('hostControls').classList.remove('hidden');
        if ($('waitingText')) $('waitingText').classList.add('hidden');
      } else {
        if ($('hostControls')) $('hostControls').classList.add('hidden');
        if ($('waitingText')) $('waitingText').classList.remove('hidden');
      }

      if ($('hostOnlyNote')) {
        if (isHostOnly) $('hostOnlyNote').classList.remove('hidden');
        else $('hostOnlyNote').classList.add('hidden');
      }

      updateLobby(data.state);
      show('lobby');
      try { history.replaceState(null, '', '?room=' + roomCode); } catch (e) {}
    }

    else if (type === 'update') {
      roomState = data;
      if (data && data.state === 'lobby') updateLobby(data);
    }

    else if (type === 'settings') {
      if (roomState) roomState.settings = data;
    }

    else if (type === 'role') {
      if (isHostOnly) return;
      myRole = data.role;
      myTasks = data.tasks || [];
      if ($('roleBadge')) {
        $('roleBadge').textContent = 'Role: ' + myRole.toUpperCase();
        $('roleBadge').style.color = myRole === 'impostor' ? '#ff4757' : '#1C9455';
      }
      if ($('roleText')) {
        $('roleText').textContent = myRole.toUpperCase();
        $('roleText').style.color = myRole === 'impostor' ? '#ff4757' : '#1C9455';
      }
      if ($('roleDesc')) {
        $('roleDesc').textContent = myRole === 'impostor'
          ? 'Eliminate the crewmates without getting caught'
          : 'Finish your tasks and find the impostor';
      }
      if ($('roleReveal')) $('roleReveal').classList.add('active');
    }

    else if (type === 'started') {
      roomState = data;
      if (isHostOnly) {
        if ($('roleBadge')) {
          $('roleBadge').textContent = 'HOST (watching)';
          $('roleBadge').style.color = '#1C9455';
        }
        if ($('tasksContent')) $('tasksContent').textContent = 'Spectator mode';
      }
      show('game');
      initCanvas();
      detectMobile();
      startLoop();
      if (!isHostOnly) updateTasks();
    }

    else if (type === 'moved') {
      if (!roomState || !roomState.players) return;
      const p = roomState.players.find(function (pl) { return pl.id === data.id; });
      if (p) { p.x = data.x; p.y = data.y; }
    }

    else if (type === 'killed') {
      toast('A body was found!', '#da3633');
      if (roomState && roomState.players) {
        const vic = roomState.players.find(function (pl) { return pl.id === data.victimId; });
        if (vic) vic.alive = false;
      }
    }

    else if (type === 'taskDone') {
      toast('Task complete (' + data.completed + '/' + data.total + ')');
      updateTasks();
    }

    else if (type === 'meeting') {
      if ($('meetingReason')) $('meetingReason').textContent = data.reason;
      if ($('meetingOverlay')) $('meetingOverlay').classList.add('active');
      const list = $('voteList');
      if (list) {
        list.innerHTML = '';
        (data.players || []).filter(function (p) { return p.alive && !p.hostOnly; }).forEach(function (p) {
          const btn = document.createElement('button');
          btn.className = 'vote-btn';
          btn.innerHTML = '<div class="color-dot" style="background:' + p.color + '"></div>' + p.name;
          btn.onclick = function () {
            if (isHostOnly) return;
            list.querySelectorAll('.vote-btn').forEach(function (b) { b.classList.remove('selected'); });
            btn.classList.add('selected');
            send('vote', { targetId: p.id });
          };
          list.appendChild(btn);
        });
      }
      let left = (data.discussion || 25) + (data.voting || 40);
      const timer = $('meetingTimer');
      const iv = setInterval(function () {
        left--;
        if (timer) {
          timer.textContent = left > (data.voting || 40)
            ? 'Discussion: ' + (left - (data.voting || 40)) + 's'
            : 'Voting: ' + left + 's';
        }
        if (left <= 0) clearInterval(iv);
      }, 1000);
    }

    else if (type === 'meetingEnd') {
      if ($('meetingOverlay')) $('meetingOverlay').classList.remove('active');
      if (data.tie || !data.ejected) toast('No one was ejected');
      else toast(data.ejected.name + ' was ejected (' + data.ejected.role + ')', '#da3633');
    }

    else if (type === 'gameOver') {
      if (animId) cancelAnimationFrame(animId);
      show('end');
      const title = $('endTitle');
      const sub = $('endSubtitle');
      if (data.winner === 'crew') {
        if (title) { title.textContent = 'CREWMATES WIN'; title.style.color = '#1C9455'; }
        if (sub) sub.textContent = 'Tasks finished or impostors eliminated!';
      } else {
        if (title) { title.textContent = 'IMPOSTORS WIN'; title.style.color = '#ff4757'; }
        if (sub) sub.textContent = 'The murderers took control...';
      }
      const box = $('endPlayers');
      if (box) {
        box.innerHTML = '';
        (data.players || []).filter(function (p) { return !p.hostOnly; }).forEach(function (p) {
          const d = document.createElement('div');
          d.style.margin = '6px';
          d.innerHTML = '<span style="color:' + p.color + '">●</span> ' + p.name + ' — <strong>' + (p.role || '?') + '</strong>' + (p.isBot ? ' 🤖' : '');
          box.appendChild(d);
        });
      }
    }

    else if (type === 'error') {
      toast(data, '#da3633');
    }
  }

  function updateLobby(state) {
    roomState = state;
    const c = $('lobbyPlayers');
    if (!c) return;
    c.innerHTML = '';
    (state.players || []).forEach(function (p) {
      const chip = document.createElement('div');
      chip.className = 'player-chip';
      let label = p.name;
      if (p.isBot) label += ' 🤖';
      if (p.hostOnly) label += ' (Host)';
      chip.innerHTML = '<div class="color-dot" style="background:' + (p.color || '#1C9455') + '"></div>' + label;
      c.appendChild(chip);
    });
  }

  function makeCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
  }

  // Safe button wiring
  function on(id, fn) {
    const el = $(id);
    if (el) el.onclick = fn;
  }

  on('btnCreate', function () {
    connect(makeCode(), false);
  });

  on('btnCreateHost', function () {
    connect(makeCode(), true);
  });

  on('btnJoin', function () {
    const input = $('joinCode');
    const code = input ? input.value.trim().toUpperCase() : '';
    if (code.length !== 4) return toast('Enter a 4-letter code', '#da3633');
    connect(code, false);
  });

  if (roomCode && roomCode.length === 4 && $('joinCode')) {
    $('joinCode').value = roomCode;
  }

  const botSlider = $('botSlider');
  if (botSlider) {
    botSlider.oninput = function (e) {
      if ($('botCountLabel')) $('botCountLabel').textContent = e.target.value;
      send('settings', { botCount: +e.target.value });
    };
  }

  const impSlider = $('impSlider');
  if (impSlider) {
    impSlider.oninput = function (e) {
      if ($('impLabel')) $('impLabel').textContent = e.target.value;
      send('settings', { impostors: +e.target.value });
    };
  }

  on('btnStart', function () { send('start'); });
  on('btnRoleOk', function () {
    if ($('roleReveal')) $('roleReveal').classList.remove('active');
  });
  on('btnSkip', function () {
    if (!isHostOnly) {
      send('vote', { targetId: null });
      toast('Vote skipped');
    }
  });
  on('btnBackMenu', function () { location.href = location.pathname; });

  function initCanvas() {
    canvas = $('gameCanvas');
    if (!canvas) return;
    ctx = canvas.getContext('2d');
    resize();
    window.addEventListener('resize', resize);
  }

  function resize() {
    if (!canvas || !ctx) return;
    canvas.width = canvas.clientWidth * devicePixelRatio;
    canvas.height = canvas.clientHeight * devicePixelRatio;
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  }

  function detectMobile() {
    isMobile = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    if (isMobile && !isHostOnly && $('mobileControls')) {
      $('mobileControls').classList.add('visible');
      setupJoystick();
      setupButtons();
    }
  }

  window.addEventListener('keydown', function (e) { keys[e.key.toLowerCase()] = true; });
  window.addEventListener('keyup', function (e) { keys[e.key.toLowerCase()] = false; });
  window.addEventListener('keydown', function (e) {
    if (isHostOnly) return;
    if (e.key === 'q' || e.key === 'Q') tryKill();
    if (e.key === 'r' || e.key === 'R') send('report');
    if (e.key === 'e' || e.key === 'E') tryTask();
    if (e.key === 'f' || e.key === 'F') send('emergency');
  });

  function setupJoystick() {
    const zone = $('joystickZone');
    const knob = $('joystickKnob');
    if (!zone || !knob) return;
    const max = 42;
    function start(e) { e.preventDefault(); joystick.active = true; }
    function move(e) {
      if (!joystick.active) return;
      e.preventDefault();
      const t = e.touches ? e.touches[0] : e;
      const r = zone.getBoundingClientRect();
      let dx = t.clientX - (r.left + r.width / 2);
      let dy = t.clientY - (r.top + r.height / 2);
      const d = Math.hypot(dx, dy);
      if (d > max) { dx = dx / d * max; dy = dy / d * max; }
      knob.style.transform = 'translate(calc(-50% + ' + dx + 'px), calc(-50% + ' + dy + 'px))';
      joystick.dx = dx / max;
      joystick.dy = dy / max;
    }
    function end(e) {
      e.preventDefault();
      joystick.active = false;
      joystick.dx = joystick.dy = 0;
      knob.style.transform = 'translate(-50%, -50%)';
    }
    zone.addEventListener('touchstart', start, { passive: false });
    zone.addEventListener('touchmove', move, { passive: false });
    zone.addEventListener('touchend', end, { passive: false });
    zone.addEventListener('mousedown', start);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', end);
  }

  function setupButtons() {
    on('btnKill', tryKill);
    on('btnReport', function () { send('report'); });
    on('btnUse', tryTask);
    on('btnMeeting', function () { send('emergency'); });
  }

  function tryKill() {
    if (isHostOnly || myRole !== 'impostor' || !roomState) return;
    const me = roomState.players.find(function (p) { return p.id === myId; });
    if (!me || !me.alive) return;
    let closest = null, min = 85;
    roomState.players.forEach(function (p) {
      if (p.id === myId || !p.alive || p.hostOnly) return;
      const d = Math.hypot(p.x - me.x, p.y - me.y);
      if (d < min) { min = d; closest = p; }
    });
    if (closest) send('kill', { targetId: closest.id });
  }

  function tryTask() {
    if (isHostOnly || myRole !== 'crewmate' || !myTasks.length) return;
    const t = myTasks.find(function (t) { return !t.done; });
    if (t) {
      send('task', { taskId: t.id });
      t.done = true;
      updateTasks();
    }
  }

  function updateTasks() {
    const el = $('tasksContent');
    if (!el) return;
    if (isHostOnly) { el.textContent = 'Spectator'; return; }
    if (myRole === 'impostor') {
      el.innerHTML = '<div style="color:#ff4757">Kill the crew</div>';
      return;
    }
    if (!myTasks.length) { el.textContent = '—'; return; }
    el.innerHTML = myTasks.map(function (t) {
      return '<div class="' + (t.done ? 'task-done' : '') + '">' + t.name + '</div>';
    }).join('');
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
    const me = roomState.players.find(function (p) { return p.id === myId; });
    if (!me || !me.alive) return;
    let dx = 0, dy = 0;
    const spd = 3.4;
    if (keys.w || keys.arrowup) dy -= 1;
    if (keys.s || keys.arrowdown) dy += 1;
    if (keys.a || keys.arrowleft) dx -= 1;
    if (keys.d || keys.arrowright) dx += 1;
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
    for (let x = 0; x < w; x += 48) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
    for (let y = 0; y < h; y += 48) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }

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
    rooms.forEach(function (r) {
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

    (roomState.bodies || []).forEach(function (b) {
      ctx.globalAlpha = 0.55;
      ctx.beginPath();
      ctx.ellipse(b.x, b.y + 6, 20, 12, 0, 0, Math.PI * 2);
      ctx.fillStyle = b.color;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.font = '16px serif';
      ctx.fillText('💀', b.x - 9, b.y - 12);
    });

    (roomState.players || []).forEach(function (p) {
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

  // Show that JS loaded
  console.log('MYSN MURDER client loaded');
})();
