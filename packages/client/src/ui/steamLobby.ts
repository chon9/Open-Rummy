/**
 * Steam lobby screens (desktop build only; never shown in the browser):
 * - home: Steam availability, character, create (friends-only / public) with bot level,
 *   relaxed mode and rule options, and the filtered lobby browser;
 * - room: members with their characters, invite (Steam overlay), host settings
 *   (same rule options panel as the online lobby), start (host) and leave.
 * Pure DOM; the session logic lives in steamFlow.ts.
 */
import { DEFAULT_RULES, PENANG_CLASSIC, type BotLevel, type RoomInfo, type RulesConfig, type SeatInfo } from '@open-rummy/shared';
import { AVATARS } from '../avatars/catalog';
import type { LobbySummary, SteamResult } from '../net/desktopBridge';
import { h, icon, ICONS } from './dom';
import { screenHeader, segmented, toggle, type Screen } from './screen';
import { portraitEl } from './portraits';
import { rulesOptionsPanel, rulesSummary } from './rulesOptions';
import { sound } from './sound';
import { toast } from './toast';
import { pick, t } from '../i18n';

export interface SteamStatus {
  ok: boolean;
  /** Steam persona name when ok */
  name?: string;
  appId?: number;
  /** raw reason from the bridge when !ok (diagnostic, shown small under the localized text) */
  reason?: string;
}

export interface SteamTableSettings {
  avatar: string;
  cfg: Partial<RulesConfig>;
  botLevel: BotLevel;
  relaxed: boolean;
}

// ---------------------------------------------------------------------------
// shared pieces
// ---------------------------------------------------------------------------

/** Compact character picker (portrait cards). */
export function avatarPicker(current: string, onPick: (id: string) => void): HTMLElement {
  let value = current;
  const grid = h('div', { class: 'char-grid steam-char-grid', role: 'radiogroup', 'aria-label': t('lobby.character') });
  const render = (): void => {
    grid.replaceChildren(
      ...AVATARS.map((a) =>
        h('button', {
          class: `char-card ${a.id === value ? 'on' : ''}`,
          role: 'radio',
          'aria-checked': String(a.id === value),
          'aria-label': pick(a.nameZh, a.nameEn),
          style: `--accent:${a.color}`,
          onclick: () => {
            if (a.id === value) return;
            sound.select();
            value = a.id;
            render();
            onPick(a.id);
          },
        }, portraitEl(a.id, pick(a.nameZh, a.nameEn), 160, 'char-portrait'), h('span', { class: 'char-card-name' }, pick(a.nameZh, a.nameEn))),
      ),
    );
  };
  render();
  return grid;
}

function botLevelRow(value: BotLevel, onPick: (v: BotLevel) => void): HTMLElement {
  return h('div', { class: 'field' },
    h('span', { class: 'field-label' }, t('lobby.botLevel')),
    segmented<BotLevel>(
      [
        { value: 'easy', label: t('bot.easy') },
        { value: 'normal', label: t('bot.normal') },
        { value: 'hard', label: t('bot.hard') },
      ],
      value,
      onPick,
      t('lobby.botLevel'),
    ),
  );
}

/** Table settings editor (bot level, relaxed, rules). */
function settingsEditor(initial: SteamTableSettings, onChange: (s: SteamTableSettings) => void): HTMLElement {
  let s = { ...initial };
  const emit = (): void => onChange({ ...s });
  return h('div', { class: 'steam-settings' },
    botLevelRow(s.botLevel, (v) => {
      s = { ...s, botLevel: v };
      emit();
    }),
    toggle(t('lobby.relaxed'), s.relaxed, (v) => {
      s = { ...s, relaxed: v };
      emit();
    }, t('steam.relaxedHint')),
    h('details', { class: 'rules-details' },
      h('summary', null, t('lobby.ruleOptions')),
      rulesOptionsPanel(s.cfg, (cfg) => {
        s = { ...s, cfg };
        emit();
      }, { online: true }),
    ),
  );
}

