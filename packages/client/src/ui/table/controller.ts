/**
 * Table screen controller: owns the DOM overlay above the 3D table and wires
 * Transport -> (queued) scene animations -> UI, and UI intents -> Transport.
 *
 * Updates are queued so animations never overlap. If the queue falls far behind
 * (slow device, tab in background) we fast-forward by syncing to the latest view.
 */
import { isJokerId, type Action, type EmoteId, type GameEvent, type Meld, type PlayerView, type PublicPlayer } from '@open-rummy/shared';
import type { Transport } from '../../net/transport';
import type { MeldPick, TableSceneApi } from '../../scene/api';
import { h, icon, ICONS } from '../dom';
import { banner, clearBanners, toast } from '../toast';
import { choose, openModal, type Choice, type ModalHandle } from '../modal';
import { sound } from '../sound';
import { miniTile, tileStrip } from '../tileView';
import {
  hintsFrom,
  jokerRep,
  legalExtendFor,
  meldLabel,
  needsSwapFirst,
  planExtend,
  planFollow,
  planRun,
  planSet,
  playableTiles,
  points,
  repLabel,
  suggestPorts,
  targetMelds,
  type ExtendPlan,
  type Hint,
} from '../moves';
import { SeatBadges, type SeatTimer } from './seats';
import { HandTray } from './handTray';
import { EMOTE_REACTION, EmoteWheel, emoteText } from './emotes';
import { showHandResult, showMatchEnd } from './results';
import { getPrefs } from '../prefs';
import { decisionKey } from './decision';
import { t, tDyn } from '../../i18n';

export interface GameControllerOptions {
  /** overlay container (the UI layer) */
  root: HTMLElement;
  transport: Transport;
  /** resolves when the table scene is mounted (3D or DOM fallback) */
  scene: Promise<TableSceneApi>;
  onExit(): void;
  onAgain(): void;
  againLabel?: string;
  /**
   * Whether this player may start a rematch now (online: only the room host). When it
   * returns false the match-end modal shows `againWaiting` instead of the button.
   */
  canAgain?: () => boolean;
  againWaiting?: string;
  /** the rematch completes asynchronously (online restart_room): keep the modal open meanwhile */
  againPending?: boolean;
  onOpenSettings(): void;
  onOpenRules(): void;
  /** extra HUD element (e.g. online connection indicator) */
  hudExtra?: HTMLElement;
}

interface QueueItem {
  view: PlayerView;
  events: GameEvent[];
}

/** Queue length beyond which we skip animations and snap to the newest view. */
const FAST_FORWARD_AFTER = 4;
/** Safety net: never let a stuck animation block the queue forever. */
const ANIMATION_TIMEOUT_MS = 12000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | void> {
  return Promise.race([p, new Promise<void>((r) => setTimeout(r, ms))]);
}

export class GameController {
  private readonly el: HTMLElement;
  private scene: TableSceneApi | null = null;
  private view: PlayerView | null = null;
  private queue: QueueItem[] = [];
  private pumping = false;
  private disposed = false;
  private seatsKey = '';

  private seats: SeatBadges;
  private tray: HandTray;
  private bar: HTMLElement;
  private info: HTMLElement;
  private emotes: EmoteWheel;
  private countdownEl: HTMLElement | null = null;
  /** icon buttons whose tooltip / aria-label must follow the language */
  private iconButtons: { el: HTMLElement; key: 'menu.rules' | 'menu.settings' | 'table.leave' }[] = [];

  // interaction state
  private selected = new Set<string>();
  private staged: string[][] = [];
  private hinted = new Set<string>();
  private hintMeld: string | null = null;
  private hintIdx = 0;
  /** hint cycling is per decision: reset when the turn/hand changes */
  private hintKey = '';
  /** port auto-suggest cycling */
  private portSuggestIdx = 0;
  private portSuggestKey = '';
  private busy = false;
  private busyTimer: ReturnType<typeof setTimeout> | null = null;

  // timers (local clock)
  private timers = new Map<number, SeatTimer>();
  /** seats that must decide now (highlighted even when countdowns are hidden) */
  private waiting = new Set<number>();
  private deadlineKey = '';
  private localEnd = 0;
  private lastTickSecond = -1;
  private tickHandle: ReturnType<typeof setInterval>;

  // modals
  private resultModal: ModalHandle | null = null;
  private resultFinal = false;
  private shownResult = -1;
  private matchModal: ModalHandle | null = null;
  /** the open match-end modal offers a rematch button */
  private matchAgain = false;
  /** open choice picker (joker placement, swap, run order) and the decision it belongs to */
  private choiceAbort: AbortController | null = null;
  private choiceKey = '';

