# MYSN MURDER

**Among Us style multiplayer** that runs entirely on **Cloudflare**.

- **No computer needed** to host
- **No database**
- Works from any phone or laptop
- Bots fill empty slots
- Full mobile controls (joystick + buttons)
- Shareable room links

---

## Play Online (Recommended)

### 1. Create a free Cloudflare account
Go to [https://dash.cloudflare.com](https://dash.cloudflare.com) and sign up.

### 2. Install & Deploy

```bash
git clone https://github.com/Snowmonkey5/MYSN-MURDER.git
cd MYSN-MURDER
npm install
npx wrangler login
npm run deploy
```

After deploy finishes you will get a URL like:

```
https://mysn-murder.YOUR-SUBDOMAIN.workers.dev
```

### 3. Play

- Open that URL on your **phone or computer**
- Tap **Create Room**
- Share the code (or the link `?room=XXXX`) with friends
- They open the same site → enter the code → Join
- Host sets bots + impostors → Start Game

That’s it. No computer has to stay on.

---

## Local version (optional)

If you still want to run it on your own computer on the same WiFi:

```bash
npm install
npm start
```

Then open the Network IP shown in the terminal.

---

## Features

| Feature                    | Status |
|---------------------------|--------|
| No computer needed        | ✅     |
| No database               | ✅     |
| Works on mobile           | ✅     |
| Bots fill slots           | ✅     |
| Virtual joystick          | ✅     |
| Kill / Report / Meeting   | ✅     |
| Tasks + Voting            | ✅     |
| Shareable room links      | ✅     |
| Internet play             | ✅     |

### Controls

**Phone**
- Left joystick → Move
- Right buttons → KILL / REPORT / USE / MEET

**Computer**
- WASD / Arrows → Move
- Q → Kill
- R → Report
- E → Task
- F → Emergency Meeting

---

## How it works

- Each room is a **Cloudflare Durable Object**
- All game state lives in memory inside that object
- When the last player leaves, the room disappears
- Zero traditional database

---

## Project structure

```
MYSN-MURDER/
├── wrangler.toml          # Cloudflare config
├── src/
│   ├── index.js           # Worker entry
│   └── room.js            # Durable Object (game logic + bots)
├── public/
│   ├── index.html         # Beautiful mobile-first UI
│   └── client.js          # Client + canvas + joystick
└── server.js              # Optional local Node version
```

---

## Tips

- Use 4–8 total players (humans + bots) for the best experience
- Add the site to your phone home screen for an app-like feel
- Room codes are 4 characters (easy to share by voice)

Enjoy **MYSN MURDER**!
