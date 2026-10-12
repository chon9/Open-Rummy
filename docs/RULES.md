# Malaysian Rummy Mahjong (拉米麻将 / LAMI): canonical rules spec v1.0

**Basis.** This is Penang/Si Rummy played with mahjong-style tiles. The primary source is the user's Cari Makan FB post (4 rule cards, 2022). XUAN 2021 and XUAN 2026 corroborate it. Penang Rummy fills gaps the tile sources leave open. There is **no draw and no discard**: each hand only shrinks.

Rules the sources do not settle are marked **[house rule choice]**, each with a one-line reason. Alternatives are listed in §12 Rule options.

---

## 1. Tile set (112 tiles)

**Colours and suits.** The colour-to-suit mapping comes from FB card 1.

| Code | Colour | 中文 | Suit symbol on tile |
|---|---|---|---|
| `B` | Black | 黑 | ♠ |
| `R` | Red | 红 | ♥ (桃花 in XUAN's examples) |
| `Y` | Yellow | 黄 | ♦ |
| `G` | Cyan/teal | 青 | ♣ |

**Ranks.** There are 13 ranks: `A,2,3,4,5,6,7,8,9,10,J,Q,K`, with internal values A=1 (or 14 when high), 2–10 at face value, J=11, Q=12, K=13.

**Copies.** Each colour-rank has 2 copies: 4 × 13 × 2 = 104 tiles.

**Jokers.** There are 8 Jokers, fully wild. For art only, give 2 Jokers each colour's styling; colour has no rule effect. **[house rule choice]** 8 Jokers, because 112 − 104 = 8 and both the FB image and Everything Boleh show 8.

**Tile IDs.**
- Rank tiles: `${colour}${rank}_${copy}`, e.g. `R10_1`, `BA_2`, `GQ_1`. `copy` is 1 or 2.
- Jokers: `JK_1` … `JK_8`.

**Penalty values** (for tiles left in hand):

| Tile | Points |
|---|---|
| A | 15 |
| 10, J, Q, K | 10 |
| 2–9 | Face value |
| Joker | 20 |

The Joker value is a **[house rule choice]**: no tile source gives one, and every card and app version uses 20.

---

## 2. Players and seating

- Default is **4 players**. 3 is supported; 5 is an option (§12).
- Seats are numbered `0..N-1`. Play goes **counter-clockwise**, mahjong-style: `next(s) = (s+1) % N` is the player to your **right** (下家).
- Screen layout: you sit at the bottom, 下家 on the right, 对家 at the top, 上家 on the left.
- Turn direction during play is a **[house rule choice]**: counter-clockwise, the same as the deal. No tile source states it; the deal is counter-clockwise in all of them.

---

## 3. Setup and deal (digital mapping)

1. **First dealer (庄家) for hand 1.** Every player rolls 2d6 and the highest total becomes dealer; ties re-roll among the tied players. This is flavour only.
2. **Shuffle** all 112 tiles with a cryptographically secure RNG on the server.
3. **Wall visual (flavour).** Show 4 walls of 14 two-tile stacks (栋), one in front of each seat.
   - The dealer rolls 2d6 = T.
   - Count seats counter-clockwise starting at the dealer as 1. The wall at count `((T−1) % 4) + 1` is broken, counting T stacks in from its right end.
   - The animation takes from that break point, but the tiles actually dealt come from the shuffled array in order.
4. **Deal.** Starting with the dealer's 下家 and going counter-clockwise, each player takes **4 tiles (2 stacks) per grab**. Do **5 rounds**, giving **20 tiles each**. The dealer takes last in each round. Grab size is a **[house rule choice]**: Everything Boleh uses 2-stack grabs, and every source agrees on 20 tiles.
5. **Leftovers.** The remaining tiles (32 with 4 players) become the **dead wall**. Lay them face down in the centre. They are **never used**, never revealed, and cannot run out.
6. **3 players.** 20 tiles each, leaving 52 in the dead wall. Draw only 3 walls. The 20-tile count for 3 players is a **[house rule choice]** to keep pacing the same; the option is 25 each, as in Penang.
7. **Hand sorting** is a free client-side action.

---

## 4. Hand structure

1. Deal (§3).
2. **Instant-win check** (§5).
3. **Port phase** (开牌 / PORT, §6).
4. **Play phase** (接龙, §7).
5. **Hand end and scoring** (§9).
6. **Payout** (§10).
7. **Next dealer** (§11).

---

## 5. Instant wins (checked right after the deal, before porting)

Each hand is checked in turn order, starting with the dealer's 下家. "Identical" means **same rank, any colour, natural tiles only**. Jokers do not count. That reading is a **[house rule choice]**: each rank has exactly 8 copies, so "8 identical" only works if it means rank.

| Priority | Condition | Name |
|---|---|---|
| 1 | Holds all 8 tiles of one rank | 天糊 (Heavenly) |
| 2 | Under default rules, the whole 20-tile hand splits exactly into valid **runs** (§8), Jokers allowed. If "Set allowed as port" is on, sets count too. | 天糊 |
| 3 | Holds 7 tiles of one rank | Game牌 (instant) |

- The engine detects these automatically and prompts the player to **declare**. Declaring is the default, and auto-declare runs on timeout. A player may decline.
- If the first player declares, the hand ends at once.
- If several players qualify, the higher priority wins. If priorities are equal, the player earlier in turn order from the dealer's 下家 wins.
- Everyone else scores their full 20-tile hand.

---

## 6. Port phase (开牌 / PORT)

**Simultaneous port.** Every player privately chooses a port within the turn timer (default 30 s), then all ports are revealed together. **[house rule choice]**: XUAN 2021 has everyone lay out together, and simultaneous reveal stops later players from benefiting from information.

**A legal port** is one or more **new runs** (§8) laid from your own hand.
- Each run is 3 or more consecutive tiles of one colour. Jokers are allowed.
- Each new meld needs at least 2 natural tiles.
- No point minimum applies.
- You may lay **several runs** in your port. **[house rule choice]**: Penang allows several melds, and the 天糊 rule implies it.
- Sets are **not** allowed at port (FB and both XUAN articles require a run). This can be toggled.
- No lay-offs onto other players' runs are allowed during port.

**全餐 (failed port).** If a player has no legal run, even using Jokers, the engine auto-applies 全餐: the player is **Dead** (盖牌) for the hand and keeps all 20 tiles for scoring. A player who *can* port **must** port; the minimum is one run.

**Hand emptied during port.** If a player's port empties their hand, that is 天糊 and it would have been caught in §5. The engine treats it as 天糊 anyway.

**Port timeout.** The engine auto-ports the run with the highest penalty total.

---

## 7. Play phase (接龙)

**First turn.** The dealer's 下家 plays first. If that player is Dead, the turn passes to the next alive player counter-clockwise. Turns then rotate counter-clockwise, skipping Dead players.

**Turn structure:**

1. **Optional free action: Joker swap** (换Joker), described below. It may be repeated any number of times.
2. **Exactly one primary action** (default), chosen from:
   - **a) 接牌 (extend).** Add 1 or more tiles from hand to **one** table run (anyone's), at **either or both ends**. The result must be a valid run (§8). Jokers may be used.
   - **b) 斩 (cut).** Lay a **new set** of 3 or more tiles of the same rank, in any colours, Jokers allowed, with at least 2 naturals. **Only allowed if you have no legal 接 move.** **[house rule choice]**: this follows the user's FB source and XUAN 2021 ("若没有牌接的话"). For this test, a 接 move that is only available after a Joker swap still counts as a legal 接 move.
   - **c) 跟斩 (follow a cut).** Add 1 or more tiles of a set's rank (or Jokers) to **any existing set** on the table. There is no precondition and it is done on your own turn. **[house rule choice]**: Lemon8 says followers play on their own turn, and that avoids interrupt timing.
   - **d) New run.** Lay a new run after porting. This is **off by default**. **[house rule choice]**: the tile sources only describe 接 and 斩 after the port, which keeps the 接龙 feel.
