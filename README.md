# MYSN MURDER

Among Us style multiplayer game.

- **No database**
- Bots fill slots
- Mobile controls
- **Host Only mode** (host does not play)
- Works on Cloudflare (no computer needed)

---

## Deploy to Cloudflare (Recommended – easiest)

### Method 1: One-click from GitHub (easiest)

1. Go to [https://dash.cloudflare.com](https://dash.cloudflare.com) and log in (or create free account)
2. Click **Workers & Pages** → **Create** → **Start with Hello World** or **Import a repository**
3. Connect your GitHub account if asked
4. Select the repository **Snowmonkey5/MYSN-MURDER**
5. Cloudflare should detect the project
6. Click **Deploy**

After it finishes you will get a URL like:
`https://mysn-murder.yourname.workers.dev`

### Method 2: Using the terminal (if Method 1 is confusing)

```bash
git clone https://github.com/Snowmonkey5/MYSN-MURDER.git
cd MYSN-MURDER
npm install
npx wrangler login
npm run deploy
```

---

## How to play after deploying

1. Open your Cloudflare URL on any phone or computer
2. Type your name
3. Choose:
   - **Create & Play** → you join as a normal player
   - **Create as Host Only** → you manage the room but do **not** play
4. Share the room code (or the link) with friends
5. Host sets bots → Start Game

---

## Local version (optional – needs Node.js)

```bash
npm install
npm start
```

Then open the Network IP shown in the terminal.

---

## Features

| Feature              | Status |
|----------------------|--------|
| Cloudflare deploy    | ✅     |
| No database          | ✅     |
| Host Only mode       | ✅     |
| Bots                 | ✅     |
| Mobile joystick      | ✅     |
| Kill / Report / Meet | ✅     |
| Tasks + Voting       | ✅     |

Enjoy **MYSN MURDER**!