  constructor(private readonly opts: GameControllerOptions) {
    const seatLayer = h('div', { class: 'seat-layer' });
    const youSlot = h('div', { class: 'you-slot' });
    this.seats = new SeatBadges(seatLayer, youSlot);
    this.tray = new HandTray((id) => this.toggleTile(id));
    this.bar = h('div', { class: 'action-bar', 'aria-live': 'polite' });
    this.info = h('div', { class: 'table-info' });
    this.emotes = new EmoteWheel((id) => this.opts.transport.emote(id));
    const iconBtn = (key: 'menu.rules' | 'menu.settings' | 'table.leave', glyph: string, onclick: () => void): HTMLElement => {
      const el = h('button', { class: 'icon-btn', 'aria-label': t(key), title: t(key), onclick }, icon(glyph));
      this.iconButtons.push({ el, key });
      return el;
    };

    this.el = h('div', { class: 'table-ui' },
      seatLayer,
      h('div', { class: 'hud-top' },
        this.info,
        h('div', { class: 'hud-buttons' },
          opts.hudExtra ?? null,
          iconBtn('menu.rules', ICONS.book, () => opts.onOpenRules()),
          iconBtn('menu.settings', ICONS.settings, () => opts.onOpenSettings()),
          iconBtn('table.leave', ICONS.exit, () => this.confirmLeave()),
        ),
      ),
      h('div', { class: 'bottom-dock' },
        h('div', { class: 'dock-row' }, youSlot, this.bar, this.emotes.el),
        this.tray.el,
      ),
    );
    opts.root.appendChild(this.el);
    this.renderAll();

    this.tickHandle = setInterval(() => this.tick(), 250);

    opts.scene
      .then((scene) => {
        if (this.disposed) return;
        this.scene = scene;
        scene.onMeldPick((p) => void this.onMeldPick(p));
        void this.pump();
      })
      .catch((err) => {
        console.error('[table] scene failed', err);
      });
  }

  // ---------------------------------------------------------------------------
  // inbound
  // ---------------------------------------------------------------------------

  push(view: PlayerView, events: GameEvent[]): void {
    if (this.disposed) return;
    this.queue.push({ view, events });
    void this.pump();
  }

  error(message: string): void {
    this.setBusy(false);
    sound.error();
    toast(message, 'error', 3600);
    this.refresh();
  }

  showEmote(seat: number, id: string): void {
    this.seats.bubble(seat, emoteText(id), 'emote');
    const reaction = EMOTE_REACTION[id as EmoteId];
    if (reaction) this.scene?.react(seat, reaction);
    sound.pop();
  }

  private async pump(): Promise<void> {
    if (this.pumping || !this.scene) return;
    this.pumping = true;
    const scene = this.scene;
    try {
      while (this.queue.length && !this.disposed) {
        let item: QueueItem;
        let fast = false;
        if (this.queue.length > FAST_FORWARD_AFTER) {
          const all = this.queue.splice(0);
          item = { view: all[all.length - 1].view, events: [] };
          fast = true;
        } else {
          item = this.queue.shift()!;
        }
        const first = !this.view;
        await this.ensureSeats(scene, item.view);
        if (first) scene.sync(item.view);
        if (!fast) this.announce(item.events, item.view);
        if (!fast && item.events.length) {
          try {
            await withTimeout(scene.playEvents(item.events, item.view), ANIMATION_TIMEOUT_MS);
          } catch (err) {
            console.warn('[table] playEvents failed', err);
          }
        }
        if (this.disposed) break;
        scene.sync(item.view);
        this.apply(item.view);
      }
    } finally {
      this.pumping = false;
    }
  }

  private async ensureSeats(scene: TableSceneApi, view: PlayerView): Promise<void> {
    const key = `${view.you}|${view.players.map((p) => `${p.seat}:${p.avatar}:${p.name}`).join('|')}`;
    if (key === this.seatsKey) return;
    this.seatsKey = key;
    try {
      await withTimeout(
        scene.setSeats(view.players.map((p) => ({ seat: p.seat, avatarId: p.avatar, name: p.name })), Math.max(0, view.you)),
        20000,
      );
    } catch (err) {
      console.warn('[table] setSeats failed', err);
    }
  }

  /** Call-outs, banners and sounds for a batch of events (runs before the animation). */
  private announce(events: GameEvent[], view: PlayerView): void {
    const name = (seat: number): string => view.players.find((p) => p.seat === seat)?.name ?? `#${seat + 1}`;
    const me = view.you;
    let dealt = false;
    for (const ev of events) {
      switch (ev.type) {
        case 'HAND_START':
          // the previous hand's result must not sit over the next hand's banner
          if (this.resultModal) {
            this.resultModal.close();
            this.resultModal = null;
          }
          this.resetHandState();
          banner(t('banner.handStart', { n: ev.handNo }), t('banner.dealerIs', { name: name(ev.dealer) }), 'teal');
          break;
        case 'DEAL':
          if (!dealt) sound.deal();
          dealt = true;
          break;
        case 'INSTANT_WIN':
          banner(ev.kind === 'GAME_7' ? t('kind.GAME_7') : t('kind.TIANHU'), name(ev.seat), 'gold', 2200);
          if (ev.seat === me) sound.win();
          else sound.chime();
          break;
        case 'PORT_REVEAL':
          banner(t('banner.portReveal'), undefined, 'teal', 1200);
          sound.tile();
          break;
        case 'QUANCAN':
          this.seats.bubble(ev.seat, t('status.QUANCAN'), 'call');
          if (ev.seat === me) {
            toast(t('toast.youQuancan'), 'error', 4000);
            sound.sad();
          }
          break;
        case 'MELD_CREATED':
          if (ev.via === 'CUT') this.seats.bubble(ev.seat, t('call.cut'));
          else if (ev.via === 'NEW_RUN') this.seats.bubble(ev.seat, t('call.newRun'));
          sound.tile();
          break;
        case 'MELD_EXTENDED':
          this.seats.bubble(ev.seat, t('call.extend'), 'call', 1200);
          sound.tile();
          break;
        case 'SET_FOLLOWED':
          this.seats.bubble(ev.seat, t('call.follow'));
          sound.tile();
          break;
        case 'JOKER_SWAPPED':
          this.seats.bubble(ev.seat, t('call.swap'));
          sound.chime();
          break;
        case 'TIMEOUT':
          if (ev.seat === me) toast(t('toast.timeout'), 'info', 3200);
          break;
        case 'PLAYER_DEAD':
          this.seats.bubble(ev.seat, t('status.DEAD'), 'call');
          if (ev.seat === me) {
            toast(t('toast.youDead'), 'error', 4000);
            sound.sad();
          }
          break;
        case 'GAME_PAI':
          banner(t('kind.GAME'), name(ev.seat), 'gold', 2000);
          if (ev.seat === me) sound.win();
          else sound.chime();
          break;
        default:
          break;
      }
    }
  }