3. **End of turn.** If your hand is now empty, you score **Game牌** and the hand ends immediately. Otherwise play passes to the next alive player.

**Dead / 盖牌.** At the start of your turn, the engine checks whether any legal primary action exists, taking every possible Joker-swap sequence into account.
- If none exists, you are **automatically Dead**: hand face down, out for the rest of the hand, all tiles counted.
- There is **no passing** and no voluntary 盖牌 while you still have a legal move (FB rule 9 and Penang). Being Dead is permanent.
- Engine shortcut: if you hold the natural tile that a table Joker represents, and any run is not yet at both its ends' limits, you are not Dead, because the swapped Joker can extend that run.

**Joker swap (换Joker).**
- Allowed only on your own turn, during the play phase, after you have ported.
- Replace a table Joker with the **exact natural tile it represents**: in a run, the same colour and rank; in a set, the same rank in any colour.
- The Joker goes into your hand and you may **keep it**. **[house rule choice]**: this is the Penang rule.
- A swap does **not** count as your primary action.
- The table meld must stay valid, and the "at least 2 naturals" check only applies when a meld is created.

**Turn timer.** Default 20 s. On timeout, the server plays the legal primary action that removes the most penalty points (ties: lowest tile ID). If no action exists, the player becomes Dead.

**Disconnect.** A bot (the same auto-play logic) takes over until the player reconnects.

