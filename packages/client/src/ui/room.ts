/**
 * Online room view: room code (with copy), seats with avatars, host controls
 * (add bot / remove / start), rules summary, leave.
 */
import type { RoomInfo, SeatInfo } from '@open-rummy/shared';
import type { OnlineTransport } from '../net/online';
import { h, icon, ICONS } from './dom';
import { screenHeader, type ConnIndicator, type Screen } from './screen';
import { portraitEl } from './portraits';
import { rulesSummary } from './rulesOptions';
import { sound } from './sound';
import { toast } from './toast';
import { t } from '../i18n';

export interface RoomScreen extends Screen {
  update(room: RoomInfo): void;
}

export function roomScreen(transport: OnlineTransport, conn: ConnIndicator, onLeave: () => void): RoomScreen {
  const codeEl = h('span', { class: 'room-code-text' });
  const seatsEl = h('div', { class: 'room-seats' });
  const controls = h('div', { class: 'room-controls' });
  const summary = h('ul', { class: 'room-rules' });
  let current: RoomInfo | null = null;

  const copy = async (): Promise<void> => {
    if (!current) return;
    const text = current.code;
    try {
      await navigator.clipboard.writeText(text);
      toast(t('online.copied'), 'success');
    } catch {
      // clipboard API blocked (http / permissions): fall back to selecting the text
      const range = document.createRange();
      range.selectNodeContents(codeEl);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      toast(t('online.copyManual'), 'info');
    }
    sound.click();
  };

  const seatCard = (s: SeatInfo | null, idx: number, isHost: boolean, you: number): HTMLElement => {
    if (!s) {
      return h('div', { class: 'room-seat empty' },
        h('div', { class: 'portrait seat-empty-portrait' }, h('span', { class: 'portrait-initial' }, '?')),
        h('div', { class: 'room-seat-name muted' }, t('online.emptySeat')),
        isHost ? h('button', { class: 'chip-btn', onclick: () => { sound.click(); transport.addBot(); } }, icon(ICONS.plus), t('online.addBot')) : null,
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
      h('div', { class: 'room-seat-status' }, s.isBot ? t('common.bot') : s.connected ? t('online.ready') : t('status.offline')),
      isHost && s.seat !== you
        ? h('button', {
            class: 'chip-btn danger',
            'aria-label': t('online.remove'),
            onclick: () => {
              sound.click();
              transport.removeSeat(s.seat);
            },
          }, icon(ICONS.close), t('online.remove'))
        : null,
    );
  };

  const update = (room: RoomInfo): void => {
    current = room;
    codeEl.textContent = room.code;
    const me = room.seats[room.you] ?? room.seats.find((s) => s?.seat === room.you) ?? null;
    const isHost = !!me?.host;
    const slots = room.seats.length ? room.seats : Array.from({ length: room.cfg.players }, () => null);
    // the pop-in plays once; later updates (joins, bots, reconnects) must not flash every card
    if (seatsEl.childElementCount) seatsEl.classList.add('settled');
    seatsEl.replaceChildren(...slots.map((s, i) => seatCard(s, i, isHost, room.you)));
    const filled = slots.filter(Boolean).length;
    controls.replaceChildren(
      isHost
        ? h('button', {
            class: 'btn btn-gold btn-xl',
            disabled: room.started,
            onclick: () => {
              sound.chime();
              transport.startGame();
            },
          }, filled < room.cfg.players ? t('online.startWithBots') : t('online.start'))
        : h('div', { class: 'muted waiting-host' }, room.started ? t('online.starting') : t('online.waitingHost')),
    );
    summary.replaceChildren(...rulesSummary(room.cfg).map((s) => h('li', null, s)));
  };

  const el = h('div', { class: 'screen room-screen' },
    screenHeader(t('online.room'), () => {
      transport.leave();
      onLeave();
    }, conn.el),
    h('div', { class: 'room-body panel' },
      h('div', { class: 'room-code' },
        h('span', { class: 'muted' }, t('online.code')),
        codeEl,
        h('button', { class: 'icon-btn', 'aria-label': t('online.copy'), title: t('online.copy'), onclick: () => void copy() }, icon(ICONS.copy)),
      ),
      h('p', { class: 'muted room-share' }, t('online.share')),
      seatsEl,
      controls,
      h('details', { class: 'rules-details' }, h('summary', null, t('online.rules')), summary),
    ),
  );

  return { el, update };
}