  private resetHandState(): void {
    this.selected.clear();
    this.staged = [];
    this.clearHint();
    this.setBusy(false);
  }

  /** Apply a view after its animations: update every overlay part. */
  private apply(view: PlayerView): void {
    const prev = this.view;
    this.view = view;
    this.setBusy(false);
    if (prev && prev.handNo !== view.handNo) this.resetHandState();
    // a picker opened for an earlier decision (turn ended, timeout, hand end) is stale
    if (this.choiceAbort && decisionKey(view) !== this.choiceKey) this.closeChoice();

    // drop selections of tiles that left the hand
    const inHand = new Set(view.hand);
    for (const id of this.selected) if (!inHand.has(id)) this.selected.delete(id);
    for (const id of this.hinted) if (!inHand.has(id)) this.clearHint();
    if (view.pendingPort) this.staged = view.pendingPort.map((m) => [...m]);
    else if (!this.needsPort(view)) this.staged = [];
    else this.staged = this.staged.filter((m) => m.every((id) => inHand.has(id)));

    this.computeTimers(view);

    // turn / phase cues
    const myTurn = view.phase === 'PLAY' && view.turn === view.you && !!view.legal;
    const wasMyTurn = !!prev && prev.phase === 'PLAY' && prev.turn === prev.you && !!prev.legal;
    if (myTurn && !wasMyTurn) {
      sound.turn();
      banner(t('banner.yourTurn'), undefined, 'teal', 1000);
      if (view.cfg.jokerSwap !== 'off' && needsSwapFirst(view.legal) && !this.needsPort(view)) toast(t('play.swapFirst'), 'info', 4200);
    }
    if (view.phase === 'PORT' && prev?.phase !== 'PORT' && this.needsPort(view)) {
      banner(t('banner.port'), t('port.help'), 'gold', 1600);
    }
    if (prev && prev.phase === 'PORT' && view.phase === 'PLAY') {
      banner(t('banner.play'), undefined, 'teal', 1100);
    }
    this.scene?.setActiveSeat(view.phase === 'PLAY' ? view.turn : null);

    this.renderAll();
    this.handleResults(view);
  }

  // ---------------------------------------------------------------------------
  // derived state
  // ---------------------------------------------------------------------------

  private me(view: PlayerView): PublicPlayer | undefined {
    return view.players.find((p) => p.seat === view.you);
  }

  /** The local player still has to submit a port now. */
  private needsPort(view: PlayerView): boolean {
    const me = this.me(view);
    if (!me || !view.legal || me.ported || view.pendingPort || me.portSubmitted) return false;
    if (view.phase === 'PORT') return true;
    return view.phase === 'PLAY' && view.cfg.portTiming === 'sequential' && view.turn === view.you;
  }

  /** It is the local player's PLAY turn (after porting). */
  private myPlayTurn(view: PlayerView): boolean {
    return view.phase === 'PLAY' && view.turn === view.you && !!view.legal && !this.needsPort(view);
  }

  private computeTimers(view: PlayerView): void {
    this.timers.clear();
    this.waiting.clear();
    if (view.phase === 'PLAY' && view.turn !== null) this.waiting.add(view.turn);
    else if (view.phase === 'PORT') {
      for (const p of view.players) if (p.status === 'ALIVE' && !p.ported && !p.portSubmitted) this.waiting.add(p.seat);
    } else if (view.phase === 'INSTANT' && view.instantOffer && view.legal) this.waiting.add(view.you);

    // Relaxed mode: the host never enforces deadlines, so no countdown anywhere.
    if (!view.deadline || this.opts.transport.timersEnabled === false) {
      this.deadlineKey = '';
      return;
    }
    const total =
      view.phase === 'PORT' ? view.cfg.portTimerMs : view.phase === 'INSTANT' ? view.cfg.instantTimerMs : view.cfg.turnTimerMs;
    const key = `${view.phase}:${view.turn}:${view.deadline}`;
    if (key !== this.deadlineKey) {
      this.deadlineKey = key;
      // Deadlines arrive in the local clock (the online transport corrects server skew).
      this.localEnd = Date.now() + Math.max(0, Math.min(total, view.deadline - Date.now()));
    }
    const tm: SeatTimer = { end: this.localEnd, total };
    for (const seat of this.waiting) this.timers.set(seat, tm);
  }