---

## 8. Meld definitions (validation)

```
TableMeld { id, type: RUN|SET, ownerSeat (for display only; melds are shared),
            colour (RUN only), rank (SET only),
            tiles: [{ tileId, rep: { colour, rank } }] }  // rep is fixed when placed
```

**RUN**
- Length 3 to 14.
- Every natural tile has the meld's colour.
- Represented ranks are strictly consecutive by +1.
- A is either low (value 1, below 2) or high (value 14, above K).
- **No wrap**: K-A-2 is illegal. The full run A-2-…-K-A (length 14) is legal.
- A run whose low end is A(1) cannot extend lower. A run whose high end is A(14) cannot extend higher.
- A Joker's represented colour and rank are fixed by its position. When the position is ambiguous (a Joker added at an end), the player chooses the end.

**SET (斩 group)**
- 3 or more tiles.
- Every natural tile has the meld's rank. Any colours, and duplicate colours are allowed (FB shows mixed colours; Penang allows duplicates).
- Jokers represent the rank.
- No size cap. The practical maximum is 8 naturals plus Jokers. **[house rule choice]**: Penang has no cap.

**Creation rule.** Any newly created run or set needs at least 2 natural tiles. **[house rule choice]**: this stops runs made almost entirely of Jokers and keeps the meld's identity clear.

**No rearranging.** Table melds cannot be split, merged, or rearranged; this is not Rummikub. The only change allowed to an existing meld is a Joker swap.

---

## 9. End of hand and scoring

**The hand ends when:**
- (a) a player empties their hand (Game牌) or an instant win is declared; or
- (b) every player is Dead (no one can 接 or 斩).

If a single player is still alive, they keep taking turns until they empty their hand or become Dead.

**Hand points.** The sum of penalty values (§1) of tiles left in hand.
- A player who empties their hand scores 0.
- A Joker left in hand counts 20.
- 全餐 players count all 20 tiles.

**Ranking.**
1. A Game牌 or 天糊 player always ranks 1st.
2. Everyone else ranks by hand points, lowest first.
3. Tie-breaks, in order:
   1. fewer tiles in hand;
   2. the player who became Dead **later** ranks higher, and an alive player beats a Dead one;
   3. turn-order distance from the dealer's 下家, nearer ranks higher.

There are no shared ranks. **[house rule choice]**: payouts need a deterministic order.

**Rank names:**

| Rank | 4 players | 3 players |
|---|---|---|
| 1st | 赢家 Winner | 赢家 Winner |
| 2nd | 小哥 | 二哥 |
| 3rd | 二哥 | 大哥 |
| 4th | 大哥 | — |