/** Rule preset name for a lobby row, from the host's resolved RulesConfig JSON. */
export function presetLabel(rulesJson: string | undefined): string {
  let cfg: Partial<RulesConfig> | null = null;
  try {
    const parsed: unknown = JSON.parse(rulesJson ?? '');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) cfg = parsed as Partial<RulesConfig>;
  } catch {
    cfg = null;
  }
  if (!cfg) return '';
  const keys = Object.keys(PENANG_CLASSIC) as (keyof RulesConfig)[];
  const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
  if (keys.every((k) => same(cfg?.[k], PENANG_CLASSIC[k]))) return t('rule.preset.penang');
  if (keys.every((k) => same(cfg?.[k], DEFAULT_RULES[k]))) return t('rule.preset.cariMakan');
  return t('steam.preset.custom');
}

// ---------------------------------------------------------------------------
// home: availability, create, browse
// ---------------------------------------------------------------------------

export interface SteamHomeDeps {
  onBack(): void;
  status(): Promise<SteamStatus>;
  settings: SteamTableSettings;
  onSettings(s: SteamTableSettings): void;
  onCreate(visibility: 'friends' | 'public', s: SteamTableSettings): Promise<void>;
  onJoin(lobbyId: string): Promise<void>;
  list(): Promise<SteamResult<LobbySummary[]>>;
}

