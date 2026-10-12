/**
 * Lobby / character select. Shared by offline (vs bots) and online (create/join room).
 * Left: live 3D avatar preview (AvatarStage). Right: name, character grid, options.
 */
import { MAX_NAME_LENGTH, ROOM_CODE_LENGTH, type BotLevel, type RulesConfig } from '@open-rummy/shared';
import { AVATARS } from '../avatars/catalog';
import type { AvatarStage } from '../avatars/portrait';
import { h } from './dom';
import { screenHeader, segmented, toggle, type ConnIndicator, type Screen } from './screen';
import { getPrefs, setPrefs } from './prefs';
import { avatarDef, defaultAvatarId, loadAvatarModule, portraitEl } from './portraits';
import { rulesOptionsPanel } from './rulesOptions';
import { sound } from './sound';
import { toast } from './toast';
import { pick, t } from '../i18n';

/** Loose view of AvatarStage tolerant to either method name for loading an avatar. */
interface StageLike {
  show?(avatarId: string): Promise<void> | void;
  setAvatar?(avatarId: string): Promise<void> | void;
  react?(reaction: 'wave'): void;
}

export interface OfflineStart {
  name: string;
  avatar: string;
  cfg: Partial<RulesConfig>;
  botLevel: BotLevel;
  relaxed: boolean;
}

export interface LobbyDeps {
  mode: 'offline' | 'online';
  onBack(): void;
  onStartOffline?(o: OfflineStart): void;
  online?: {
    conn: ConnIndicator;
    onCreate(name: string, avatar: string, cfg: Partial<RulesConfig>, botLevel: BotLevel): void;
    onJoin(code: string, name: string, avatar: string): void;
  };
}

/** Sanitize a display name: trim, collapse whitespace, strip control chars, cap length. */
export function cleanName(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
}

export function currentName(): string {
  return cleanName(getPrefs().name) || t('lobby.defaultName');
}

export function currentAvatar(): string {
  const saved = getPrefs().avatar;
  return AVATARS.some((a) => a.id === saved) ? saved : defaultAvatarId();
}