  private tick(): void {
    const now = Date.now();
    this.seats.tick(now, this.timers);
    const mine = this.view ? this.timers.get(this.view.you) : undefined;
    if (this.countdownEl) {
      if (mine) {
        const sec = Math.max(0, Math.ceil((mine.end - now) / 1000));
        this.countdownEl.textContent = t('bar.seconds', { n: sec });
        this.countdownEl.classList.toggle('urgent', sec <= 5);
        if (sec <= 5 && sec > 0 && sec !== this.lastTickSecond) sound.tick();
        this.lastTickSecond = sec;
      } else this.countdownEl.textContent = '';
    }
  }

  // ---------------------------------------------------------------------------
  // rendering
  // ---------------------------------------------------------------------------

  private renderAll(): void {
    this.renderInfo();
    this.refresh();
    if (this.view) {
      this.seats.update(this.view, new Set(this.waiting));
    }
  }

  /** Re-render the parts that depend on selection (tray, bar, highlights). */
  private refresh(): void {
    this.renderTray();
    this.renderBar();
    this.updateHighlights();
  }

  private renderInfo(): void {
    const v = this.view;
    if (!v) {
      this.info.replaceChildren(h('span', { class: 'info-phase' }, t('table.connecting')));
      return;
    }
    const dealer = v.players.find((p) => p.seat === v.dealer);
    const total = v.cfg.handsPerMatch > 0 ? String(v.cfg.handsPerMatch) : '-';
    this.info.replaceChildren(
      h('span', { class: 'info-hand' }, t('info.hand', { n: Math.max(1, v.handNo), total })),
      dealer ? h('span', { class: 'info-dealer' }, h('b', null, t('seat.dealerShort')), dealer.name) : '',
      h('span', { class: `info-phase phase-${v.phase.toLowerCase()}` }, tDyn(`phase.${v.phase}`, undefined, v.phase)),
    );
  }

  private renderTray(): void {
    const v = this.view;
    if (!v || v.you < 0) {
      this.tray.el.hidden = true;
      return;
    }
    this.tray.el.hidden = false;
    const needsPort = this.needsPort(v);
    const myTurn = this.myPlayTurn(v);
    const stagedSet = new Set(this.staged.flat());
    const playable = needsPort || myTurn ? playableTiles(v, needsPort) : new Set<string>();
    this.tray.render({
      hand: v.hand,
      selected: this.selected,
      playable,
      staged: stagedSet,
      hinted: this.hinted,
      points: points(v.hand, v.cfg),
      disabled: this.busy || v.phase === 'HAND_END' || v.phase === 'MATCH_END',
    });
  }

  private updateHighlights(): void {
    const v = this.view;
    if (!this.scene || !v) return;
    if (!this.myPlayTurn(v)) {
      this.scene.highlightMelds([]);
      return;
    }
    const ids = targetMelds(v, [...this.selected]).map((m) => m.id);
    if (this.hintMeld && !ids.includes(this.hintMeld)) ids.push(this.hintMeld);
    this.scene.highlightMelds(ids);
  }

  private renderBar(): void {
    const v = this.view;
    this.countdownEl = h('span', { class: 'bar-countdown', 'aria-hidden': 'true' });
    const status = (text: string, sub?: string): HTMLElement =>
      h('div', { class: 'bar-status' }, h('span', { class: 'bar-title' }, text), sub ? h('span', { class: 'bar-sub' }, sub) : null, this.countdownEl);
    this.bar.className = 'action-bar';
    if (!v) {
      this.bar.replaceChildren(status(t('table.connecting')));
      return;
    }
    const me = this.me(v);
    if (v.you < 0 || !me) {
      this.bar.replaceChildren(status(t('bar.spectating')));
      return;
    }

    if (v.phase === 'INSTANT') {
      if (v.instantOffer && v.legal) {
        this.bar.classList.add('my-turn');
        this.bar.replaceChildren(
          status(t('instant.prompt', { kind: tDyn(`instant.${v.instantOffer.kind}`, undefined, v.instantOffer.kind) })),
          h('div', { class: 'bar-content' }, v.instantOffer.tiles.map((g) => tileStrip(g))),
          this.buttons([
            { label: t('instant.decline'), kind: 'ghost', onClick: () => this.act({ type: 'DECLARE_INSTANT', declare: false }) },
            { label: t('instant.declare'), kind: 'gold', onClick: () => this.act({ type: 'DECLARE_INSTANT', declare: true }) },
          ]),
        );
      } else this.bar.replaceChildren(status(t('instant.waiting')));
      return;
    }

    if (this.needsPort(v)) {
      this.renderPortBar(v, status);
      return;
    }

    if (v.phase === 'PORT') {
      const content = this.staged.length
        ? h('div', { class: 'bar-content staged-list' }, this.staged.map((m) => tileStrip(m, 'staged-run')))
        : null;
      const text = me.status === 'QUANCAN' ? t('port.quancan') : t('port.waiting');
      this.bar.replaceChildren(status(text), content ?? '');
      return;
    }

    if (v.phase === 'PLAY') {
      if (me.status !== 'ALIVE') {
        this.bar.replaceChildren(status(t('play.youAreOut', { status: t(`status.${me.status}`) }), this.waitingText(v)));
        return;
      }
      if (this.myPlayTurn(v)) {
        this.renderPlayBar(v, status);
        return;
      }
      this.bar.replaceChildren(status(this.waitingText(v), this.selected.size ? t('play.preselectHelp') : undefined));
      return;
    }

    if (v.phase === 'HAND_END' || v.phase === 'MATCH_END') {
      this.bar.replaceChildren(status(t('bar.handOver')));
      return;
    }
    this.bar.replaceChildren(status(t('table.waitingStart')));
  }

