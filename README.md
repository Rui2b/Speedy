# Speedy

A 3D browser playground for Chromebook classrooms. Run the field, collect gems,
hatch a pet, and steal one from another player.

Three.js on the front end, Node.js with native `ws` on the back end, PostgreSQL
for saves. The server is authoritative: the client reports inputs and nothing
else.

---

## Contents

- [Architecture](#architecture)
- [Run it locally](#run-it-locally)
- [Deploy to a VM](#deploy-to-a-vm)
- [Cloudflare Worker gateway](#cloudflare-worker-gateway)
- [Configuration](#configuration)
- [Tests](#tests)
- [Cheat test cases](#cheat-test-cases)
- [Troubleshooting](#troubleshooting)

---

## Architecture

```
Browser (Chromebook, Chrome)
  |  20Hz: inputs only        ^ 10Hz: world snapshot + authoritative self state
  v                           |
Cloudflare Worker "speedy"           static assets plus /ws and /api passthrough
  |                           ^
  v                           |
cloudflared tunnel (speedy-game)     separate from the control panel's tunnel
  |                           ^
  v                           |
Node.js authoritative server (127.0.0.1:8080)
  |- 20 ticks/s simulation and validation
  |- 10Hz broadcast
  `- PostgreSQL (written only on sign in, disconnect, gem pickup, pet change)
```

**Hard constraints**

| Constraint | Implementation |
| --- | --- |
| Transport | Native `ws`, never Socket.IO |
| Client reporting | 20Hz, dropping to 5Hz when the tab is hidden |
| Server simulation | 20 ticks/s |
| Downlink | 10Hz snapshots, plus 10Hz self state per client |
| Database | Never written per tick |
| Licences | MIT / ISC / Apache-2.0, no copyleft |
| Protocol | WebSocket over TCP only, no UDP |

**Layout**

```
speedy/
├── server/
│   ├── index.js            HTTP and WebSocket entry point
│   ├── gameRoom.js         room: main loop, input, actions, broadcast, heartbeat
│   ├── world.js            world state and authoritative integration
│   ├── antiCheat.js        rate limits, movement checks, action validation
│   ├── protocol.js         upstream parsing and strict field validation
│   ├── auth.js             scrypt hashing and HMAC session tokens
│   ├── store.js            PostgreSQL persistence, batched writes
│   ├── http.js             static files and JSON response helpers
│   ├── config.js           every constant and tunable
│   └── logger.js           operational log and anti-cheat file log
├── public/
│   ├── index.html
│   ├── css/style.css
│   ├── js/
│   │   ├── main.js         sign in, connect, main loop
│   │   ├── net.js          socket, 20Hz reporting, heartbeat, reconnect
│   │   ├── render.js       Three.js scene, interpolation, prediction
│   │   ├── input.js        WASD and Space
│   │   ├── hud.js          scoreboard
│   │   ├── interpolation.js snapshot buffer and interpolation
│   │   ├── targeting.js    nearest target filter (visual only)
│   │   └── assets.js       skins, map and palette
│   └── vendor/             three.js and fonts, self hosted
├── db/init.sql             schema, idempotent
├── deploy/                 systemd, cloudflared, nginx, backup
├── worker/                 Cloudflare Worker gateway
├── scripts/init-db.js      schema CLI
└── test/                   end to end and two player checks
```

---

## Run it locally

### 1. Node and a database

```bash
node -v     # 20.12 or newer
npm install
```

Either point at an existing PostgreSQL:

```bash
export DATABASE_URL="postgres://user:pass@127.0.0.1:5432/speedy"
```

or start one in Docker:

```bash
docker run -d --name speedy-pg \
  -e POSTGRES_USER=speedy -e POSTGRES_PASSWORD=devpass -e POSTGRES_DB=speedy \
  -p 5432:5432 postgres:16-alpine

export DATABASE_URL="postgres://speedy:devpass@127.0.0.1:5432/speedy"
```

### 2. Environment

```bash
cp .env.example .env
node -e "console.log('SESSION_SECRET=' + require('node:crypto').randomBytes(48).toString('base64url'))"
```

Put that line in `.env` and set `DATABASE_URL` to your connection string.
With `DB_AUTO_MIGRATE=true` the tables are created on boot.

### 3. Start

```bash
npm start        # or: npm run dev   (restarts on file change)
```

Open <http://127.0.0.1:8080> and create an account.

### 4. Run the checks

```bash
node test/e2e.mjs                             # 26 checks
DATABASE_URL=... node test/multiplayer.mjs    # 14 checks
```

### Controls

| Key | Action |
| --- | --- |
| `W` `A` `S` `D` | Move |
| `Space` | Jump |
| `E` | Collect a gem, or steal another player's pet |
| `F` | Hatch your own pet |

---

## Deploy to a VM

Target: Oracle Cloud Always Free, Ubuntu 22.04, public IPv4.

### 1. Base system

```bash
ssh ubuntu@<public-ip>

sudo useradd --system --create-home --shell /usr/sbin/nologin speedy
sudo mkdir -p /opt/speedy /opt/speedy/logs
```

### 2. Code

```bash
# From your machine
scp -i <key> -r server public db deploy scripts test worker \
    package.json package-lock.json .env.example ubuntu@<ip>:/tmp/speedy/

# On the server
sudo cp -r /tmp/speedy/* /opt/speedy/
cd /opt/speedy && sudo -u speedy npm install --omit=dev
```

Or run the installer, which also handles Node and the systemd unit:

```bash
sudo bash deploy/install.sh
```

### 3. Database

With PostgreSQL in Docker (the usual 1Panel setup):

```bash
sudo bash deploy/init-db.sh
```

With a native PostgreSQL:

```bash
sudo -u postgres psql -c "CREATE USER speedy WITH PASSWORD '<strong-password>';"
sudo -u postgres psql -c 'CREATE DATABASE speedy OWNER speedy;'
sudo -u postgres psql -d speedy -f /opt/speedy/db/init.sql
```

### 4. Environment

```bash
sudo nano /opt/speedy/.env
```

```ini
HOST=127.0.0.1
PORT=8080
DATABASE_URL=postgres://speedy:<strong-password>@127.0.0.1:5432/speedy
PG_POOL_MAX=8
DB_AUTO_MIGRATE=true
SESSION_SECRET=<random 48 bytes base64url>
SESSION_TTL_HOURS=12
LOG_LEVEL=info
CHEAT_LOG_FILE=logs/cheat.log
NODE_ENV=production
```

```bash
sudo chown speedy:speedy /opt/speedy/.env
sudo chmod 600 /opt/speedy/.env
```

> Never publish the database port. If PostgreSQL runs in Docker and the port is
> mapped as `5432:5432`, change it to `127.0.0.1:5432:5432`.

### 5. Keep it running

```bash
sudo install -m 644 /opt/speedy/deploy/speedy.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now speedy
sudo systemctl status speedy
sudo journalctl -u speedy -f
```

Why not PM2: PM2 is AGPL-3.0, which conflicts with this project's no-copyleft
rule. systemd gives the same boot start, crash restart and logging.

### 6. Public entry point

No open ports and no certificates, because the tunnel connects outwards.

```bash
cloudflared tunnel login                     # once, writes cert.pem
cloudflared tunnel create speedy-game        # note the TunnelID
```

```bash
sudo install -m 600 ~/.cloudflared/<TunnelID>.json /etc/cloudflared/speedy-game.json
```

Add a Public Hostname in the dashboard (Zero Trust, Networks, Tunnels,
`speedy-game`):

| Subdomain | Domain | Service |
| --- | --- | --- |
| `speedy-origin` | your domain | `http://127.0.0.1:8080` |

The dashboard creates the CNAME (`<TunnelID>.cfargotunnel.com`, proxied).
From the command line, which needs DNS edit rights:

```bash
sudo cloudflared tunnel --config /etc/cloudflared/speedy-game.yml \
  route dns speedy-game speedy-origin.<your-domain>
```

Run it as a service:

```bash
sudo install -m 644 /opt/speedy/deploy/cloudflared-speedy.yml /etc/cloudflared/speedy-game.yml
sudo install -m 644 /opt/speedy/deploy/cloudflared-speedy.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now cloudflared-speedy
```

```bash
curl -s http://127.0.0.1:8080/api/health
sudo journalctl -u cloudflared-speedy -n 30 --no-pager
```

### 7. Firewall

A tunnel only makes outbound connections, so 22 is all you need:

```bash
sudo ufw allow 22/tcp
sudo ufw enable
```

Do the same in the OCI security list or NSG.

### 8. Optional: expose the VM directly

Use `deploy/nginx-speedy.conf` if you want no Cloudflare in the path:

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
sudo cp deploy/nginx-speedy.conf /etc/nginx/sites-available/speedy
sudo ln -s /etc/nginx/sites-available/speedy /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d speedy.example.com
```

Keep `proxy_read_timeout 3600s` and the `Upgrade` header in the `/ws` block, or
Nginx will close long lived connections.

---

## Cloudflare Worker gateway

The Worker does two things: serve the front end from the edge, and pass `/ws`
plus `/api/*` to the origin. It holds no game logic.

```bash
cd worker
npx wrangler login
npx wrangler deploy
```

Key fields in `worker/wrangler.jsonc`:

| Field | Purpose |
| --- | --- |
| `name: "speedy"` | Worker name, must be lowercase |
| `assets.directory: "../public"` | Uploads `public/` as static assets |
| `routes[0].pattern` | Custom domain, creates the DNS record on deploy |
| `vars.ORIGIN_URL` | Origin hostname, the tunnel's public host name |

For local work, point the origin at your machine:

```bash
cd worker && npx wrangler dev --var ORIGIN_URL:http://127.0.0.1:8080
```

### Why /api must be proxied too

Sign in, session checks and the WebSocket ticket all live on the Node origin.
Without the `/api/*` proxy the page loads but nobody can sign in.

### How the WebSocket proxy works

The Worker calls `fetch(url, { headers: { Upgrade: 'websocket' } })`, receives
the origin socket on `response.webSocket`, pairs it with a `WebSocketPair` for
the browser and copies frames both ways. It never parses a game packet.

---

## Configuration

Every tunable lives in [`server/config.js`](server/config.js) and can be
overridden by environment variables.

| Variable | Default | Meaning |
| --- | --- | --- |
| `TICK_RATE` | 20 | Simulation rate |
| `BROADCAST_RATE` | 10 | Snapshot rate |
| `MAX_ONLINE` | 30 | Concurrent player cap |
| `PLAYER_MAX_SPEED` | 6 | Top speed, units/s |
| `PLAYER_ACCELERATION` | 12 | Acceleration, units/s² |
| `PLAYER_FRICTION` | 0.9 | Damping per tick |
| `PLAYER_JUMP_IMPULSE` | 7.5 | Jump velocity |
| `PLAYER_GRAVITY` | 22 | Gravity |
| `INPUT_STALE_MS` | 450 | Input expiry |
| `CHEAT_DISPLACEMENT_TOLERANCE` | 1.45 | Displacement multiplier |
| `CHEAT_MAX_DRIFT` | 3.5 | Allowed coordinate drift |
| `CHEAT_STRIKES_BEFORE_KICK` | 8 | Strikes before disconnect |
| `MAX_INPUT_PACKETS_PER_SEC` | 22 | Input packet limit |
| `MAX_ACTION_PACKETS_PER_SEC` | 10 | Action packet limit |

Game rules: pickup radius 2.2, steal radius 2.5, steal cooldown 12s per pet,
hatch cooldown 20s per pet.

Spawn points and the skin whitelist are in the same file.

For art, edit [`public/js/assets.js`](public/js/assets.js) only: palette, model
sizes, camera and skin colours.

---

## Tests

```bash
npm start &
node test/e2e.mjs                              # protocol, auth, physics, anti-cheat
DATABASE_URL=... node test/multiplayer.mjs     # stealing, cooldown, ownership
```

`e2e.mjs` checks registration, sign in, session, tickets, forged tokens, the
welcome shape, input driven movement and its speed limit, snapshot shape,
distant pickup, malformed fields, teleports and flood disconnects.

`multiplayer.mjs` checks wild pets, own pets, unknown pets, distance, a
legitimate steal, the owner notification, inventory sync and cooldown
protection.

### Manual pass

1. Two browser windows, register `alice` and `bob`
2. Alice presses `E` near a gem, the scoreboard counts up
3. Alice presses `E` beside Bob's pet, Bob sees "Your pet was stolen"
4. Alice presses `F` beside her own pet, progress gains 25
5. Switch tabs for ten seconds, come back: still connected, position continuous

### Logs

```bash
sudo journalctl -u speedy -f
sudo tail -f /opt/speedy/logs/cheat.log
curl -s http://127.0.0.1:8080/api/health
```

---

## Cheat test cases

Run these against your own server only.

### 1. Packet flood, expect a disconnect

```js
setInterval(() => {
  for (let i = 0; i < 5; i++) {
    window.__speedy_ws?.send(JSON.stringify({
      type: 'player_input', seq: Date.now() + i,
      input: { moveX: 0, moveZ: 0, jump: false },
      clientPreviewPos: { x: 0, y: 0, z: 0 },
    }));
  }
}, 50);
```

Past 22 packets per second the excess is dropped, and once the strike count is
reached the socket closes with `4002`. `cheat.log` shows `"reason":"input_rate"`.

### 2. Teleport, expect the position to hold

```js
send({ type: 'player_input', seq: Date.now(), input: { moveX: 1, moveZ: 1, jump: false },
       clientPreviewPos: { x: 500, y: 0, z: 500 } });
```

The server position does not change. `cheat.log` records `"reason":"displacement"`
with `travelled` and `maxTravel`.

### 3. Forged resource ids, expect a refusal

```js
send({ type: 'try_pick_gem', gemId: '00000000-0000-0000-0000-000000000000' });
```

Returns `{"ok":false,"reason":"gem_unavailable"}`. A client that sends `gems`,
`petId` or `speedBonus` in any packet has those fields ignored entirely.

### 4. Long range action, expect a refusal

```js
send({ type: 'try_steal_pet', petId: '<a pet across the field>' });
```

Returns `{"ok":false,"reason":"too_far","details":{"dist":...,"limit":2.5}}`.

### 5. Forged or expired token, expect a refusal

```bash
wscat -c "wss://speedy.<your-domain>/ws?token=forged.token"
```

Closes immediately with `4001 unauthorized`.

### 6. Action flood, expect rate limiting

```js
for (let i = 0; i < 30; i++) send({ type: 'try_pick_gem', gemId: '<any>' });
```

Anything past 10 per second is dropped, and sustained flooding closes the
socket with `4004`.

---

## Troubleshooting

**The page loads but sits on "Connecting".**
Check the Worker's `ORIGIN_URL` and that the hostname resolves
(`dig +short speedy-origin.<your-domain>`), then confirm
`/api/health` on the origin.

**Sign in returns 500.**
`SESSION_SECRET` is empty or `DATABASE_URL` is unreachable.
`journalctl -u speedy -n 50` will name the cause.

**The character keeps sliding after keys are released.**
`INPUT_STALE_MS` is too high or the client stopped reporting. The 450ms default
treats stale input as no input.

**Position jumps slightly when returning to the tab.**
Background reporting is 5Hz, so one frame straddles the switch. It settles
within a snapshot or two. This is by design.

**Redesigning the map, speed or pet rules.**
Edit `server/config.js` for authoritative values and
`public/js/assets.js` for anything visual.

---

## Licence

MIT. Dependencies: `ws` (MIT), `pg` (MIT), `three` (MIT),
Instrument Sans and JetBrains Mono (SIL OFL).

No GPL or AGPL dependency is used, which is why systemd replaces PM2.

Interface design follows the [unslop](https://x.com/heydamir) method by Damir
Sokolovsky (CC BY 4.0).