export function lobbyScreen(deps: LobbyDeps): Screen {
  const prefs = getPrefs();
  let avatar = currentAvatar();
  let stage: AvatarStage | null = null;
  let disposed = false;

  // ----- character preview -----------------------------------------------------
  const stageBox = h('div', { class: 'stage-box' });
  const stageFallback = h('div', { class: 'stage-fallback' });
  const charName = h('div', { class: 'char-name' });
  const charTag = h('div', { class: 'char-tag' });
  const showChar = (): void => {
    const def = avatarDef(avatar);
    charName.textContent = def ? pick(def.nameZh, def.nameEn) : avatar;
    charTag.textContent = def ? pick(def.taglineZh, def.taglineEn) : '';
    stageBox.style.setProperty('--accent', def?.color ?? '#3dd6c6');
    if (stage) {
      // The contract names this `show(id)`; the implementation may call it `setAvatar(id)`.
      // Either may be missing or return a non-promise: never let it throw here.
      const s = stage as unknown as StageLike;
      const load = s.setAvatar ?? s.show;
      try {
        Promise.resolve(load?.call(s, avatar)).catch((err) => console.warn('[lobby] avatar load failed', err));
        s.react?.('wave');
      } catch (err) {
        console.warn('[lobby] avatar stage error', err);
      }
    } else {
      stageFallback.replaceChildren(portraitEl(avatar, '', 320, 'stage-portrait'));
    }
  };
  stageBox.append(stageFallback);
  loadAvatarModule()
    .then((m) => {
      if (disposed) return;
      stage = new m.AvatarStage(stageBox);
      stageFallback.remove();
      showChar();
    })
    .catch((err) => console.warn('[lobby] avatar stage unavailable', err));

  // ----- character grid ----------------------------------------------------------
  const grid = h('div', { class: 'char-grid', role: 'radiogroup', 'aria-label': t('lobby.character') });
  const renderGrid = (): void => {
    grid.replaceChildren(
      ...AVATARS.map((a) =>
        h('button', {
          class: `char-card ${a.id === avatar ? 'on' : ''}`,
          role: 'radio',
          'aria-checked': String(a.id === avatar),
          'aria-label': pick(a.nameZh, a.nameEn),
          style: `--accent:${a.color}`,
          onclick: () => {
            if (a.id === avatar) return;
            sound.select();
            avatar = a.id;
            setPrefs({ avatar });
            renderGrid();
            showChar();
          },
        }, portraitEl(a.id, pick(a.nameZh, a.nameEn), 160, 'char-portrait'), h('span', { class: 'char-card-name' }, pick(a.nameZh, a.nameEn))),
      ),
    );
  };
  renderGrid();
  showChar();

  // ----- name --------------------------------------------------------------------------
  const nameInput = h('input', {
    class: 'text-input',
    type: 'text',
    maxlength: String(MAX_NAME_LENGTH),
    value: prefs.name,
    placeholder: t('lobby.defaultName'),
    autocomplete: 'nickname',
    'aria-label': t('lobby.name'),
    oninput: () => setPrefs({ name: nameInput.value.slice(0, MAX_NAME_LENGTH) }),
  });

  // ----- options -----------------------------------------------------------------------
  let botLevel: BotLevel = prefs.botLevel;
  const botRow = h('div', { class: 'field' },
    h('span', { class: 'field-label' }, t('lobby.botLevel')),
    segmented<BotLevel>(
      [
        { value: 'easy', label: t('bot.easy') },
        { value: 'normal', label: t('bot.normal') },
        { value: 'hard', label: t('bot.hard') },
      ],
      botLevel,
      (v) => {
        botLevel = v;
        setPrefs({ botLevel: v });
      },
      t('lobby.botLevel'),
    ),
  );
  let rules = prefs.rules;
  const rulesBox = h('details', { class: 'rules-details' },
    h('summary', null, t('lobby.ruleOptions')),
    rulesOptionsPanel(rules, (r) => {
      rules = r;
      setPrefs({ rules: r });
    }, { online: deps.mode === 'online' }),
  );

  let side: HTMLElement;
  if (deps.mode === 'offline') {
    let relaxed = prefs.relaxed;
    side = h('div', { class: 'lobby-actions' },
      botRow,
      toggle(t('lobby.relaxed'), relaxed, (v) => {
        relaxed = v;
        setPrefs({ relaxed: v });
      }, t('lobby.relaxedHint')),
      toggle(t('settings.autoNext'), prefs.autoNext, (v) => setPrefs({ autoNext: v })),
      rulesBox,
      h('button', {
        class: 'btn btn-gold btn-xl start-btn',
        onclick: () => {
          sound.chime();
          deps.onStartOffline?.({ name: cleanName(nameInput.value) || t('lobby.defaultName'), avatar, cfg: rules, botLevel, relaxed });
        },
      }, t('lobby.start')),
    );
  } else {
    const online = deps.online!;
    const codeInput = h('input', {
      class: 'text-input code-input',
      type: 'text',
      maxlength: String(ROOM_CODE_LENGTH),
      placeholder: 'ABC123',
      autocapitalize: 'characters',
      autocomplete: 'off',
      spellcheck: 'false',
      'aria-label': t('online.code'),
      oninput: () => {
        codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
      },
    });
    const join = (): void => {
      const code = codeInput.value.trim();
      if (code.length !== ROOM_CODE_LENGTH) {
        toast(t('online.codeInvalid', { n: ROOM_CODE_LENGTH }), 'error');
        sound.error();
        return;
      }
      sound.click();
      online.onJoin(code, cleanName(nameInput.value) || t('lobby.defaultName'), avatar);
    };
    codeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') join();
    });
    side = h('div', { class: 'lobby-actions' },
      h('section', { class: 'sub-panel' },
        h('h3', null, t('online.create')),
        botRow,
        rulesBox,
        h('button', {
          class: 'btn btn-gold btn-lg',
          onclick: () => {
            sound.click();
            online.onCreate(cleanName(nameInput.value) || t('lobby.defaultName'), avatar, rules, botLevel);
          },
        }, t('online.createBtn')),
      ),
      h('section', { class: 'sub-panel' },
        h('h3', null, t('online.join')),
        h('div', { class: 'join-row' }, codeInput, h('button', { class: 'btn btn-teal', onclick: join }, t('online.joinBtn'))),
      ),
    );
  }

  const el = h('div', { class: 'screen lobby-screen' },
    screenHeader(deps.mode === 'offline' ? t('menu.offline') : t('menu.online'), deps.onBack, deps.online?.conn.el ?? null),
    h('div', { class: 'lobby-grid' },
      h('section', { class: 'lobby-stage panel' }, stageBox, h('div', { class: 'char-caption' }, charName, charTag)),
      h('section', { class: 'lobby-side panel' },
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, t('lobby.name')), nameInput),
        h('div', { class: 'field' }, h('span', { class: 'field-label' }, t('lobby.character')), grid),
        side,
      ),
    ),
  );

  return {
    el,
    dispose() {
      disposed = true;
      stage?.dispose();
      stage = null;
    },
  };
}