  private waitingText(v: PlayerView): string {
    const p = v.players.find((x) => x.seat === v.turn);
    return p ? t('play.waitingFor', { name: p.name }) : t('table.waiting');
  }

  private buttons(defs: { label: string; kind?: string; onClick: () => void; disabled?: boolean; title?: string; cls?: string }[]): HTMLElement {
    return h('div', { class: 'bar-buttons' },
      defs.map((d) =>
        h('button', {
          class: `btn btn-${d.kind ?? 'teal'} ${d.cls ?? ''}`,
          disabled: d.disabled || this.busy,
          title: d.title,
          onclick: () => {
            sound.click();
            d.onClick();
          },
        }, d.label),
      ),
    );
  }

  private renderPortBar(v: PlayerView, status: (text: string, sub?: string) => HTMLElement): void {
    const legal = v.legal!;
    this.bar.classList.add('my-turn');
    if (!legal.canPort) {
      this.bar.replaceChildren(status(t('port.cannot'), t('port.cannotSub')));
      return;
    }
    const sel = [...this.selected];
    const stagedList = h('div', { class: 'bar-content staged-list' },
      this.staged.length
        ? this.staged.map((m, i) =>
            h('span', { class: 'staged-item' },
              tileStrip(m, 'staged-run'),
              h('button', {
                class: 'icon-btn tiny',
                'aria-label': t('port.removeRun'),
                onclick: () => {
                  this.staged.splice(i, 1);
                  sound.deselect();
                  this.refresh();
                },
              }, icon(ICONS.close)),
            ),
          )
        : h('span', { class: 'muted' }, v.cfg.setAllowedAsPort ? t('port.helpSet') : t('port.help')),
    );
    const canConfirm = this.staged.length > 0 || (sel.length >= 3 && (planRun(sel, v.cfg).length > 0 || (v.cfg.setAllowedAsPort && !!planSet(sel, v.cfg))));
    this.bar.replaceChildren(
      status(t('port.title'), this.staged.length ? t('port.stagedCount', { n: this.staged.length }) : undefined),
      stagedList,
      this.buttons([
        { label: t('port.auto'), kind: 'ghost', onClick: () => this.autoPort(), disabled: !legal.portCandidates.length, cls: 'btn-hint', title: t('port.autoTitle') },
        { label: t('port.addRun'), kind: 'teal', onClick: () => void this.addPortRun(), disabled: sel.length < 3 },
        { label: t('common.clear'), kind: 'ghost', onClick: () => this.clearSelection(true), disabled: !sel.length && !this.staged.length },
        { label: t('port.confirm'), kind: 'gold', onClick: () => void this.confirmPort(), disabled: !canConfirm },
      ]),
    );
  }

  private renderPlayBar(v: PlayerView, status: (text: string, sub?: string) => HTMLElement): void {
    const legal = v.legal!;
    this.bar.classList.add('my-turn');
    if (legal.dead) {
      this.bar.replaceChildren(status(t('play.noMoves')));
      return;
    }
    const sel = [...this.selected];
    const targets = targetMelds(v, sel);
    const setOk = sel.length >= 3 && !!planSet(sel, v.cfg);
    const runOk = v.cfg.newRunsAfterPort && sel.length >= 3 && planRun(sel, v.cfg).length > 0;
    const swapFirst = v.cfg.jokerSwap !== 'off' && needsSwapFirst(legal);
    const help = swapFirst
      ? t('play.swapFirst')
      : sel.length === 0
        ? t('play.help')
        : targets.length
          ? t('play.pickTarget')
          : setOk
            ? t('play.canCut')
            : t('play.noTarget');
    if (swapFirst) this.bar.classList.add('swap-first');

    const targetChips = targets.length
      ? h('div', { class: 'bar-content targets' },
          h('span', { class: 'muted' }, t('play.targets')),
          targets.map((m) =>
            h('button', {
              class: 'target-chip',
              onclick: () => {
                sound.click();
                void this.playOnMeld(m, null);
              },
            }, meldLabel(m)),
          ),
        )
      : null;

    const defs: { label: string; kind?: string; onClick: () => void; disabled?: boolean; title?: string; cls?: string }[] = [
      { label: t('play.hint'), kind: 'ghost', onClick: () => this.showHint(), cls: 'btn-hint' },
    ];
    defs.push({
      label: t('play.cut'),
      kind: 'teal',
      onClick: () => this.doCut(),
      disabled: !setOk || legal.cutBlocked,
      title: legal.cutBlocked ? t('play.cutBlocked') : undefined,
    });
    if (v.cfg.newRunsAfterPort) {
      defs.push({ label: t('play.newRun'), kind: 'teal', onClick: () => void this.doNewRun(), disabled: !runOk });
    }
    if (legal.swaps.length && v.cfg.jokerSwap !== 'off') {
      defs.push({
        label: t('play.swap', { n: legal.swaps.length }),
        kind: swapFirst ? 'gold' : 'teal',
        cls: swapFirst ? 'btn-swap-first' : '',
        title: swapFirst ? t('play.swapFirst') : undefined,
        onClick: () => void this.doSwap(null),
      });
    }
    if (legal.canEndTurn) defs.push({ label: t('play.endTurn'), kind: 'gold', onClick: () => this.act({ type: 'END_TURN' }) });
    if (sel.length) defs.push({ label: t('common.clear'), kind: 'ghost', onClick: () => this.clearSelection(false) });

    this.bar.replaceChildren(status(t('play.yourTurn'), help), targetChips ?? '', this.buttons(defs));
  }