In both cases the highest score is 大哥.

---

## 10. Match, chips and payouts

**Starting chips.** 1000 per player. Base unit `u` = 10 chips; both are configurable.

**Normal end (lowest points wins).** Each loser pays the winner by rank. **[house rule choice]**: Lemon8's $3/$6/$9 ladder is the only payout scheme any source reports.

| Payer | 4 players | 3 players |
|---|---|---|
| 2nd | 3u | 3u |
| 3rd | 6u | 6u |
| 4th | 9u | — |

**Game牌** (emptied hand, or 7 identical): **each** other player pays **24u** flat. This replaces the rank ladder (Lemon8).

**天糊:** each other player pays **48u**. **[house rule choice]**: double Game牌, since it is the rarer special.

**Bankruptcy.** Payments are capped at the payer's remaining chips. When a player reaches 0 chips, the match ends after that hand.

**Match length.** Default is **8 hands** with 4 players (two full dealer rotations), or 6 hands with 3. Final standings are by chips. Ties are broken by lower cumulative hand points, then fewer 大哥 finishes.

**Cumulative points** are always tracked and shown on the table so a "Penang scoring" view (lowest cumulative total wins) is available.

---

## 11. Dealer rotation

The dealer passes to the **下家 every hand**. **[house rule choice]**: this gives equal dealing in a fixed-length match. The Penang alternative, where the winner deals next, is a toggle.

The dealer has no scoring privilege; dealer is only a turn-order anchor.

---

## 12. Rule options (toggles; defaults in bold)

| Option | Values |
|---|---|
| Players | 3 / **4** / 5 (20 each, 12 left in the dead wall) |
| 3P deal size | **20** / 25 |
| Jokers | 6 / **8** / 12 (12 means a 116-tile set) |
| Joker penalty | **20** / 20 plus each Joker in hand doubles the hand total (Rummy Pop) / 30 |
| Set allowed as port | **off** / on (Viralcham, Penang) / first meld must be 4-of-a-kind (Lemon8 SG) |
| Port timing | **simultaneous** / sequential, on each player's own first turn (Penang) |
| 斩 precondition | **only when you cannot 接** / any time (XUAN 2026) |
| 跟斩 timing | **own turn** / out of turn, immediately after the cut (碰-style interrupt) |
| New runs after port | **off** / on |
| Actions per turn | **exactly 1** / unlimited, at least 1 (Penang) |
| Joker swap | off / **keep** / must use the retrieved Joker in the same turn (m3p) |
| Natural tiles required in a new meld | 1 / **2** |
| Set cap | **none** / 4 tiles, distinct colours |
| Set-priority rule | **off** / on (if a set of rank X exists, X cannot be added to runs; m3p) |
| Ace high (Q-K-A) | **on** / off (A low only) |
| Instant wins (7/8 identical, 天糊) | **on** / off |
| Dealer rotation | **rotate to 下家** / winner deals |
| Ace/Joker bonus | **off** / on (each other player pays 0.1u per Ace or Joker you play to the table; Lemon8 "$1") |
| All players 全餐 | **score normally** / redeal |
| Payout ladder | **3/6/9u, Game 24u, 天糊 48u**, editable |

**Preset "Penang Classic":** set allowed as port, sequential port, 斩 any time, new runs on, unlimited actions, swap keep, winner deals.

---

## 13. Edge cases

- **Wall exhausted.** This cannot happen: the dead wall is never drawn from.
- **Joker left in hand.** Counts 20, including for 全餐 and Dead players.
- **Table Jokers at hand end.** No score effect.
- **Everyone 全餐.** Score normally (default) and the lowest hand wins.
- **Only one player ports.** That player plays alone until they score Game牌 or become Dead.
- **Game牌 player went Dead earlier.** Impossible, since Dead is permanent.
- **Tile emptied by 跟斩 or 斩.** Counts as Game牌, the same as 接.
- **Two or more instant wins.** Resolved by priority, then turn order (§5).
- **Ties in rank.** Resolved by the §9 tie-breaks; never shared.
- **Ambiguous Joker position.** The player must pick the end; the client prompts for it.
- **Swapping a Joker out of a run** never changes the run's length or represented ranks.
- **Cannot 接 only because of the 斩 restriction.** 斩 becomes available. 跟斩 is always available whenever any set of a matching rank exists on the table.
- **Pending 斩 check.** If a 接 move exists **only after** a Joker swap, 斩 is **not** allowed.

