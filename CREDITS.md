# Credits

Open Rummy is a fan-made project and is **not affiliated with, endorsed by or connected to
Mahjong Soul (雀魂), Yostar, Cat Food Studio or any rule source listed below**. "Mahjong
Soul-inspired" describes only the general visual style: a 3D table with anime avatars. The
project uses no assets, code or trademarks from that game.

## 3D characters (packages/client/public/avatars)

All bundled models allow redistribution. The license fields below were checked against the
metadata embedded in each `.vrm` file.

| File | Model | Author | License | Credit required | Source |
|---|---|---|---|---|---|
| `twist.vrm` | VRM1_Constraint_Twist_Sample (v1.0.1) | pixiv Inc. | [VRM Public License 1.0](https://vrm.dev/licenses/1.0/) | No | [pixiv/three-vrm](https://github.com/pixiv/three-vrm) (`packages/three-vrm/examples/models/`) |
| `vrm-girl.vrm` | three-vrm-girl (v1.1) | pixiv Inc. | VRoid Hub conditions: redistribution allowed, modification allowed, credit unnecessary, commercial use allowed | No | [pixiv/three-vrm v0.6.11](https://github.com/pixiv/three-vrm/tree/v0.6.11/examples/models) |
| `shino.vrm` | 千駄ヶ谷 篠 (Sendagaya Shino) | VRoid Project (pixiv Inc.) | CC0 (per the OpenGameArt listing); embedded VRoid Hub conditions also allow redistribution and need no credit | No | [OpenGameArt: VRoid Studio CC0 models](https://opengameart.org/content/vroid-studio-cc0-models) |
| `sample-e.vrm` | ビビ (AvatarSample_E) | VRoid Project (pixiv Inc.) | CC0 (per the OpenGameArt listing); embedded VRoid Hub conditions also allow redistribution and need no credit | No | [OpenGameArt: VRoid Studio CC0 models](https://opengameart.org/content/vroid-studio-cc0-models) |
| `sample-f.vrm` | ヴィータ (AvatarSample_F) | VRoid Project (pixiv Inc.) | CC0 (per the OpenGameArt listing); embedded VRoid Hub conditions also allow redistribution and need no credit | No | [OpenGameArt: VRoid Studio CC0 models](https://opengameart.org/content/vroid-studio-cc0-models) |

None of the bundled models requires attribution. The in-game Credits screen still names their
authors (pixiv Inc. and VRoid Project) as a courtesy.

The avatar animations (seated pose, idle, blinking, gestures) are procedural code in this
repository. No third-party motion files are used.

## Libraries

| Library | Version | License |
|---|---|---|
| [three.js](https://github.com/mrdoob/three.js) | 0.186.1 | MIT |
| [@pixiv/three-vrm](https://github.com/pixiv/three-vrm) | 3.5.5 | MIT |
| [GSAP](https://gsap.com) | 3.15.0 | GSAP Standard "No Charge" License ([gsap.com/standard-license](https://gsap.com/standard-license)). It is free to use, including commercially, but it is **not** an OSI open-source license. Read its terms for the use restrictions, for example on products that compete with Webflow. |
| [ws](https://github.com/websockets/ws) | 8.22.0 | MIT |
| [Vite](https://vite.dev) | 6.4.4 | MIT |
| [esbuild](https://esbuild.github.io) | 0.28.2 | MIT (build tool only) |
| [Vitest](https://vitest.dev) | 3.2.7 | MIT (tests only) |
| [TypeScript](https://www.typescriptlang.org) | 5.9.3 | Apache-2.0 (build tool only) |
| [tsx](https://github.com/privatenumber/tsx) | 4.23.15 | MIT (development only) |

The license strings above come from each package's `package.json` in `node_modules`. Check
each package's own LICENSE file for the full terms.

## Rules sources

The canonical rules are in [docs/RULES.md](docs/RULES.md). They were put together from:

- **Cari Makan 揾到食**: the Facebook post with four rule cards (2022). This is the primary
  source, and the game's default rule set follows it.
- **XUAN** articles on 拉米麻将 (2021 and 2026). They confirm the port and cut (斩) rules.
- **Penang / Si Rummy** card-game conventions, used where the tile sources leave gaps (the
  "Penang Classic" preset).
- **Everything Boleh**, **Viralcham** and **Lemon8** posts, used for the tile count, dealing and
  payout options listed in RULES.md §12.

Where no source settles a rule, RULES.md marks the choice as **[house rule choice]**.

## Tile artwork

The tile faces are drawn procedurally at runtime (`packages/client/src/art/`). No tile images
are copied from other games or apps.