  // ---------------------------------------------------------------------------
  // intents
  // ---------------------------------------------------------------------------

  private setBusy(b: boolean): void {
    this.busy = b;
    if (this.busyTimer) clearTimeout(this.busyTimer);
    this.busyTimer = null;
    if (b) {
      // If no reply arrives (lost message), unlock the UI again - but never while
      // updates are still queued/animating: acting on that stale view would send
      // moves the server has already invalidated (e.g. "tile not in hand").
      const arm = (): void => {
        this.busyTimer = setTimeout(() => {
          if (this.disposed) return;
          if (this.pumping || this.queue.length) {
            arm();
            return;
          }
          this.busyTimer = null;
          this.busy = false;
          this.refresh();
        }, 5000);
      };
      arm();
    }
  }

  private act(action: Action): void {
    if (this.busy) return;
    this.setBusy(true);
    this.selected.clear();
    this.clearHint();
    if (action.type !== 'DECLARE_INSTANT' && action.type !== 'END_TURN') sound.tile();
    this.opts.transport.send(action);
    this.refresh();
  }

  private toggleTile(id: string): void {
    const v = this.view;
    if (!v || this.busy) return;
    if (this.selected.has(id)) {
      this.selected.delete(id);
      sound.deselect();
    } else {
      this.selected.add(id);
      sound.select();
    }
    this.clearHint(false);
    this.refresh();
  }

  private clearSelection(includeStaged: boolean): void {
    this.selected.clear();
    if (includeStaged) this.staged = [];
    this.clearHint(false);
    this.refresh();
  }

  private clearHint(keepIdx = true): void {
    this.hinted = new Set();
    this.hintMeld = null;
    if (!keepIdx) this.hintIdx = 0;
  }

  // ----- port --------------------------------------------------------------------

  private async orderRun(sel: string[], allowSet: boolean): Promise<string[] | null> {
    const v = this.view!;
    const runs = planRun(sel, v.cfg);
    if (runs.length === 1) return runs[0];
    if (runs.length > 1) {
      return this.ask(t('joker.whereTitle'), runs.map((r) => ({ label: tileStrip(r), value: r })), t('joker.whereHint'));
    }
    if (allowSet) {
      const set = planSet(sel, v.cfg);
      if (set) return set;
    }
    toast(allowSet ? t('port.invalidRunOrSet') : t('port.invalidRun'), 'error');
    sound.error();
    return null;
  }

  private async addPortRun(): Promise<void> {
    const v = this.view;
    if (!v) return;
    const sel = this.tray.displayOrder.filter((id) => this.selected.has(id));
    const ordered = await this.orderRun(sel, v.cfg.setAllowedAsPort);
    if (!ordered || !this.sameDecision(v)) return;
    this.staged.push(ordered);
    this.selected.clear();
    sound.tile();
    this.refresh();
  }

  /** Stage a suggested port; repeated clicks cycle through the alternatives. */
  private autoPort(): void {
    const v = this.view;
    if (!v?.legal) return;
    const all = suggestPorts(v.legal.portCandidates, v.cfg, v.hand);
    this.selected.clear();
    if (!all.length) {
      this.staged = [];
      toast(t('port.noSuggestion'), 'info');
      this.refresh();
      return;
    }
    const key = `${v.handNo}|${[...v.hand].sort().join(',')}`;
    if (key !== this.portSuggestKey) {
      this.portSuggestKey = key;
      this.portSuggestIdx = 0;
    }
    const pickIdx = this.portSuggestIdx % all.length;
    this.portSuggestIdx++;
    const s = all[pickIdx];
    this.staged = s.melds.map((m) => [...m]);
    const jokersKept = v.hand.filter((id) => isJokerId(id)).length - s.jokers;
    let text = t('port.suggestion', { i: pickIdx + 1, n: all.length, pts: s.points });
    if (jokersKept > 0) text += ' ' + t('port.jokersKept', { n: jokersKept });
    toast(text, 'success', 2600);
    sound.chime();
    this.refresh();
  }

  private async confirmPort(): Promise<void> {
    const v = this.view;
    if (!v) return;
    if (this.selected.size >= 3) {
      const ordered = await this.orderRun([...this.selected], v.cfg.setAllowedAsPort);
      if (!ordered || !this.sameDecision(v)) return;
      this.staged.push(ordered);
      this.selected.clear();
    }
    if (!this.staged.length) {
      toast(t('port.nothingStaged'), 'error');
      return;
    }
    this.act({ type: 'PORT', melds: this.staged.map((m) => [...m]) });
  }

  // ----- play ------------------------------------------------------------------

