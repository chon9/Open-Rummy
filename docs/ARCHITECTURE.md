# Open Rummy - Architecture

Malaysian Mahjong Rummy (拉米麻将 / LAMI) as a Mahjong-Soul-inspired 3D browser game.
Rules: [RULES.md](RULES.md) (canonical; defaults follow the Cari Makan rule cards).

## Packages (npm workspaces, TypeScript everywhere)

| Package | Path | Role |
|---|---|---|
| `@open-rummy/shared` | packages/shared | Pure rules engine, meld validation, bots, real-time `GameHost`, WS protocol types. No DOM, no Node APIs. Consumed as TS source (`exports: ./src/index.ts`). |
| `@open-rummy/server` | packages/server | Node 22 + `ws`. Rooms with 6-char codes, one `GameHost` per room, per-seat projected views, static file serving for the built client, `/healthz`. Bundled to `dist/server.js` by esbuild. |
| `@open-rummy/client` | packages/client | Vite 6 + three.js 0.186 + @pixiv/three-vrm 3.5 + gsap. DOM/CSS UI overlay over a WebGL table with VRM anime avatars. Offline vs bots (local `GameHost`) or online (WebSocket). |

Pinned versions keep Node 22.11 compatibility (vite 6.4.4, vitest 3.2.7, typescript 5.9.3). Do not add dependencies without need.

## Shared module map (packages/shared/src)

- `tiles.ts` - tile ids, colours, ranks, penalties, sorting, labels. (done)
- `config.ts` - `RulesConfig`, `DEFAULT_RULES`, `PENANG_CLASSIC`, `resolveRules`. (done)
- `types.ts` - `GameState`, `Meld`, `Action`, `GameEvent`, `LegalMoves`, `PlayerView`, `EngineResult`. (done - the contract)
- `rng.ts` - mulberry32 PRNG stored in state, `cryptoSeed()`. (done)
- `melds.ts` - run/set validation, extend, follow, joker swap checks.
- `engine.ts` - pure reducer: `createMatch`, `startHand`, `applyAction`, `applyTimeout`, `nextHand`, `getLegalMoves`, `projectView`, `projectEvents`, `handPoints`, `pendingSeats`.
- `bot.ts` - `chooseBotAction(view, level, rand)`, `botThinkDelay`.
- `host.ts` - `GameHost` real-time driver (timers, bots, auto next hand, disconnect autoplay, per-seat fan-out).
- `protocol.ts` - client/server messages. (done)

### Engine conventions
- Pure: never mutate input state; return `{ ok, state, events }`. Use `structuredClone` or careful copying.
- Deterministic given the seed: shuffle and dice use `state.rng` via `nextRandom`.
- `now` (ms) is passed by the host; the engine sets `state.deadline = now + timer` for decisions. `applyTimeout` resolves expired decisions.
- Seat order: `next(s) = (s + 1) % N` is 下家 (counter-clockwise). First to act each hand is the dealer's 下家.
- Runs: tile lists are ordered low -> high. Jokers get a fixed `rep` when placed. A is 1 (low) or 14 (high, if `aceHigh`), never both ends except the full 14-length run A..K..A.
- `projectView` must never leak other hands, the dead wall or pending ports of other seats.

## Client module map (packages/client/src)

- `main.ts` - boot, screen routing (title -> lobby -> table), wires Transport <-> UI <-> Scene.
- `net/transport.ts` - `Transport` interface (done). `net/local.ts` (offline GameHost + bots), `net/online.ts` (WebSocket client, reconnect with token).
- `scene/api.ts` - `TableSceneApi` contract (done). `scene/table.ts` implements it: felt table, 3D tiles for melds, opponents' tile racks (backs), dead wall, dice, turn ring, camera, lights, raycast picking of melds.
- `avatars/` - VRM loading (`@pixiv/three-vrm`), seated pose by procedural bone rotation, idle breathing, blinking, look-at, expressions (happy/sad/angry/surprised/relaxed), procedural gesture animations for reactions. No external animation files.
- `art/api.ts` - `TileArt` contract (done). `art/tileArt.ts` procedural canvas tile faces (ivory face, colour suits ♠♥♦♣ in black/red/yellow/cyan, rank, joker art).
- `ui/` - DOM overlay: title screen, lobby (character select, offline/online, room code, rule options), hand tray (own tiles as DOM using tile art), action bar (Port / Extend / Cut / Follow / Swap Joker / End turn), timers, seat badges (name, chips, tile count, status), hand-end result modal, match-end standings, emote wheel, settings (language, quality, sound), credits.
- `i18n/` - zh (Simplified, default for Malaysian Chinese players) and en strings using glossary in RULES.md §14.
- `avatars/catalog.ts` - `AvatarDef[]` for the bundled models in `public/avatars`.

