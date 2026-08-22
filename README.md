# MYSN MURDER

**Among Us style social deduction game** for players on the **same WiFi / local network**.

- No database needed (everything stays in memory)
- **Bots automatically fill empty slots**
- Full **mobile controls** (virtual joystick + action buttons)
- Desktop keyboard support too
- Create/join rooms with 4-letter codes

---

## Quick Start

### 1. Requirements
- Node.js 18 or newer

### 2. Install & Run

```bash
git clone https://github.com/Snowmonkey5/MYSN-MURDER.git
cd MYSN-MURDER
npm install
npm start
```

You will see something like:

```
========================================
   MYSN MURDER - Server Running!
========================================
  Local:   http://localhost:3000
  Network: http://192.168.x.x:3000
  Share the Network URL with friends on the same WiFi
========================================
```

### 3. Play

- **Host**: Open the Network URL (or localhost) → Create Room → set number of bots → Start Game
- **Friends**: Open the same Network URL on their phone/PC → enter the 4-letter code → Join

Everyone must be on the **same WiFi**.

---

## Features

| Feature              | Status |
|----------------------|--------|
| LAN multiplayer      | ✅     |
| Bots fill slots      | ✅     |
| Mobile joystick      | ✅     |
| Kill / Report / Meet | ✅     |
| Tasks (crew)         | ✅     |
| Voting meetings      | ✅     |
| Role reveal          | ✅     |
| No database          | ✅     |

### Controls

**Desktop**
- `WASD` or Arrow keys → Move
- `Q` → Kill (impostor)
- `R` → Report body
- `E` → Complete task
- `F` → Emergency meeting

**Mobile**
- Left virtual joystick → Move
- Right buttons → KILL / REPORT / USE / MEET

---

## How bots work

In the lobby the host can set **Bots to add** (0–8).

When the game starts the server automatically creates the bots.  
Bot behaviour:
- Wander around the map
- Crewmate bots slowly complete tasks
- Impostor bots try to kill nearby crewmates (with cooldown)

You can play completely alone with bots if you want.

---

## Project Structure

```
MYSN-MURDER/
├── package.json
├── server.js          # Game server + bot AI (in-memory only)
└── public/
    ├── index.html     # UI + mobile layout
    └── client.js      # Client logic, canvas, joystick
```

---

## Cloudflare (optional – for online play later)

This version is pure LAN (no database).  
If you later want friends to join from anywhere, you can move the same logic to:

- **Cloudflare Workers** + **Durable Objects**
- Each room = one Durable Object (keeps state in memory)
- WebSockets for real-time updates

No traditional database is required even then.

---

## Tips

- Use at least 4–6 total players (humans + bots) for a fun game
- On mobile, add the site to your home screen for a more app-like feel
- Firewall may block the port – allow Node.js / port 3000 if friends can’t connect

Enjoy **MYSN MURDER**!