  private async onMeldPick(pick: MeldPick): Promise<void> {
    const v = this.view;
    if (!v || this.busy || !this.myPlayTurn(v)) return;
    const meld = v.melds.find((m) => m.id === pick.meldId);
    if (!meld) return;
    if (!this.selected.size) {
      // convenience: select the best legal move for this meld
      const best = hintsFrom(v).find((x) => x.meldId === meld.id && x.kind !== 'swap');
      if (best) {
        this.selected = new Set(best.tiles);
        this.hinted = new Set(best.tiles);
        this.hintMeld = meld.id;
        sound.select();
        toast(t('play.preselected'), 'info', 2200);
        this.refresh();
      } else if (v.legal?.swaps.some((s) => s.meldId === meld.id)) {
        await this.doSwap(meld.id);
      } else {
        toast(t('play.noMoveOnMeld'), 'info');
      }
      return;
    }
    await this.playOnMeld(meld, pick.end);
  }

  private async playOnMeld(meld: Meld, end: 'low' | 'high' | null): Promise<void> {
    const v = this.view;
    if (!v?.legal) return;
    const sel = [...this.selected];
    if (meld.type === 'SET') {
      if (planFollow(meld, sel, v.cfg)) this.act({ type: 'FOLLOW_CUT', meldId: meld.id, tiles: sel });
      else this.error(t('play.cannotFollow'));
      return;
    }
    const exact = legalExtendFor(v.legal, meld.id, sel);
    let plan: ExtendPlan | null = exact;
    if (!plan) {
      const plans = planExtend(meld, sel, v.cfg, v.melds, end);
      if (!plans.length) {
        this.error(t('play.cannotExtend'));
        return;
      }
      if (plans.length === 1 || end) plan = plans[0];
      else {
        plan = await this.ask(
          t('joker.whereTitle'),
          plans.map((p) => ({
            label: h('span', { class: 'extend-preview' },
              p.low.length ? tileStrip(p.low) : null,
              h('span', { class: 'meld-ref' }, meldLabel(meld)),
              p.high.length ? tileStrip(p.high) : null,
            ),
            value: p,
          })),
          t('joker.whereHint'),
        );
        if (!plan || !this.sameDecision(v)) return;
      }
    }
    this.act({ type: 'EXTEND', meldId: meld.id, low: plan.low, high: plan.high });
  }

  private doCut(): void {
    const v = this.view;
    if (!v?.legal) return;
    if (v.legal.cutBlocked) {
      this.error(t('play.cutBlocked'));
      return;
    }
    const set = planSet([...this.selected], v.cfg);
    if (!set) {
      this.error(t('play.invalidSet'));
      return;
    }
    this.act({ type: 'CUT', tiles: set });
  }

  private async doNewRun(): Promise<void> {
    const v = this.view;
    if (!v) return;
    const ordered = await this.orderRun([...this.selected], false);
    if (ordered && this.sameDecision(v)) this.act({ type: 'NEW_RUN', tiles: ordered });
  }

  private async doSwap(meldId: string | null): Promise<void> {
    const v = this.view;
    if (!v?.legal) return;
    const swaps = v.legal.swaps.filter((s) => !meldId || s.meldId === meldId);
    if (!swaps.length) return;
    const pickSwap = await this.ask(
      t('swap.title'),
      swaps.map((s) => ({ label: this.swapOption(v, s), value: s })),
      needsSwapFirst(v.legal) ? `${t('play.swapFirst')} ${t('swap.hint')}` : t('swap.hint'),
    );
    if (pickSwap && this.sameDecision(v)) this.act({ type: 'SWAP_JOKER', ...pickSwap });
  }

  /** Open a choice picker tied to the current decision; it closes itself when the decision goes stale. */
  private ask<T>(title: string, options: Choice<T>[], hint?: string): Promise<T | null> {
    this.closeChoice();
    const ac = new AbortController();
    this.choiceAbort = ac;
    this.choiceKey = this.view ? decisionKey(this.view) : '';
    return choose(title, options, hint, ac.signal).finally(() => {
      if (this.choiceAbort === ac) this.choiceAbort = null;
    });
  }

  private closeChoice(): void {
    const ac = this.choiceAbort;
    this.choiceAbort = null;
    ac?.abort();
  }

  /** The view captured before an await still describes the same decision. */
  private sameDecision(v: PlayerView): boolean {
    return !this.disposed && !!this.view && decisionKey(this.view) === decisionKey(v);
  }

  /**
   * One swap choice: [your tile] <-> [Joker], the meld it sits in (joker marked,
   * every tile showing what it stands for) and the joker's represented tile.
   */
  private swapOption(v: PlayerView, s: { meldId: string; jokerTileId: string; withTileId: string }): HTMLElement {
    const meld = v.melds.find((m) => m.id === s.meldId);
    const rep = jokerRep(v.melds, s.meldId, s.jokerTileId);
    const meldTiles = meld
      ? h('span', { class: 'tile-strip swap-meld' },
          meld.tiles.map((mt) => {
            const el = miniTile(mt.tileId, mt.rep);
            if (mt.tileId === s.jokerTileId) el.classList.add('swap-target');
            return el;
          }),
        )
      : null;
    return h('span', { class: 'swap-option' },
      h('span', { class: 'swap-preview' },
        h('span', { class: 'swap-side' }, miniTile(s.withTileId), h('small', null, t('swap.yourTile'))),
        h('span', { class: 'swap-arrow', 'aria-hidden': 'true' }, '⇄'),
        h('span', { class: 'swap-side' }, miniTile(s.jokerTileId, rep ? { colour: rep.colour, rank: rep.rank } : undefined), h('small', null, 'Joker')),
      ),
      h('span', { class: 'swap-detail' },
        h('span', { class: 'swap-in' }, t('swap.inMeld'), ' ', h('span', { class: 'meld-ref' }, meld ? meldLabel(meld) : '?')),
        meldTiles,
        rep ? h('span', { class: 'swap-rep' }, t('swap.jokerIs', { tile: repLabel(rep) })) : null,
      ),
    );
  }