## Bundled characters (public/avatars) - all allow redistribution

| File | Model | License | Credit |
|---|---|---|---|
| twist.vrm | VRM1_Constraint_Twist_Sample (pixiv Inc.) | VRM Public License 1.0 | not required |
| vrm-girl.vrm | three-vrm-girl (pixiv Inc.) | VRoid Hub: redistribution allowed | not required |
| shino.vrm | 千駄ヶ谷篠 Sendagaya Shino (VRoid Project) | CC0 | not required |
| sample-e.vrm | ビビ AvatarSample_E (VRoid Project) | CC0 | not required |
| sample-f.vrm | ヴィータ AvatarSample_F (VRoid Project) | CC0 | not required |

## Server

- `src/main.ts` - entry point: `loadConfig()`, `startServer()`, graceful shutdown on SIGTERM/SIGINT.
- `src/app.ts` - http server: static client from `WEB_ROOT` (`src/static.ts`, `.vrm` -> `model/gltf-binary`), `/healthz`, `/ws` upgrade with Origin check, connection limits and per-message routing.
- `src/rooms.ts` - `RoomManager`: create/join (6-char codes, no ambiguous chars), seats, host controls (add bot, remove seat, start, restart), bots fill seats, leave, idle/finished room GC. `restart_room` (host only, only in `MATCH_END`, else `NOT_HOST` / `ALREADY_STARTED`; `ILLEGAL` before any game) disposes the `GameHost` and returns the same room code to its lobby: connected humans and bots keep their seats, disconnected humans and humans replaced by a bot after leaving mid-game are freed, and every client gets a `room` message with `started: false`.
- `src/session.ts` - session tokens (random, in memory) for reconnect; token-bucket rate limits; message validation (never trust client JSON).
- `src/limits.ts` - client IP resolution (`TRUST_PROXY`) and per-IP connection / room counters.
- `src/config.ts` - config from env vars only (no secrets; see `.env.example`, README "Configuration"):

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 3001 | HTTP + WebSocket port |
| `HOST` | 0.0.0.0 | bind address (deploy files use 127.0.0.1 behind nginx; container 0.0.0.0) |
| `WEB_ROOT` | packages/client/dist | built client directory |
| `MAX_ROOMS` | 500 | concurrent rooms |
| `ALLOWED_ORIGINS` | empty = any | comma-separated WebSocket Origins |
| `NODE_ENV` | unset | `production` on servers (no behaviour change in the game server) |
| `TRUST_PROXY` | 0 | trusted proxy hops for `X-Forwarded-For` (0-10); 1 behind nginx / a load balancer (set by the systemd unit, pm2 file and Docker image) |
| `MAX_CONNECTIONS` | 4000 | total concurrent WebSockets |
| `MAX_CONNS_PER_IP` | 20 | concurrent WebSockets per client IP |
| `MAX_ROOMS_PER_IP` | 5 | live rooms created per client IP |

## Deploy (AWS Lightsail)

`deploy/` contains: nginx site (static + `/ws` proxy + caching), systemd unit, pm2 ecosystem, `setup-lightsail.sh` (Ubuntu 24.04: swap, Node 22, nginx, certbot), `deploy.sh` (build locally, rsync, reload). `Dockerfile` for Lightsail container service.
