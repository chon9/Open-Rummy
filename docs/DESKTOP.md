# Open Rummy - Windows desktop build (Electron + Steam)

The desktop app wraps the unchanged web client (`packages/client`) in Electron and adds
Steam lobbies, invites and peer-to-peer play through [steamworks.js](https://github.com/ceifa/steamworks.js).
Everything lives in `desktop/` with its **own** `package.json` and `node_modules`. It is **not** an
npm workspace: the root install (deployed to the 447 MB Lightsail box) must never pull Electron.

Contract between the Electron side and the renderer: `packages/client/src/net/desktopBridge.ts`.

## 1. Layout

| Path | Role |
|---|---|
| `desktop/package.json` | `open-rummy-desktop`, exact versions, npm scripts, electron-builder config (`build` field: appId `com.chon9.openrummy`, portable + NSIS x64, `asarUnpack` `**/*.node` + steamworks.js `dist/win64`, output `release/`), `allowScripts` |
| `desktop/src/main.ts` | Electron main: window, `app://open-rummy/` protocol, session hardening, IPC handlers (sender + argument checks), backend selection, `--dev` / `--profile=N`, smoke mode |
| `desktop/src/steam/backend.ts` | `SteamBackend` interface, `BaseSteamBackend` (listeners, pending join, `+connect_lobby`, per-peer rate limit), app id resolution, lobby summary helpers |
| `desktop/src/steam/service.ts` | `SteamService`: the real Steam backend over steamworks.js (lobbies, owner tracking, P2P accept/send/poll) |
| `desktop/src/steam/mock.ts` | `MockSteamService` + `MockRelayServer`: `OPEN_RUMMY_STEAM=mock` loopback relay (section 11) |
| `desktop/src/steam/mockWorld.ts` | `MockSteamWorld`: the simulated Steam (users, lobbies, data, P2P) the relay serves |
| `desktop/src/smokeUi.ts` | `--smoke-test=<scenario>`: drives the real UI (title -> Steam lobby -> table), screenshots, quits (verification only) |
| `desktop/src/preload.ts` | sandboxed preload, exposes `window.openRummyDesktop` (the full contract, with argument checks; event payloads re-checked) |
| `desktop/src/channels.ts` | IPC channel names and the shared guards (`isSteamIdString`, `isPayload`, `isLobbyKey/Value`, `sanitizeCreateOpts`, `sanitizeLobbyData`) used by main and preload |
| `desktop/vite.config.ts` | renderer build: root `../packages/client`, `base: './'`, out `desktop/dist/renderer`, `define __DESKTOP__ = true` |
| `desktop/build.mjs` | esbuild: `src/main.ts` -> `dist/main.js`, `src/preload.ts` -> `dist/preload.js` (CJS, `electron` + `steamworks.js` external) |
| `desktop/steam_appid.txt` | `480` (Spacewar) during development |
| `desktop/tsconfig.json` | typecheck for main/preload/vite config + the bridge contract |
| `desktop/.gitignore` | `node_modules/`, `dist/`, `release/` |

## 2. Install, build, run

Versions (exact, all at least two weeks old on 2026-10-13): electron **44.4.5** (2026-09-23; 44.x is the
current stable line, newer 44.5+ builds were too fresh), electron-builder **26.15.3** (npm `latest` tag),
steamworks.js **0.4.0** (latest published), esbuild **0.28.2**, typescript **5.9.3**, @types/node **22.20.5**
(same as the root).

```sh
cd desktop
npm install            # only ever inside desktop/
npm run build          # vite renderer (uses the ROOT workspace's vite 6.4.4) + esbuild main/preload
npm start              # electron .   (add `-- --dev` for DevTools/F12 and the menu bar)
npm run typecheck
npm run dist:dir       # unpacked app in release/win-unpacked (fast check)
npm run dist           # release/OpenRummy-Setup-<v>.exe (NSIS) + OpenRummy-Portable-<v>.exe
```

Install notes (Windows, Node 22.11, npm 11.17):

- **Electron 44 has no postinstall any more.** It downloads its binary lazily via `install.js`, which
  `require()`s the ESM-only `@electron/get` 5 and therefore needs Node >= 22.12 or the
  `--experimental-require-module` flag. `desktop/package.json` has a root `postinstall` doing exactly
  `node --experimental-require-module node_modules/electron/install.js`, so `npm install` leaves
  `node_modules/electron/dist/electron.exe` in place. `npm run dist` uses the same flag for electron-builder.
- npm 11's install-script review is advisory today; `allowScripts` in `desktop/package.json` pins the
  reviewed ones (`electron`, `esbuild`, `electron-winstaller`) so a future blocking npm keeps working.
- The renderer build needs the **root** `npm install` (vite, three, @open-rummy/shared are resolved
  from the root `node_modules`). Nothing is added to the root.
- `ELECTRON_RUN_AS_NODE` is set in some tool shells (VS Code / agent terminals). With it Electron runs as
  plain Node and `main.js` crashes on `app` being undefined. Launch with `env -u ELECTRON_RUN_AS_NODE npm start`
  (bash) or `Remove-Item Env:ELECTRON_RUN_AS_NODE` (PowerShell) in such shells.

Smoke test (used for verification; writes nothing unless asked):

```sh
cd desktop
env -u ELECTRON_RUN_AS_NODE OPEN_RUMMY_SMOKE=1 OPEN_RUMMY_SMOKE_MS=6000 \
  OPEN_RUMMY_SMOKE_SHOT=/path/to/shot.png node_modules/electron/dist/electron.exe .
```

It logs `did-finish-load`, the Steam init result, `document.title`, whether the bridge exists,
WebGL2 availability, a fetch of one bundled `.vrm` over `app://`, `steam.available()`, then quits.
`OPEN_RUMMY_SMOKE_PRINT_PERSONA=1` additionally prints the Steam persona name to stdout (never to a file).

`OPEN_RUMMY_SMOKE_STEAM=<scenario>` first runs a Steam scenario **inside the renderer through
`window.openRummyDesktop`** (so preload, IPC validation and the backend are all exercised) and logs
counts/lengths only (no ids, no names):

| Scenario | What it does |
|---|---|
| `lobby` | create a private lobby, `setLobbyDataMany`, `getLobbyData`, `currentLobby`, `sendTo(self)` (must be refused), `leaveLobby` |
| `host` | create a public 2-seat lobby, wait up to 45 s for a guest's `{"t":"ping"}`, answer `{"t":"pong"}`, leave |
| `guest` | poll `listLobbies` (20 s), join the first row, ping the owner, wait for the pong, leave |

UI smoke scenarios (`desktop/src/smokeUi.ts`) drive the **real UI** with DOM clicks (title -> Steam lobby ->
table), play own decisions through the Hint button (then the move the hint prepared, End Turn as the fallback,
first option of any picker), leave through the table's leave button, then quit. Each step logs `ok` / `FAIL`
(counts and booleans only, no ids or names) and ends with `smoke-ui result=PASS|FAIL`:

```sh
env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe . --smoke-test=steam-solo --smoke-dir=../.playwright-mcp
# two instances, no Steam needed:
env -u ELECTRON_RUN_AS_NODE OPEN_RUMMY_STEAM=mock node_modules/electron/dist/electron.exe . --profile=1 --smoke-test=mock-host --smoke-dir=../.playwright-mcp
env -u ELECTRON_RUN_AS_NODE OPEN_RUMMY_STEAM=mock node_modules/electron/dist/electron.exe . --profile=2 --smoke-test=mock-guest --smoke-dir=../.playwright-mcp
```

| Scenario | What it does |
|---|---|
| `steam-solo` | Steam button on the title -> signed in -> create a **friends-only** lobby -> our seat shown as host (and `currentLobby()` owned by us) -> start (3 bots) -> 3D table -> play `OPEN_RUMMY_SMOKE_TURNS` (4) decisions -> leave -> back on the Steam home with `currentLobby() === null` |
| `mock-host` | as above with a **public** lobby, waits (120 s) for a guest to be seated, starts (2 bots), plays, then waits for the toast that the guest's seat went to a bot and for one more own decision |
| `mock-guest` | finds the lobby in the browser (refreshing), joins, plays 3 decisions, leaves mid-game |
| `mock-host-quit` | as `mock-host`, but does not wait for a takeover: after its decisions (and `OPEN_RUMMY_SMOKE_HOLD_MS`) the host leaves while the guest is still seated |
| `mock-guest-stay` | as `mock-guest`, but keeps playing until the host leaves; expects the "host left" modal, the Steam home screen and `currentLobby() === null` |
| `online-check` | the title shows the Online Room item (a server URL is configured), opening it completes the WebSocket handshake (`hello` -> `welcome`, the connection dot turns "connected") with the configured server, and a WebSocket to any other host is refused by the page CSP. No room is created |

Pair the mock scenarios as `mock-host` + `mock-guest` (the guest leaves mid-game, the host sees a bot take the
seat) and `mock-host-quit` + `mock-guest-stay` (the host leaves, the guest sees "host left").

`--smoke-dir` / `OPEN_RUMMY_SMOKE_DIR` saves `desktop-<scenario>-NN-<step>.png` via `capturePage()` (keep it in a
gitignored folder: the Steam screens show the persona name). `OPEN_RUMMY_SMOKE_HOLD_MS` pauses at the table
(used to press Shift+Tab for the overlay by hand). With a path containing spaces pass `--smoke-dir` quoted (or
use the env var): PowerShell 5.1 `Start-Process -ArgumentList` does not quote array elements.

Environment and arguments of the main process:

| Name | Effect |
|---|---|
| `OPEN_RUMMY_STEAM` | unset: real Steam. `mock`: loopback relay (section 11). `off`: Steam disabled (`available()` is `{ok:false}`) |
| `OPEN_RUMMY_STEAM_APPID` | app id override (else `steam_appid.txt`, else 480) |
| `OPEN_RUMMY_MOCK_PORT` | relay port for `mock` (default 37651, 127.0.0.1 only) |
| `OPEN_RUMMY_SERVER` / `--server=<url>` | online (WebSocket) server, default `wss://www.chon9.com/ws`; `off` hides the online mode (section 10, "Online server"). `--server` wins over the env |
| `--dev` | DevTools (F12), menu bar, renderer console mirrored to stdout |
| `--profile=N` | 1..999: separate `userData` (`...-profile-N`) and **no single-instance lock**, so several instances can run side by side |
| F11 | toggles fullscreen (always) |

## 3. Architecture decision

```
 Steam client (must be running + logged in)
        ^  steam_api64.dll
        |
 +------+---------------------------- Electron MAIN process --------------------------+
 | SteamService (steamworks.js native, callbacks pumped at 30 Hz by steamworks.js,   |
 |   P2P queue polled every 16 ms)  <->  ipcMain handlers (sender + argument checks) |
 +------+-----------------------------------------------------------------------------+
        | IPC (strings only; Steam ids as decimal strings)
 +------+--- preload (sandbox, contextIsolation) -> window.openRummyDesktop ----------+
        |
 +------+--- renderer = packages/client built by desktop/vite.config.ts ---------------+
 | title/lobby UI -> SteamTransport (host or guest) -> same UI + 3D scene as web      |
 | lobby OWNER: runs the authoritative shared GameHost (same engine as offline/server)|
 +-------------------------------------------------------------------------------------+
```

Decisions:

1. **Main owns Steam.** steamworks.js is a native N-API module; it runs only in main. The renderer stays
   `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false` (the steamworks.js README suggests
   node integration in the renderer; we deliberately do not). Callbacks: `steamworks.init()` already
   starts `runCallbacks()` on a `setInterval` at 30 Hz; main additionally polls the P2P queue.
2. **Preload exposes a minimal, validated API** (`OpenRummyDesktopBridge`), ids as decimal strings
   (bigint does not cross `contextBridge`), payloads as strings, results as `{ ok, reason }`.
3. **Renderer reuses `packages/client` unchanged**, built with `base: './'` into `desktop/dist/renderer`
   and served from the privileged standard scheme `app://open-rummy/` (`protocol.handle`). `file://` is
   not used because Chromium refuses `fetch()` on `file:` (three.js loads `.vrm` via fetch) and module
   scripts. The protocol handler blocks path traversal, sets a CSP on HTML and serves `.vrm` as
   `model/gltf-binary`. Navigation away from `app://open-rummy/` is blocked; `window.open` is denied
   (https links go to the system browser).
4. **Host-authoritative P2P.** The Steam lobby owner runs `GameHost` from `@open-rummy/shared` in its
   renderer, exactly like `LocalTransport`, but some seats are remote humans. Guests send
   `ClientMessage`-shaped intents and receive `ServerMessage`-shaped messages over Steam P2P, addressed by
   SteamID. The same protocol types as the WebSocket server mean the guest transport is almost
   `OnlineTransport` with a different pipe.
5. **Per-seat projected views only.** The host forwards `GameHost` `onUpdate(seat, view, events)` only to
   that seat's SteamID. No message ever contains another seat's hand or the wall. (The host machine itself
   holds the full state, the usual listen-server trade-off accepted for v1.)
6. **Reliable channel** (`SendType.Reliable`, ordered per peer) for everything.
7. **No host migration in v1.** Host leaves -> every guest shows a clear "host left" message and returns
   to the title/lobby browser. Guest leaves mid-game -> that seat becomes a bot (`GameHost.replaceWithBot`).
8. **Steam failure is non-fatal.** If steamworks.js cannot load/init (Steam closed, not logged in, no
   app id), `steam.available()` resolves `{ ok: false, reason }`; offline vs bots keeps working and the
   UI hides Steam play.

## 4. steamworks.js 0.4.0 - what actually exists

Read from `desktop/node_modules/steamworks.js/{index.d.ts,client.d.ts,callbacks.d.ts,index.js,README.md}`.

### Entry points (`require('steamworks.js')`)

| API | Notes |
|---|---|
| `init(appId?: number)` | Throws on failure. Without `appId` it reads `steam_appid.txt` (cwd). Returns the client API (everything below). Also starts `setInterval(runCallbacks, 1000/30)` - callbacks are automatic. |
| `restartAppIfNecessary(appId)` | `SteamAPI_RestartAppIfNecessary`. Use only with a real app id in release builds (relaunches through Steam). Not for 480. |
| `electronEnableSteamOverlay(disableEachFrameInvalidation?)` | Appends Chromium switches `in-process-gpu` and `disable-direct-composition` and, unless disabled, invalidates every BrowserWindow each frame (60 Hz) so the overlay can draw. **Must be called before `app` is ready and before windows are created.** |
| `SteamCallback` | runtime enum object (the typings declare a const enum; with `isolatedModules` use numbers, see `SteamCb` in `desktop/src/steam/service.ts`). |

### Client namespaces

- `localplayer`: `getSteamId(): { steamId64: bigint, steamId32: string, accountId: number }`, `getName()`,
  `getLevel()`, `getIpCountry()`, `setRichPresence(key, value?)`.
- `matchmaking`:
  - `LobbyType`: `Private = 0`, `FriendsOnly = 1`, `Public = 2`, `Invisible = 3`.
  - `createLobby(type, maxMembers): Promise<Lobby>`, `joinLobby(lobbyId: bigint): Promise<Lobby>`,
    `getLobbies(): Promise<Lobby[]>` - **no filter arguments** (plain `RequestLobbyList`; Steam's default
    distance filter and result cap of 50 apply). Filtering by key must be done on the returned lobbies.
  - `Lobby`: `id: bigint`, `join()`, `leave()`, `openInviteDialog()`, `getMemberCount(): bigint`,
    `getMemberLimit(): bigint | null`, `getMembers(): PlayerSteamId[]`, `getOwner(): PlayerSteamId`,
    `setJoinable(bool)`, `getData(key)`, `setData(key, value)`, `deleteData(key)`, `getFullData()`,
    `mergeFullData(record)`. Only the owner can set lobby data. There is **no** member data, lobby chat
    message, kick, or set-owner API.
- `networking` - wraps the **legacy `ISteamNetworking` P2P API** (SendP2PPacket family, channel 0, Steam
  relay/NAT traversal), not `ISteamNetworkingMessages`/`Sockets`:
  - `SendType`: `Unreliable = 0` (max 1200 bytes), `UnreliableNoDelay = 1`, `Reliable = 2` (max 1 MB),
    `ReliableWithBuffering = 3` (Nagle).
  - `sendP2PPacket(steamId64: bigint, type, data: Buffer): boolean`
  - `isP2PPacketAvailable(): number` - size of the next packet, 0 when none.
  - `readP2PPacket(size): { data: Buffer, size, steamId: PlayerSteamId }`
  - `acceptP2PSession(steamId64: bigint)` - answer `P2PSessionRequest`. Sending to a peer also implicitly
    accepts that peer. There is **no** `closeP2PSessionWithUser`; idle sessions time out on their own.
- `callback.register(SteamCallback, handler): Handle` (`handle.disconnect()`), payloads (all ids bigint):
  - `PersonaStateChange (0)`: `{ steam_id, flags: { bits } }`
  - `SteamServersConnected (1)`: `{}`; `SteamServersDisconnected (2)`: `{ reason }`;
    `SteamServerConnectFailure (3)`: `{ reason, still_retrying }`
  - `LobbyDataUpdate (4)`: `{ lobby, member, success }` (`member == lobby` -> lobby data changed)
  - `LobbyChatUpdate (5)`: `{ lobby, user_changed, making_change, member_state_change }` where
    `ChatMemberStateChange` is `Entered 0, Left 1, Disconnected 2, Kicked 3, Banned 4`
  - `P2PSessionRequest (6)`: `{ remote }`; `P2PSessionConnectFail (7)`: `{ remote, error }`
  - `GameLobbyJoinRequested (8)`: `{ lobby_steam_id, friend_steam_id }`
  - `MicroTxnAuthorizationResponse (9)`
  - Not exposed: `LobbyEnter`, `LobbyChatMsg`, `GameRichPresenceJoinRequested`, avatar-loaded callbacks.
- `overlay`: `activateDialog(Dialog)`, `activateDialogToUser(Dialog, steamId64)`,
  `activateInviteDialog(lobbyId: bigint)`, `activateToWebPage(url)`, `activateToStore(appId, flag)`.
  `Dialog`: `Friends, Community, Players, Settings, OfficialGameGroup, Stats, Achievements`.
- `utils`: `getAppId()`, `getServerRealTime()`, `isSteamRunningOnSteamDeck()`, gamepad text input helpers.
- Also present but unused: `achievement`, `apps`, `auth` (session tickets), `cloud`, `input`, `stats`, `workshop`.
- **Not present in 0.4.0: a `friends` namespace** (no friend list, no other users' persona names, no
  avatars). Consequences: lobby members are SteamIDs only; display names travel in the P2P `hello`;
  `avatarDataUrl` in the bridge is optional and may resolve `null`.

### Electron caveats

- Call `electronEnableSteamOverlay()` before `app.whenReady()` (the skeleton does it right after a successful
  `init`, and skips it when Steam is unavailable so non-Steam users keep the normal GPU process).
- `in-process-gpu` moves the GPU work into the browser process (overlay hooks D3D there); a GPU crash then
  takes the whole app down. Verified: WebGL2 still works with the switches on this machine.
- The overlay draws only while the window repaints; steamworks.js forces a repaint each frame.
- Overlay (Shift+Tab) for a game not launched by Steam is injected at `SteamAPI_Init`; it is more reliable
  when the exe is started from Steam (e.g. added as a non-Steam game, or a real app id). Not yet verified visually.
- Packaging: the `.node` and `steam_api64.dll` must be outside the asar (`asarUnpack`
  `node_modules/steamworks.js/dist/win64/**`). Node loads the `.node` with an altered DLL search path, so
  the DLL beside it is found; a copy of `steam_api64.dll` and `steam_appid.txt` is also placed next to
  `Open Rummy.exe` via `extraFiles`. `npmRebuild: false` (N-API prebuilt, no rebuild needed).

## 5. Spacewar (app id 480)

- App id resolution in `desktop/src/steam/backend.ts`: env `OPEN_RUMMY_STEAM_APPID`, else `steam_appid.txt` next to
  the exe (packaged) / in `desktop/` (dev) / in cwd, else 480. The id is also passed to `init()`.
- Works with 480: init, local player, lobbies (create/join/data/members/invite dialog), P2P relay,
  overlay, `GameLobbyJoinRequested` while the game is running.
- Limits:
  - The app id is shared by every Steamworks developer. Our lobbies must be tagged (`game=open-rummy`,
    `version=<PROTOCOL_VERSION>`) and every listed/joined lobby checked against both.
  - `getLobbies()` cannot filter server-side, so the lobby browser sees whatever 50 lobbies Steam returns
    for 480 and may miss ours. Under 480 the lobby browser is **best effort**; invites and "Join game" from
    the friends list are the primary flow. With our own app id (or a steamworks.js build exposing
    `addRequestLobbyListStringFilter`) this goes away.
  - If an invitee does not have Open Rummy running, accepting the invite makes Steam launch **Spacewar**
    (app 480), not our exe. Under 480, both players must start Open Rummy first.
  - Steam must be running and logged in on both machines; two different Steam accounts are needed to
    test P2P (two machines, or a VM).
  - Shows as "Spacewar" in friends' lists; rich presence/achievements are Spacewar's.

## 6. Steam P2P protocol

Payloads are UTF-8 JSON strings carrying the existing protocol envelopes from `@open-rummy/shared`
(`PROTOCOL_VERSION`), see `SteamGuestMessage` / `SteamHostMessage` in the contract.

Guest -> host (`SteamGuestMessage`): `hello`, `set_avatar`, `action`, `emote`, `leave_room`, `ping`.
Everything else from a guest is dropped (counted, never answered; the host does not send `NOT_HOST`). Room
management (add bot, remove seat, start, restart) is local to the host's own UI. A `hello.token` is
meaningless over Steam (identity is the SteamID): a well-formed one is dropped, a malformed one refuses the
`hello` (the server's rule).

Host -> guest (`SteamHostMessage` = `ServerMessage` plus `SteamRoomExtras` on `room`): `welcome`
(`token: ''`), `room` (per receiver `you`; Steam-only `relaxed?: boolean` = the host chose relaxed mode, no
decision deadlines, guests hide every countdown; absent = timed), `game` (`{ view, events, serverNow }` with
the receiver's projected view only, `serverNow = Date.now()` of the host so the guest corrects deadline skew
like `OnlineTransport`), `emote`, `left`, `error` (`VERSION` / `ROOM_FULL` / `ALREADY_STARTED` refuse a
`hello`, `NOT_IN_ROOM` ends the session, `ILLEGAL` is informational), `pong`.

Flow:

1. Host: `createLobby({ visibility, maxMembers: DESKTOP_LIMITS.maxLobbyMembers /* 5 */ })` -> lobby data keys (section 7) ->
   seat 0 is the host. Invite with `openInviteDialog()`. The Steam lobby always has room for 5 (the largest
   table; Steam's member limit cannot be changed later through steamworks.js 0.4, while the host may change
   `players` in the room); the host seats at most `cfg.players` and answers the rest `ROOM_FULL`. The lobby
   browser disables rows whose `seats` data is full or `started=1`.
2. Guest: `joinLobby(id)` (browser row, invite, or `join-requested`) -> main checks `game`/`version` lobby
   data -> `lobby-entered` -> guest sends `{t:'hello', v: PROTOCOL_VERSION, name}` (+ `set_avatar`) to the owner.
3. Host validates sender is a lobby member, version matches, a seat is free and the game has not started
   (else `error` `VERSION` / `ROOM_FULL` / `ALREADY_STARTED`; the guest then leaves) -> seat assigned ->
   `welcome` to the guest, `room` to everyone, `seats` lobby data updated.
4. Start: host builds the match like `LocalTransport` / server rooms, one `GameHost`; `onUpdate(seat, ...)`
   -> local handlers for the host's seat, `sendTo(seatSteamId, {t:'game'...})` for remote seats.
   `setLobbyJoinable(false)` and `started=1` while a game runs.
5. Actions: guest `{t:'action', action}` -> host validates (the server's own `parseAction`, from
   `packages/shared/src/validate.ts`) -> `GameHost.submit(seat, action)` -> on reject `{t:'error', code:'ILLEGAL'}`.
6. Emotes: validated against `EMOTES`, rate limited, relayed as `{t:'emote', seat, id}`.
7. Keepalive: guest `ping` every `keepaliveMs` (10 s), host answers `pong`; silence for `peerTimeoutMs`
   (30 s) counts as gone.
8. Guest gone (`leave_room`, `member-left`, `p2p-failed`, timeout): before start -> free the seat; during a
   game -> `GameHost.replaceWithBot(seat)`; broadcast `room`. No resume in v1 (that guest may rejoin only
   before the next game starts). When the host gave the seat away for a **P2P failure or silence** while that
   member is still in the lobby, it sends `{t:'error', code:'NOT_IN_ROOM'}` and answers every later ping /
   hello / action of that member the same way (never `pong`), so a guest that can still hear the host leaves
   with "a bot took over your seat" instead of waiting on a frozen table. The guest treats `NOT_IN_ROOM` as
   the end of its session at any time. A seated guest that repeats `hello` mid-game gets `welcome`, `room`
   and its seat's current view again (resync); an action from a seated guest between matches is answered
   `ILLEGAL` (not fatal).
9. Host gone: the host broadcasts `{t:'left'}` before `leaveLobby()` (best effort). Guests also treat
   `owner-changed`, `member-left`/`p2p-failed` of the host SteamID, or host silence as "host left": show the
   localized message, `leaveLobby()`, return to the menu. Steam itself moves ownership to another member;
   v1 ignores that (no migration).
10. Restart after `MATCH_END`: host only, same semantics as the server's `restart_room`.

Validation and limits (both ends):

- Main: drops packets from SteamIDs not in the current lobby, packets over
  `DESKTOP_LIMITS.maxP2PMessageBytes` (64 KiB), non-UTF-8 payloads; reads at most `maxPacketsPerTick`
  packets per 16 ms tick; accepts `P2PSessionRequest` only from current lobby members; refuses `sendTo`
  for non-members.
- Host renderer: `parseGuestMessage` = the server's `parseClientMessage` (16 KiB UTF-8 cap
  `MAX_MESSAGE_BYTES`, JSON, strict shapes, `sanitizeName`, `parseAction`) restricted to the guest envelopes,
  and a per-guest `TokenBucket` (20 msg/s, bursts of 40) below main's 60/120 guest limit. These helpers live in
  `packages/shared/src/validate.ts` and are the same code the WebSocket server runs
  (`packages/server/src/session.ts` re-exports them).
- Host send rate: one `game` per state change per guest, `room` on seat changes, `pong` per `ping`, relayed
  emotes (one per guest per emote gap): a few messages per second, far below the owner limit main applies on
  the guest side (400/s, bursts of 800) and Steam's reliable-channel limits. All sends are reliable + ordered.
- Guest renderer: accept messages only from the current lobby owner, validate the `t` field and shapes
  before handing views to the UI.

## 7. Lobby data keys (owner writes, everyone reads)

Constants in the contract (`LOBBY_KEYS`, `LOBBY_GAME_TAG`):

| Key | Value |
|---|---|
| `game` | `open-rummy` (always; main adds it on create) |
| `version` | `PROTOCOL_VERSION` as string (main adds it; joins with another value are refused) |
| `host` | host display name for the browser |
| `seats` | `taken/total`, e.g. `2/4` (bots count as taken) |
| `started` | `0` or `1` |
| `rules` | compact JSON of the resolved `RulesConfig` |
| `bot` | `BotLevel` |

Steam limits: key up to 255 chars, value up to 8 KB; the bridge caps keys at 64 and values at 4096.

## 8. Invites and joining

- Invite: `steam.openInviteDialog()` -> overlay invite dialog for the current lobby (`activateInviteDialog`).
- Accepting an invite / "Join game" in the friends list while Open Rummy runs -> `GameLobbyJoinRequested` ->
  bridge event `join-requested` (also kept for `consumePendingJoin()`).
- Launched by Steam from an invite -> `+connect_lobby <id>` on the command line (first instance: `process.argv`;
  already running: `second-instance`). The app is single-instance. Under 480 see the Spacewar caveat above.
- Lobby browser: `listLobbies()` (main filters by `game` + `version`; best effort under 480).
- The renderer should, at boot: subscribe to `onLobbyEvent`, then call `consumePendingJoin()`.

## 9. Bridge contract summary

`window.openRummyDesktop: OpenRummyDesktopBridge` (absent in the browser build). Full documentation per
method is in `packages/client/src/net/desktopBridge.ts`.

- `app.info()` (versions, platform, packaged), `app.quit()`, `app.toggleFullscreen()`.
- `steam.available()`, `steam.me()`.
- Lobby: `createLobby(opts)`, `joinLobby(id)`, `leaveLobby()`, `currentLobby()`, `lobbyMembers()`,
  `listLobbies()`, `setLobbyData(k, v)`, `setLobbyDataMany(record)`, `getLobbyData(k)`, `setLobbyJoinable(b)`,
  `openInviteDialog()`, `avatarDataUrl?(id)`, `consumePendingJoin()`.
- P2P: `sendTo(steamId, data)`, `broadcast(data)`.
- Events: `onMessage(cb(fromSteamId, data))`, `onLobbyEvent(cb(evt))` with `evt.type` in
  `lobby-entered | lobby-left | member-joined | member-left | owner-changed | data-updated | join-requested |
  p2p-failed | steam-connection`. Both return an unsubscribe function.
- Test double: `createMockSteamNetwork(n, opts)` in `packages/client/src/net/mockDesktop.ts` -> `n` bridges wired
  through an in-memory Steam (vitest). The Electron-level equivalent is `OPEN_RUMMY_STEAM=mock` (section 11).
- Detection in the renderer: `window.openRummyDesktop !== undefined`; compile-time
  `typeof __DESKTOP__ !== 'undefined' && __DESKTOP__` (only the desktop Vite build defines it).

## 10. Main-process implementation notes

- **Background throttling is off** (`backgroundThrottling: false`): a minimised / covered window must keep its
  keepalive pings and the host's GameHost timers running. Verified with two mock instances: with throttling on,
  a minimised guest was dropped by the host as silent (and its table stopped animating); with it off, the same
  minimised guest played its turns and left normally.
- **Window:** 1600x900 (min 1024x600), title `Open Rummy 拉米麻将` (the page `<title>` does not override it),
  icon from `dist/icon.ico|png` when `build-resources/icon.ico|png` exists (copied by `build.mjs`; none yet),
  menu removed unless `--dev`, DevTools disabled unless `--dev`.
- **Security:** `contextIsolation`, `sandbox`, no node integration (also not in workers), `webSecurity`,
  no `<webview>`, CSP on every HTML response (`script-src 'self'`, `frame-src`/`object-src` none,
  `form-action 'none'`, `connect-src 'self' data: blob: <online server origin>`), `X-Content-Type-Options: nosniff`, navigation outside `app://open-rummy/` blocked
  (https links go to the default browser via `shell.openExternal`, other schemes are dropped), off-origin
  redirects blocked, `window.open` denied, permission requests denied except `fullscreen` and
  `clipboard-sanitized-write` (the room code copy button). IPC handlers accept calls only from the app's own
  frame and re-validate every argument with the same guards preload uses; unexpected handler errors are logged
  and rejected with a generic message.
- **Online server:** the page origin is `app://open-rummy`, so the WebSocket online mode cannot use same-origin.
  Main resolves the URL once at startup: `--server=<url>` > `OPEN_RUMMY_SERVER` > `wss://www.chon9.com/ws`
  (`DEFAULT_DESKTOP_SERVER_URL` in `packages/client/src/net/serverUrl.ts`), normalised by `normaliseServerUrl`
  (`wss://` only, `ws://` only on loopback, `https://` maps to `wss://`, empty path becomes `/ws`, no
  credentials / query / fragment). It is passed to the renderer as `app.info().onlineServerUrl`
  (`setServerUrl`, used by `OnlineTransport`) and its origin is the only remote entry in the CSP `connect-src`.
  `off` / `none` or an invalid value: `onlineServerUrl: null`, the Online Room item is hidden, Steam lobbies
  still work. The browser build keeps same-origin `/ws`.
  **Server side:** browsers (and Electron) send `Origin: app://open-rummy`. A server with `ALLOWED_ORIGINS` set
  must list it, e.g. `ALLOWED_ORIGINS=https://www.chon9.com,app://open-rummy`, or it answers the upgrade with
  403 (checked 2026-10-13: the deployed `wss://www.chon9.com/ws` currently returns 403 for `app://open-rummy`
  and `welcome` for `https://www.chon9.com`, so the desktop online mode needs that server setting).
- **Shutdown:** `will-quit` is deferred until the backend's `dispose()` (leave lobby, stop timers; capped at 1.5 s).
  `uncaughtException` / `unhandledRejection` are logged, never fatal.
- **SteamService (real):**
  - Callbacks are already pumped by steamworks.js (30 Hz). P2P is polled every `p2pPollMs` (16 ms), draining up
    to `maxPacketsPerTick` packets; oversized (> 64 KiB), non-UTF-8 and non-member packets are dropped.
  - Incoming messages are rate limited per peer: guests 60 msg/s with bursts of 120; the lobby owner
    (authoritative host, sends per-seat views) 400 msg/s with bursts of 800. Drops are logged (counts only).
  - Membership and owner are reconciled from `lobby.getMembers()` / `getOwner()` on every `LobbyChatUpdate` and
    `LobbyDataUpdate` and diffed into `member-joined` / `member-left` / `owner-changed`; being removed by Steam
    emits `lobby-left` with the Steam reason. A cache miss on a P2P sender re-reads the member list first
    (packets can beat `LobbyChatUpdate`).
  - `P2PSessionRequest` is accepted only from current members; a request from an unknown id is parked for 30 s
    (max 32) and accepted if that id shows up as a member.
  - create/join/leave are serialised; create/join/list time out after 20 s (a late create/join result is left
    immediately). join checks `game`/`version` lobby data after entering and leaves again on mismatch.
  - `setLobbyDataMany`: `''` deletes the key, the rest is one `mergeFullData` (one `LobbyDataUpdate`).
  - `avatarDataUrl` resolves `null` (no API in 0.4). Member persona names are not available (no friends API);
    they travel in the P2P `hello`.

## 11. Mock Steam for local testing (`OPEN_RUMMY_STEAM=mock`)

Two (or more) Electron instances on one machine, no Steam client, real bridge/IPC code paths:

```sh
cd desktop && npm run build
env -u ELECTRON_RUN_AS_NODE OPEN_RUMMY_STEAM=mock node_modules/electron/dist/electron.exe . --profile=1
env -u ELECTRON_RUN_AS_NODE OPEN_RUMMY_STEAM=mock node_modules/electron/dist/electron.exe . --profile=2
```

- The first instance binds a TCP relay on `127.0.0.1:37651` (`OPEN_RUMMY_MOCK_PORT`), holding one
  `MockSteamWorld`; every instance (the first too) connects as a client. Newline-delimited JSON:
  `hello` / `welcome`, `req {id, op, args}` / `res {id, result}`, pushed `evt {LobbyEvent}` and `msg {from, data}`.
  Lines are capped at 256 KiB; the relay validates the hello identity and dispatches only a fixed op list;
  arguments are re-validated by the world with the same guards as IPC.
- Identity: `--profile=N` -> SteamID `76561198000000000 + N`, name `Mock Player N`.
- Semantics match the real backend and the renderer test double (`packages/client/src/net/mockDesktop.ts`):
  tag/version-filtered `listLobbies` (public, joinable, not full), owner-only lobby data, P2P only between
  members, owner moves to the oldest member when the owner leaves, `disconnected` when an instance dies.
- `openInviteDialog()` delivers `join-requested` to every other connected instance (simulated "invite accepted").
- If the relay-owning instance quits, the others get `lobby-left` (`disconnected`) and `steam-connection` false,
  then one of them re-binds the port (empty world) and all reconnect (retry every 1.5-2 s). Not yet exercised
  in a test.

## 12. Status and next steps

Verified on 2026-10-13 (this machine, Steam client logged in):

- Skeleton: install, build, typecheck, title screen over `app://`, WebGL2 with the overlay switches, `.vrm` fetch.
- Real Steam (480), `OPEN_RUMMY_SMOKE_STEAM=lobby`, with `desktop/` electron and with the packaged
  `release/win-unpacked/Open Rummy.exe`: create (18-digit lobby id, 1 member, owner, `game`/`version` set),
  set/get lobby data (`data-updated` events), `currentLobby`, `sendTo(self)` refused, leave (`lobby-left`).
- Mock relay, two instances (`--profile=1` host, `--profile=2` guest): list -> join (2 members) -> guest ping ->
  host pong -> both leave; the host saw `member-joined` then `member-left`.
- `npm run dist`: `release/OpenRummy-Portable-0.1.0.exe` and `release/OpenRummy-Setup-0.1.0.exe` (about 142 MB
  each), not code signed.

Integration pass (same day, after the renderer side landed):

- Real Steam (480, Steam client logged in), `--smoke-test=steam-solo` through the UI: Steam button on the
  title, signed in, friends-only lobby created with us seated as host, match started against 3 bots, 3D table
  with the VRM avatars rendered in Electron, 4 own decisions played through Hint, leave -> `currentLobby()` null.
- Steam overlay: Shift+Tab sent to the Electron window (Windows SendKeys) opened the Steam overlay over the
  table (friends / "invite anyone to play" panel visible); a second Shift+Tab closed it. Checked from a desktop
  capture, which was deleted afterwards (it showed the friends list).
- Mock relay, two Electron instances through the UI (`mock-host` / `mock-guest`): public lobby listed and
  joined from the browser, host started with 2 bots, both played turns, the guest left mid-game and the host
  got the takeover toast, saw the seat as a bot and kept playing. Also passed with the guest window minimised.
- Follow-up pass (after moving validation to `@open-rummy/shared` and adding the configurable online server):
  real Steam `steam-solo` PASS again (friends-only lobby with 1 member, 3 bots, 3D table with avatars, 4
  decisions via Hint, leave, no renderer console errors); mock `mock-host` + `mock-guest` PASS (guest left
  mid-game, host saw "Mock Player 2 (电脑)" take the seat and kept playing) and `mock-host-quit` +
  `mock-guest-stay` PASS (host left mid-game, the guest got "房主已离开，房间已关闭。" and returned to the
  Steam home with no lobby). `online-check` against a local server (`--server=ws://127.0.0.1:3471` and
  `OPEN_RUMMY_SERVER=...`, server `ALLOWED_ORIGINS=https://www.chon9.com,app://open-rummy`) PASS including the
  CSP refusal of another host; against the deployed default it FAILS with HTTP 403 (Origin not allowed, see
  section 10). The overlay was not re-tested in this pass.
- Unit tests (`packages/client/src/net/steam/steam.test.ts`, in-memory mock Steam): hidden hands, spoofed /
  malformed / oversized / non-guest messages, P2P-failure drop with `NOT_IN_ROOM` (no zombie pongs), mid-game
  hello resync, flood throttling, hello after start (`ALREADY_STARTED`), 5-seat table with 4 guests and a 6th
  member refused by Steam, protocol version mismatch (hello and lobby data).

Not verified: the invite dialog, real P2P between two Steam accounts (needs a second machine/account),
`GameLobbyJoinRequested` / `+connect_lobby`, mock relay failover.

Renderer side (done): `createMockSteamNetwork`, `SteamHostTransport` / `SteamGuestTransport`
(`packages/client/src/net/steam/`), Steam home / lobby screens (`ui/steamLobby.ts`, `ui/steamFlow.ts`), loaded
only when `window.openRummyDesktop` exists. The WebSocket online mode is shown on desktop when main supplies
a server URL (default `wss://www.chon9.com/ws`, section 10). One lobby create/join runs at a time
(`steamFlow.ts`): a repeated invite or a double click while a join is pending is dropped instead of leaving
the lobby the first join just entered.

For a real release: own Steam app id (replace `steam_appid.txt`, call `restartAppIfNecessary(appId)` early in
main, do not ship `steam_appid.txt` in Steam depots; the `extraFiles` copy of it is for development / 480 only),
app icon (`build-resources/icon.ico`), code signing.
