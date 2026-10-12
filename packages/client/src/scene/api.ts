/**
 * Contract between the DOM UI layer (src/ui, src/main.ts) and the 3D layer
 * (src/scene, src/avatars, src/art). The UI never touches three.js directly.
 */
import type { GameEvent, PlayerView } from '@open-rummy/shared';

export type Quality = 'low' | 'medium' | 'high';

/** Avatar reactions the UI/event mapper can trigger. */
export type Reaction =
  | 'idle'
  | 'think'
  | 'play' // reaching to place tiles
  | 'happy'
  | 'surprised'
  | 'sad'
  | 'angry'
  | 'win' // big celebration (Game牌 / 天糊)
  | 'lose'
  | 'wave'
  | 'laugh'
  | 'cheer'
  | 'cry';

export interface AvatarDef {
  id: string;
  /** url under /avatars/ */
  url: string;
  nameZh: string;
  nameEn: string;
  /** short personality line shown in lobby */
  taglineZh: string;
  taglineEn: string;
  /** credit line required by license (empty if none) */
  credit: string;
  /** UI accent colour */
  color: string;
}

export interface SeatAvatar {
  seat: number;
  avatarId: string;
  name: string;
}

export interface MeldPick {
  meldId: string;
  /** which end of a RUN was clicked (nearest end), null for SETs */
  end: 'low' | 'high' | null;
}

export interface TableSceneApi {
  /** create renderer inside container, start render loop */
  mount(container: HTMLElement, opts: { quality: Quality; onProgress?: (p: number) => void }): Promise<void>;
  /** seat avatars around the table; `you` is the local seat (camera seat, own avatar not shown seated) */
  setSeats(seats: SeatAvatar[], you: number): Promise<void>;
  /**
   * Animate a batch of events (deal, melds created/extended, swaps, dead, game, hand end ...)
   * and resolve when animations are done. `view` is the state AFTER the events.
   */
  playEvents(events: GameEvent[], view: PlayerView): Promise<void>;
  /** snap the table to `view` without animation (reconnect, resize, after playEvents) */
  sync(view: PlayerView): void;
  /** highlight table melds that are valid targets for the current selection */
  highlightMelds(meldIds: string[]): void;
  /** called when the user clicks a meld on the table */
  onMeldPick(cb: (pick: MeldPick) => void): void;
  /** trigger an avatar reaction + expression (seat may be `you`: shows in the corner portrait) */
  react(seat: number, reaction: Reaction): void;
  /** active-turn focus: avatars look at this seat, turn ring glows */
  setActiveSeat(seat: number | null): void;
  setQuality(q: Quality): void;
  dispose(): void;
}