export function steamHomeScreen(deps: SteamHomeDeps): Screen {
  let settings = { ...deps.settings };
  let busy = false;
  let disposed = false;
  let available = false;

  const statusEl = h('div', { class: 'steam-status checking', role: 'status' }, t('steam.checking'));
  const createBtns: HTMLButtonElement[] = [];
  const listEl = h('div', { class: 'steam-lobby-list', 'aria-live': 'polite' });
  const refreshBtn = h('button', { class: 'chip-btn', onclick: () => void refresh() }, t('steam.refresh'));

  const setBusy = (b: boolean): void => {
    busy = b;
    for (const btn of createBtns) btn.disabled = b || !available;
    refreshBtn.disabled = b || !available;
    for (const btn of listEl.querySelectorAll('button')) (btn as HTMLButtonElement).disabled = b || btn.dataset.started === '1';
  };

  const createBtn = (visibility: 'friends' | 'public', label: string, cls: string): HTMLButtonElement => {
    const btn = h('button', {
      class: `btn ${cls} btn-lg`,
      disabled: true,
      onclick: async () => {
        if (busy) return;
        sound.click();
        setBusy(true);
        try {
          await deps.onCreate(visibility, settings);
        } finally {
          if (!disposed) setBusy(false);
        }
      },
    }, label);
    createBtns.push(btn);
    return btn;
  };

  const row = (l: LobbySummary): HTMLElement => {
    const preset = presetLabel(l.data.rules);
    const players = l.seatsTaken !== null && l.seatsTotal !== null ? t('steam.lobbyPlayers', { n: l.seatsTaken, m: l.seatsTotal }) : '';
    // started or every seat taken (the host would refuse us): not joinable from the browser
    const closed = l.started || (l.seatsTaken !== null && l.seatsTotal !== null && l.seatsTaken >= l.seatsTotal);
    const join = h('button', {
      class: 'btn btn-teal',
      disabled: closed || busy,
      dataset: { started: closed ? '1' : '0' },
      onclick: async () => {
        if (busy) return;
        sound.click();
        setBusy(true);
        try {
          await deps.onJoin(l.lobbyId);
        } finally {
          if (!disposed) setBusy(false);
        }
      },
    }, t('steam.join'));
    return h('div', { class: 'steam-lobby-row' },
      h('div', { class: 'steam-lobby-host' }, icon(ICONS.crown), h('span', null, l.hostName || t('steam.unnamedHost'))),
      h('div', { class: 'steam-lobby-meta muted' },
        players ? h('span', null, players) : null,
        preset ? h('span', null, preset) : null,
        l.started ? h('span', { class: 'tag' }, t('steam.inGame')) : null,
      ),
      join,
    );
  };

  async function refresh(): Promise<void> {
    if (!available) return;
    listEl.replaceChildren(h('div', { class: 'muted' }, t('steam.loading')));
    let res: SteamResult<LobbySummary[]>;
    try {
      res = await deps.list();
    } catch (err) {
      res = { ok: false, reason: 'unknown', message: err instanceof Error ? err.message : String(err) };
    }
    if (disposed) return;
    if (!res.ok) {
      listEl.replaceChildren(h('div', { class: 'muted' }, t('steam.listFailed', { msg: res.message ?? res.reason })));
      return;
    }
    listEl.replaceChildren(...(res.value.length ? res.value.map(row) : [h('div', { class: 'muted steam-empty' }, t('steam.noLobbies'))]));
  }

  async function check(): Promise<void> {
    statusEl.className = 'steam-status checking';
    statusEl.replaceChildren(t('steam.checking'));
    let st: SteamStatus;
    try {
      st = await deps.status();
    } catch (err) {
      st = { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
    if (disposed) return;
    available = st.ok;
    if (st.ok) {
      statusEl.className = 'steam-status ok';
      statusEl.replaceChildren(
        h('i', { class: 'conn-dot', 'aria-hidden': 'true' }),
        h('span', null, t('steam.signedIn', { name: st.name ?? '' })),
      );
      if (st.appId === 480) statusEl.append(h('small', { class: 'muted steam-dev' }, t('steam.dev480')));
    } else {
      statusEl.className = 'steam-status bad';
      statusEl.replaceChildren(h('strong', null, t('steam.unavailable')), h('span', null, t('steam.unavailableHint')));
      if (st.reason) statusEl.append(h('small', { class: 'muted' }, st.reason));
      statusEl.append(h('button', { class: 'chip-btn', onclick: () => { sound.click(); void check(); } }, t('steam.retry')));
      listEl.replaceChildren();
    }
    setBusy(busy);
    if (st.ok) void refresh();
  }

  const emitSettings = (): void => deps.onSettings({ ...settings });

  const el = h('div', { class: 'screen lobby-screen steam-screen' },
    screenHeader(t('steam.title'), deps.onBack),
    h('div', { class: 'lobby-grid' },
      h('section', { class: 'lobby-side panel' },
        statusEl,
        h('div', { class: 'field' },
          h('span', { class: 'field-label' }, t('steam.yourCharacter')),
          avatarPicker(settings.avatar, (id) => {
            settings = { ...settings, avatar: id };
            emitSettings();
          }),
        ),
      ),
      h('section', { class: 'lobby-side panel' },
        h('section', { class: 'sub-panel' },
          h('h3', null, t('steam.create')),
          settingsEditor(settings, (s) => {
            settings = { ...s, avatar: settings.avatar };
            emitSettings();
          }),
          h('div', { class: 'steam-create-row' },
            createBtn('friends', t('steam.createFriends'), 'btn-gold'),
            createBtn('public', t('steam.createPublic'), 'btn-teal'),
          ),
        ),
        h('section', { class: 'sub-panel' },
          h('div', { class: 'steam-browse-head' }, h('h3', null, t('steam.browse')), refreshBtn),
          listEl,
        ),
      ),
    ),
  );

  void check();
  return {
    el,
    dispose() {
      disposed = true;
    },
  };
}

// ---------------------------------------------------------------------------
// room: members, invite, host settings, start / leave
// ---------------------------------------------------------------------------

export interface SteamRoomDeps {
  isHost: boolean;
  avatar: string;
  onLeave(): void;
  onInvite(): Promise<boolean>;
  onAvatar(avatar: string): void;
  /** host only */
  onStart?(): void;
  /** host only: returns false when the change was refused */
  onConfigure?(s: SteamTableSettings): boolean;
  hostSettings?: SteamTableSettings;
}

export interface SteamRoomScreen extends Screen {
  update(room: RoomInfo | null): void;
}

export function steamRoomScreen(deps: SteamRoomDeps): SteamRoomScreen {
  const seatsEl = h('div', { class: 'room-seats' });
  const controls = h('div', { class: 'room-controls' });
  const summary = h('ul', { class: 'room-rules' });
  const statusEl = h('p', { class: 'muted room-share' }, deps.isHost ? t('steam.inviteHint') : t('steam.waitingWelcome'));
  let current: RoomInfo | null = null;

  const seatCard = (s: SeatInfo | null, idx: number, you: number): HTMLElement => {
    if (!s) {
      return h('div', { class: 'room-seat empty', style: `--i:${idx}` },
        h('div', { class: 'portrait seat-empty-portrait' }, h('span', { class: 'portrait-initial' }, '?')),
        h('div', { class: 'room-seat-name muted' }, t('steam.emptySeat')),
        h('div', { class: 'room-seat-status' }, t('steam.botFills')),
      );
    }
    return h('div', { class: `room-seat ${s.seat === you ? 'is-you' : ''} ${s.connected || s.isBot ? '' : 'offline'}`, style: `--i:${idx}` },
      portraitEl(s.avatar, s.name, 160, 'room-portrait'),
      h('div', { class: 'room-seat-name' },
        s.name,
        s.host ? h('span', { class: 'tag tag-host', title: t('online.host') }, icon(ICONS.crown)) : null,
        s.isBot ? h('span', { class: 'tag tag-bot', title: t('common.bot') }, icon(ICONS.robot)) : null,
        s.seat === you ? h('span', { class: 'tag tag-you' }, t('common.you')) : null,
      ),
      h('div', { class: 'room-seat-status' }, s.isBot ? t('common.bot') : s.host ? t('online.host') : t('online.ready')),
    );
  };

  const update = (room: RoomInfo | null): void => {
    current = room;
    if (!room) {
      seatsEl.replaceChildren();
      controls.replaceChildren(h('div', { class: 'muted waiting-host' }, t('steam.waitingWelcome')));
      return;
    }
    if (!deps.isHost) statusEl.textContent = t('steam.inviteHint');
    if (seatsEl.childElementCount) seatsEl.classList.add('settled');
    seatsEl.replaceChildren(...room.seats.map((s, i) => seatCard(s, i, room.you)));
    const filled = room.seats.filter(Boolean).length;
    controls.replaceChildren(
      deps.isHost
        ? h('button', {
            class: 'btn btn-gold btn-xl',
            disabled: room.started,
            onclick: () => {
              sound.chime();
              deps.onStart?.();
            },
          }, filled < room.seats.length ? t('online.startWithBots') : t('online.start'))
        : h('div', { class: 'muted waiting-host' }, room.started ? t('online.starting') : t('online.waitingHost')),
    );
    summary.replaceChildren(...rulesSummary(room.cfg).map((s) => h('li', null, s)));
  };

  // host settings: edited in place; a refused change (fewer seats than players) re-renders the editor
  let settingsBox: HTMLElement | null = null;
  if (deps.isHost && deps.hostSettings && deps.onConfigure) {
    let accepted = { ...deps.hostSettings };
    const holder = h('div', null);
    const render = (): void => {
      holder.replaceChildren(
        settingsEditor(accepted, (s) => {
          if (deps.onConfigure?.(s)) accepted = { ...s };
          else {
            toast(t('steam.rulesTooSmall'), 'error');
            sound.error();
            render();
          }
        }),
      );
    };
    render();
    settingsBox = h('section', { class: 'sub-panel' }, h('h3', null, t('steam.hostSettings')), holder);
  }

  const inviteBtn = h('button', {
    class: 'btn btn-teal',
    onclick: async () => {
      sound.click();
      const ok = await deps.onInvite();
      if (!ok) toast(t('steam.inviteFailed'), 'error', 4500);
    },
  }, icon(ICONS.plus), t('steam.invite'));

  const el = h('div', { class: 'screen room-screen steam-room' },
    screenHeader(t('steam.lobby'), deps.onLeave),
    h('div', { class: 'room-body panel' },
      h('div', { class: 'room-code steam-room-head' }, h('span', { class: 'steam-room-title' }, t('steam.lobby')), inviteBtn),
      statusEl,
      seatsEl,
      controls,
      h('details', { class: 'rules-details' },
        h('summary', null, t('steam.yourCharacter')),
        avatarPicker(deps.avatar, (id) => deps.onAvatar(id)),
      ),
      settingsBox,
      deps.isHost ? null : h('details', { class: 'rules-details' }, h('summary', null, t('online.rules')), summary),
      h('div', { class: 'room-controls' },
        h('button', { class: 'btn btn-ghost', onclick: () => { sound.click(); deps.onLeave(); } }, icon(ICONS.exit), t('steam.leave')),
      ),
    ),
  );

  update(current);
  return { el, update };
}