  private showHint(): void {
    const v = this.view;
    if (!v) return;
    const hints = hintsFrom(v);
    if (!hints.length) {
      toast(t('hint.none'), 'info');
      return;
    }
    // cycle per decision: a new turn or a changed hand/table restarts from the best move
    const key = `${v.handNo}|${v.turn}|${[...v.hand].sort().join(',')}|${v.melds.map((m) => m.tiles.length).join(',')}`;
    if (key !== this.hintKey) {
      this.hintKey = key;
      this.hintIdx = 0;
    }
    const idx = this.hintIdx % hints.length;
    const hint: Hint = hints[idx];
    this.hintIdx++;
    this.selected = new Set(hint.kind === 'swap' ? [] : hint.tiles);
    this.hinted = new Set(hint.tiles);
    this.hintMeld = hint.meldId;
    const meld = hint.meldId ? v.melds.find((m) => m.id === hint.meldId) : undefined;
    let text = t(`hint.${hint.kind}`, { meld: meld ? meldLabel(meld) : '', n: hint.points });
    if (hint.action.type === 'SWAP_JOKER') {
      const rep = jokerRep(v.melds, hint.action.meldId, hint.action.jokerTileId);
      if (rep) text = t('hint.swapWith', { meld: meld ? meldLabel(meld) : '', tile: repLabel(rep) });
      if (needsSwapFirst(v.legal)) text = `${t('play.swapFirst')} ${text}`;
    }
    if (hints.length > 1) text += ` (${idx + 1}/${hints.length})`;
    toast(text, 'success', 3200);
    sound.chime();
    this.refresh();
  }

  // ---------------------------------------------------------------------------
  // results / leaving
  // ---------------------------------------------------------------------------

  private handleResults(v: PlayerView): void {
    const ended = v.phase === 'HAND_END' || v.phase === 'MATCH_END';
    const res = v.lastResult;
    const local = this.opts.transport.kind === 'local';
    if (ended && res && res.handNo !== this.shownResult) {
      this.shownResult = res.handNo;
      this.resultModal?.close();
      const final = v.phase === 'MATCH_END';
      this.resultFinal = final;
      const autoMs = final ? null : local ? (getPrefs().autoNext ? v.cfg.handEndDelayMs : null) : v.cfg.handEndDelayMs;
      this.resultModal = showHandResult(v, res, {
        final,
        autoMs,
        onNext: final ? () => this.showStandings() : local ? () => this.opts.transport.advance?.() : undefined,
        onClose: () => {
          this.resultModal = null;
        },
      });
      if (res.winnerSeat === v.you) sound.win();
      return;
    }
    if (v.phase === 'MATCH_END' && v.standings && !this.matchModal && !(this.resultModal && this.resultFinal)) {
      this.resultModal?.close();
      this.showStandings();
      return;
    }
    if (!ended && this.resultModal) {
      this.resultModal.close();
      this.resultModal = null;
    }
  }

  private showStandings(quiet = false): void {
    const v = this.view;
    if (!v?.standings || this.matchModal) return;
    if (!quiet) sound.win();
    const can = this.opts.canAgain?.() ?? true;
    this.matchAgain = can;
    const modal = showMatchEnd(v, v.standings, {
      onAgain: can ? () => this.opts.onAgain() : undefined,
      onExit: () => this.opts.onExit(),
      againLabel: this.opts.againLabel,
      againPending: this.opts.againPending,
      waitingNote: can ? undefined : (this.opts.againWaiting ?? t('match.waitHost')),
    });
    this.matchModal = modal;
    const close = modal.close;
    modal.close = () => {
      if (this.matchModal === modal) this.matchModal = null;
      close();
    };
  }

  /** Room info changed (e.g. the host left and we inherited it): refresh the rematch option. */
  updateAgain(): void {
    if (!this.matchModal || this.disposed) return;
    const can = this.opts.canAgain?.() ?? true;
    if (can === this.matchAgain) return;
    this.matchModal.close();
    this.showStandings(true);
  }

  private confirmLeave(): void {
    openModal({
      title: t('table.leaveTitle'),
      body: h('p', null, this.opts.transport.kind === 'online' ? t('table.leaveOnline') : t('table.leaveOffline')),
      actions: [
        { label: t('common.cancel'), kind: 'ghost', onClick: () => undefined },
        { label: t('table.leave'), kind: 'danger', onClick: () => this.opts.onExit() },
      ],
    });
  }

  /** Re-label everything after a language switch. */
  relabel(): void {
    for (const b of this.iconButtons) {
      b.el.setAttribute('aria-label', t(b.key));
      b.el.title = t(b.key);
    }
    this.tray.relabel();
    this.emotes.relabel();
    this.renderAll();
  }

  dispose(): void {
    this.disposed = true;
    this.closeChoice();
    clearInterval(this.tickHandle);
    if (this.busyTimer) clearTimeout(this.busyTimer);
    this.resultModal?.close();
    this.matchModal?.close();
    clearBanners();
    this.emotes.dispose();
    this.seats.dispose();
    this.el.remove();
  }
}