---

## 14. Glossary (UI strings)

| 中文 | English (UI) | Meaning |
|---|---|---|
| 拉米 / Rummy / LAMI | Lami Rummy | The game |
| 庄家 | Dealer | Turn-order anchor for the hand |
| 下家 / 上家 / 对家 | Next (right) / Previous (left) / Opposite | Seat relations |
| 栋 / 对 | Stack | 2 tiles stacked |
| 牌墙 / 长城 | Wall | The tile wall |
| 骰子 | Dice | 2d6, flavour |
| 开牌 / PORT | Port (open) | Mandatory first meld: a same-colour run of 3+ |
| 顺子 / 顺序牌 | Run | 3+ consecutive tiles, same colour |
| 接牌 / 接龙 | Extend | Add tiles to either end of a table run |
| 斩 / 斩牌 | Cut | Lay 3+ tiles of the same rank (a set) |
| 跟斩 | Follow cut | Add same-rank tiles to a cut set |
| Joker / 鬼牌 / 万能牌 | Joker (wild) | Stands for any tile |
| 换Joker | Swap Joker | Replace a table Joker with its natural tile and take the Joker |
| 盖牌 | Fold / Dead | No legal move; out for the hand |
| 全餐 | Full Meal (failed port) | Could not port; whole hand counts |
| Game牌 | Game! | Emptied the hand (or 7 identical at the deal) |
| 天糊 | Heavenly Win | 8 identical, or the whole hand fits into runs at the deal |
| 赢家 | Winner | Rank 1 |
| 小哥 / 二哥 / 大哥 | 2nd / 3rd / Last | Ranks by points; 大哥 is the highest score |
| 点数 | Points | Penalty points left in hand |
| 筹码 | Chips | Match currency |

---

## 15. Engine implementation notes

- **Legal-move generator per turn:** list swaps, then the primary actions available after each swap. Dead means that set is empty. To keep it bounded, consider at most one swap before testing for a 接, which is sufficient to show the player is not Dead.
- **Run validation:** sort by represented value; check colour, contiguity, the A=1 or A=14 rule (no wrap), and length 3 to 14.
- **天糊 partition check:** a backtracking exact cover over 20 tiles into runs (plus sets if that option is on), with Jokers as wildcards. Keep the search bounded by trying each colour's runs greedily, with memoisation.
- **Server-authoritative state.** Clients see their own hand, the table melds, opponents' tile counts, and Dead or 全餐 status. The dead wall stays hidden.
---

## 16. Engine clarifications

Decisions the sources do not cover, fixed by the engine (all **[house rule choice]**):

- **Swap guard.** A Joker swap is refused if, after it, you would have no legal primary action left (接, 斩, 跟斩, possibly after a further swap). So a swap can never make you Dead. Once you have already acted this turn (`unlimitedActions`) the guard no longer applies, unless the swapped Joker must be used the same turn (`jokerSwap: useSameTurn`).
- **Several hands emptied at the port reveal.** With simultaneous porting, if two or more players empty their hand when the ports are revealed, only the **first of them in turn order** (starting from the dealer's 下家) wins with Game牌; the others are simply out of the hand.
- **Set priority covers Jokers.** With `setPriority` on, once a set of rank X is on the table no tile may be added to a run at a position representing X. This includes a Joker placed to represent X.
- **Port timeout.** When the port timer runs out, the engine ports for you by choosing among the candidates its move generator lists (a single run, or a set if sets may be ported): the one with the highest penalty total, ties broken by lowest tile ids. If there is no candidate, you take 全餐.
