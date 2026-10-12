# Open Rummy

**Malaysian Mahjong Rummy (拉米麻将 / LAMI) in the browser.** It is a 3D game in a style inspired
by Mahjong Soul: anime VRM avatars sit around a felt table. You can play offline against bots or
online with friends using a room code.

> Open Rummy is a fan project. It is **not affiliated with, endorsed by or connected to
> Mahjong Soul (雀魂) or Yostar**. It uses no assets, code or trademarks from that game.
> See [CREDITS.md](CREDITS.md).

[中文简介](#中文简介)

---

## The game

LAMI is Penang/Si Rummy played with mahjong-style tiles. There are 112 tiles: four colours
(black ♠, red ♥, yellow ♦, cyan ♣) × 13 ranks × 2 copies, plus 8 Jokers. Each player gets 20
tiles. There is **no draw and no discard**. You open by "porting" (出牌) a run, then on each turn
you either extend (接) a meld on the table or cut (斩) a new set. Your hand only gets smaller,
and the lowest penalty points wins. The full, canonical rules are in
**[docs/RULES.md](docs/RULES.md)**. The default rules follow the Cari Makan 揾到食 rule cards,
and the "Penang Classic" preset and other options are listed there too.

Where the sources are silent, RULES.md marks the choice as a **[house rule choice]**. The
edge cases the engine decides for you are collected in RULES.md §13 and **§16 Engine
clarifications**, for example:

- a Joker swap is refused if it would leave you with no legal move;
- if two or more players empty their hand at the simultaneous port reveal, only the first of
  them in turn order wins;
- with the "set priority" option, a rank that has a set on the table is blocked in runs, even
  for a Joker representing that rank;
- when the port timer runs out, the engine ports the highest-penalty candidate its move
  generator finds (or you take 全餐 if there is none).

## Features

- A full rules engine with configurable house rules and a "Penang Classic" preset.
- Offline play against bots. Bot moves are computed in the browser and no server is needed.
- Online rooms with 6-character codes. Empty seats fill with bots. A disconnected player can
  reconnect, and the server plays for them while they are away. After the match ends the host
  can return the room to its lobby (same code) for another match; connected players and bots
  keep their seats.
- A WebGL table: 3D tiles, a dead wall, dice and turn indicators, and procedural tile art.
- Five VRM anime characters with a seated pose, idle breathing, blinking, look-at, expressions
  and reaction gestures (see [Characters](#characters)).
- The UI is in Simplified Chinese (default) and English.
- One Node 22 server serves the static client, the WebSocket game rooms (`/ws`) and a health
  check (`/healthz`).

## Characters

The persona names are our own; the models are free-to-redistribute VRM files bundled in
`packages/client/public/avatars`. [CREDITS.md](CREDITS.md) is the source of truth for authors and
licenses.

| Character | Id | Model file | Model (author, license) |
|---|---|---|---|
| 美美 Mei Mei | `mei` | `vrm-girl.vrm` | three-vrm-girl (pixiv Inc., VRoid Hub: redistribution allowed) |
| 咖椰 Kaya | `kaya` | `twist.vrm` | VRM1_Constraint_Twist_Sample (pixiv Inc., VRM Public License 1.0) |
| 班兰 Pandan | `pandan` | `sample-e.vrm` | ビビ AvatarSample_E (VRoid Project, CC0) |
| 玲玲 Ling Ling | `lingling` | `shino.vrm` | 千駄ヶ谷篠 Sendagaya Shino (VRoid Project, CC0) |
| 红毛丹 Rambutan | `rambutan` | `sample-f.vrm` | ヴィータ AvatarSample_F (VRoid Project, CC0) |

Bots pick from the same five characters.

## Screenshots

_No screenshots yet. They will be added once the first playable build is captured._

## Requirements

- **Node.js >= 22.11** (npm 10+)
- A browser with WebGL 2, such as a current Chrome, Edge, Firefox or Safari.

## Quick start (development)

```bash
npm install
npm run dev:server    # terminal 1: game server (tsx watch) on port 3001, WebSocket at /ws
npm run dev:client    # terminal 2: Vite dev server on http://127.0.0.1:5173, proxies /ws to 3001
```

Open **http://127.0.0.1:5173**. Offline games against bots work even without the server.

## Build, test, run

```bash
npm run build         # client (vite) -> packages/client/dist, server (esbuild) -> packages/server/dist/server.js
npm test              # vitest: shared rules engine suite (~90 s, includes a fuzz test) + server suite
npm run typecheck     # tsc for shared, server and client
npm start             # run the built server (serves the built client too)
npm run check-secrets # secret scan of staged files; add -- --all for the whole tree
```

The client's own tests are not part of `npm test`; run them with `npx vitest run` inside
`packages/client`. A single workspace can be tested with e.g. `npm test -w @open-rummy/server`.

## Project structure

```
packages/
  shared/    rules engine, meld validation, bots, real-time GameHost, protocol types (pure TS)
  server/    Node 22 + ws: rooms, sessions, static files, /healthz; bundled by esbuild
  client/    Vite + three.js + @pixiv/three-vrm + gsap: 3D table, avatars, DOM UI, i18n
docs/
  RULES.md          canonical rules spec
  ARCHITECTURE.md   module map and conventions
deploy/             nginx site, systemd unit, pm2 file, Lightsail setup and deploy scripts
scripts/            check-secrets.mjs (secret scanner), install-hooks.mjs (pre-commit hook)
Dockerfile          container image for Lightsail container service / any Docker host
```

More detail is in **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

## Configuration

The server is configured only through environment variables. It needs no secrets or API keys.
See [.env.example](.env.example).

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3001` | HTTP + WebSocket port |
| `HOST` | `0.0.0.0` | Bind address. Use `127.0.0.1` behind nginx (the deploy files do) and `0.0.0.0` in a container. |
| `WEB_ROOT` | `packages/client/dist` | Directory holding the built client |
| `MAX_ROOMS` | `500` | Limit on concurrent rooms |
| `ALLOWED_ORIGINS` | empty = any | Comma-separated WebSocket origins, e.g. `https://rummy.example.com`. Set it in production. |
| `NODE_ENV` | unset | Set to `production` on servers (convention; the game server behaves the same) |
| `TRUST_PROXY` | `0` | Proxy hops whose `X-Forwarded-For` is trusted for the client IP (0-10). `1` behind nginx or a load balancer; `0` when clients connect directly. The deploy files and the Docker image set `1`. |
| `MAX_CONNECTIONS` | `4000` | Total concurrent WebSocket connections |
| `MAX_CONNS_PER_IP` | `20` | Concurrent WebSocket connections per client IP |
| `MAX_ROOMS_PER_IP` | `5` | Live rooms one client IP may have created at a time |

An invalid integer value stops the server at startup with an error. On a Lightsail instance these
go in `/etc/open-rummy.env`, which systemd reads (the systemd unit already sets
`TRUST_PROXY=1`). Never commit a filled-in `.env`.

**Behind a CDN.** nginx passes `$remote_addr` to the server as `X-Forwarded-For`. If a CDN or
another proxy sits in front of nginx, `$remote_addr` is the CDN edge and all players would share
one address in the per-IP limits. Enable nginx's realip module (`set_real_ip_from` for the CDN's
ranges plus `real_ip_header`); a commented example is in
[deploy/nginx/open-rummy.conf](deploy/nginx/open-rummy.conf).

## Deploy to AWS Lightsail

There are two options. **Option A** is the cheapest and gives you full control. **Option B**
needs no server administration.

### Option A: Lightsail instance (Ubuntu 24.04, nginx + systemd)

1. **Create the instance.** In Lightsail, create an instance with the *Linux/Unix > OS Only >
   Ubuntu 24.04 LTS* blueprint. 512 MB works if you build on your own machine; choose 1 GB or
   more if you want to build on the server. Pick a region near your players, e.g. Singapore
   (`ap-southeast-1`). Download the SSH key and keep it **outside** this repository.
2. **Networking.** Attach a static IP. In the instance's *Networking* tab, allow HTTP (80) and
   HTTPS (443). If you have a domain, create an `A` record pointing at the static IP.
3. **Run the setup script on the instance** (SSH in as `ubuntu`):
   ```bash
   sudo apt-get update && sudo apt-get install -y git
   sudo mkdir -p /srv/open-rummy && sudo chown ubuntu:ubuntu /srv/open-rummy
   git clone https://github.com/chon9/Open-Rummy.git /srv/open-rummy/src
   sudo bash /srv/open-rummy/src/deploy/setup-lightsail.sh rummy.example.com you@example.com
   ```
   The script can be run again safely. It sets up:
   - 1 GB of swap
   - system updates
   - Node 22 from NodeSource
   - nginx with the site from [deploy/nginx/open-rummy.conf](deploy/nginx/open-rummy.conf)
   - ufw, allowing OpenSSH and Nginx Full
   - the `openrummy` service user and the `/srv/open-rummy/{web,server}` directories
   - `/etc/open-rummy.env`
   - the systemd unit [deploy/open-rummy.service](deploy/open-rummy.service)
   - a Let's Encrypt certificate via certbot, but only if you passed a domain and an email

   Leave out the domain and email to start with plain HTTP on the IP address.
4. **Deploy the game.** Choose one:
   - **Build locally and upload.** This works from Git Bash on Windows, Linux or macOS:
     ```bash
     export LIGHTSAIL_HOST=ubuntu@203.0.113.10        # your static IP or domain
     export SSH_KEY=/c/Users/you/.ssh/LightsailDefaultKey-ap-southeast-1.pem
     bash deploy/deploy.sh                            # npm ci, test, build, upload, restart, health check
     ```
     The script uses rsync if it is installed and scp otherwise. It refuses to run if
     `LIGHTSAIL_HOST` or `SSH_KEY` is not set.
   - **Build on the server** (1 GB+ instances): `bash /srv/open-rummy/src/deploy/deploy-from-git.sh`.
     It runs git pull, npm ci and the build, copies the result and restarts the service.
5. **Check:** `curl -fsS https://rummy.example.com/healthz`, then open the site.
   For logs, run `sudo journalctl -u open-rummy -f`.

If you prefer pm2 to systemd, use [deploy/ecosystem.config.cjs](deploy/ecosystem.config.cjs)
instead. Use one or the other, not both.

### Option B: Lightsail container service (Docker)

```bash
docker build -t open-rummy:latest .
aws lightsail push-container-image --service-name open-rummy --label web --image open-rummy:latest
```

The full guide covers creating the service, the deployment JSON with the `/healthz` health
check, and custom domains: **[deploy/lightsail-container.md](deploy/lightsail-container.md)**.

## Publishing to GitHub safely

The repository is meant to be public at `github.com/chon9/Open-Rummy`. Before your first
commit, install the secret-scanning pre-commit hook **once**:

```bash
node scripts/install-hooks.mjs
```

The hook runs `node scripts/check-secrets.mjs` on staged files. It blocks commits that contain
AWS keys, private keys, GitHub or Slack tokens, `password = "..."` style literals, `.env` files,
or `*.pem` / `*.key` files. To scan the whole working tree, run
`node scripts/check-secrets.mjs --all` (or `npm run check-secrets -- --all`).
`.gitignore` also excludes env files, keys and Lightsail key downloads.

If a secret ever reaches GitHub, **rotate it first**. Removing it from history is not enough.

## License

**No license has been chosen yet.** The repository owner will decide. Until a LICENSE file is
added, all rights are reserved by the authors. The bundled third-party assets and libraries keep
their own licenses (see [CREDITS.md](CREDITS.md)).

## Credits

Character models, libraries and rule sources: **[CREDITS.md](CREDITS.md)**.

---

## 中文简介

**Open Rummy** 是一款浏览器 3D 马来西亚拉米麻将（LAMI / 拉米麻将）游戏，画面风格参考雀魂：
VRM 动漫角色围坐在牌桌旁。可以离线和电脑对战，也可以用房间号和朋友联机。

- **规则**：112 张牌（黑、红、黄、青四色 × 13 点 × 2 张，外加 8 张百搭 Joker），每人 20 张，
  **不摸牌、不打牌**。先“出牌”（一组顺子），之后每轮“接”或“斩”，罚分最少者胜。
  完整规则见 [docs/RULES.md](docs/RULES.md)，默认采用 Cari Makan 揾到食 的规则卡。
- **功能**：可配置的家规、离线电脑对手、6 位房间号联机（断线可重连，断线期间由服务器代打）、
  3D 牌桌、5 个 VRM 角色（美美、咖椰、班兰、玲玲、红毛丹）、简体中文和英文界面；对局结束后房主可让房间回到大厅再开一局。
- **家规与边界情况**：见 RULES.md §13 和 §16（引擎裁定）。
- **快速开始**：需要 Node.js >= 22.11。运行 `npm install`，再分别运行 `npm run dev:server`
  和 `npm run dev:client`，然后打开 http://localhost:5173 。
- **构建 / 测试**：`npm run build`、`npm test`。
- **部署到 AWS Lightsail**：可以用 Ubuntu 24.04 实例（`deploy/setup-lightsail.sh` 加
  `deploy/deploy.sh`），也可以用容器服务（`Dockerfile` 加
  [deploy/lightsail-container.md](deploy/lightsail-container.md)）。步骤见上方英文说明。
- **配置**：只用环境变量（见 `.env.example`），不需要任何密钥。
- **安全**：首次提交前请运行一次 `node scripts/install-hooks.mjs`，安装防止泄露密钥的提交钩子。
- **许可证**：尚未选定，由仓库所有者决定。第三方模型和库的许可见 [CREDITS.md](CREDITS.md)。

本项目为爱好者作品，**与雀魂（Mahjong Soul）及 Yostar 无任何关联**。
