/**
 * Hand result modal (rankings, revealed hands, chip deltas) and the match-end podium.
 */
import type { HandResult, MatchStanding, PlayerView } from '@open-rummy/shared';
import { countUp, h } from '../dom';
import { openModal, type ModalHandle } from '../modal';
import { portraitEl } from '../portraits';
import { tileStrip } from '../tileView';
import { t, tDyn } from '../../i18n';

export interface HandResultOptions {
  /** offline manual advance: show a Next button */
  onNext?: () => void;
  /** host advances automatically after this many ms (shows a countdown) */
  autoMs?: number | null;
  /** the match is over: the button continues to the standings */
  final?: boolean;
  onClose?: () => void;
}

const signed = (n: number): string => (n > 0 ? `+${n}` : String(n));

export function showHandResult(view: PlayerView, result: HandResult, opts: HandResultOptions): ModalHandle {
  const kindKey = `kind.${result.kind}`;
  const winner = view.players.find((p) => p.seat === result.winnerSeat);
  const rows = [...result.rankings].sort((a, b) => a.rank - b.rank);
  const deltaEls: { el: HTMLElement; to: number }[] = [];

  const table = h('div', { class: 'result-rows' },
    rows.map((r, i) => {
      const p = view.players.find((x) => x.seat === r.seat);
      const delta = h('span', { class: `result-delta ${r.chipsDelta > 0 ? 'pos' : r.chipsDelta < 0 ? 'neg' : ''}` }, '0');
      deltaEls.push({ el: delta, to: r.chipsDelta });
      return h('div', { class: `result-row rank-${r.rank} ${r.seat === view.you ? 'is-you' : ''}`, style: `--i:${i}` },
        h('span', { class: `rank-title title-${r.title.toLowerCase()}` }, tDyn(`title.${r.title}`, undefined, r.title)),
        portraitEl(p?.avatar ?? '', p?.name ?? '', 96, 'result-portrait'),
        h('div', { class: 'result-who' },
          h('div', { class: 'result-name' }, p?.name ?? `#${r.seat + 1}`, r.seat === view.you ? h('span', { class: 'tag tag-you' }, t('common.you')) : null),
          r.status === 'QUANCAN' || r.status === 'DEAD'
            ? h('span', { class: 'seat-status st-dead' }, t(`status.${r.status}`))
            : null,
        ),
        h('div', { class: 'result-tiles' }, r.tiles.length ? tileStrip(r.tiles, 'tiny') : h('span', { class: 'muted' }, t('result.emptied'))),
        h('div', { class: 'result-points' }, h('small', null, t('result.points')), String(r.points)),
        delta,
      );
    }),
  );

  const footer = h('div', { class: 'result-footer' });
  let countdownTimer: ReturnType<typeof setInterval> | null = null;

  const modal = openModal({
    className: `modal-result kind-${result.kind.toLowerCase()}`,
    dismissible: false,
    body: [
      h('div', { class: 'result-head' },
        h('div', { class: 'result-hand' }, t('result.handNo', { n: result.handNo })),
        h('div', { class: 'result-kind' }, tDyn(kindKey, undefined, result.kind)),
        winner ? h('div', { class: 'result-winner' }, t('result.winnerIs', { name: winner.name })) : null,
      ),
      table,
      footer,
    ],
    onClose: () => {
      if (countdownTimer) clearInterval(countdownTimer);
      opts.onClose?.();
    },
  });

  // count-up the chip deltas after the rows slide in
  setTimeout(() => deltaEls.forEach((d) => countUp(d.el, 0, d.to, 1100, signed)), 450);

  if (opts.onNext) {
    footer.appendChild(
      h('button', {
        class: 'btn btn-gold btn-lg',
        onclick: () => {
          opts.onNext?.();
          if (opts.final) modal.close();
        },
      }, opts.final ? t('result.toStandings') : t('result.next')),
    );
  }
  if (opts.autoMs && opts.autoMs > 0 && !opts.final) {
    const end = Date.now() + opts.autoMs;
    const label = h('span', { class: 'result-countdown' });
    footer.appendChild(label);
    const tick = (): void => {
      label.textContent = t('result.nextIn', { n: Math.max(0, Math.ceil((end - Date.now()) / 1000)) });
    };
    tick();
    countdownTimer = setInterval(tick, 250);
  }
  return modal;
}

export interface MatchEndOptions {
  /** absent: no rematch button (e.g. an online guest waits for the host); see waitingNote */
  onAgain?: () => void;
  onExit: () => void;
  againLabel?: string;
  /**
   * The rematch completes asynchronously (online host): keep the modal open, disable the
   * button and show a waiting label until the caller replaces the screen. The button is
   * re-enabled after a while in case the request failed.
   */
  againPending?: boolean;
  /** shown instead of the rematch button, e.g. "Waiting for host..." */
  waitingNote?: string;
}

/** How long a pending rematch button stays disabled before it can be retried. */
const AGAIN_RETRY_MS = 6000;

export function showMatchEnd(view: PlayerView, standings: MatchStanding[], opts: MatchEndOptions): ModalHandle {
  const sorted = [...standings].sort((a, b) => a.place - b.place);
  const avatarOf = (seat: number): string => view.players.find((p) => p.seat === seat)?.avatar ?? '';
  // podium order: 2nd, 1st, 3rd
  const podium = [sorted[1], sorted[0], sorted[2]].filter((s): s is MatchStanding => !!s);
  const start = view.cfg.startingChips;
  const youWon = sorted[0]?.seat === view.you;
  const againLabel = opts.againLabel ?? t('match.again');
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  const onAgainClick = (): void => {
    opts.onAgain?.();
    if (!opts.againPending) return;
    const btn = modal.el.querySelector<HTMLButtonElement>('.modal-actions .btn-gold');
    if (!btn) return;
    btn.disabled = true;
    btn.textContent = t('match.restarting');
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      btn.disabled = false;
      btn.textContent = againLabel;
    }, AGAIN_RETRY_MS);
  };
  const modal = openModal({
    className: 'modal-match-end',
    dismissible: false,
    body: [
      h('div', { class: 'match-head' },
        h('div', { class: 'match-title' }, t('match.over')),
        h('div', { class: 'match-sub' }, youWon ? t('match.youWin') : t('match.thanks')),
      ),
      h('div', { class: 'podium' },
        podium.map((s) =>
          h('div', { class: `podium-slot place-${s.place} ${s.seat === view.you ? 'is-you' : ''}` },
            portraitEl(avatarOf(s.seat), s.name, 192, 'podium-portrait'),
            h('div', { class: 'podium-name' }, s.name),
            h('div', { class: 'podium-chips' }, h('i', { class: 'coin', 'aria-hidden': 'true' }), String(s.chips)),
            h('div', { class: 'podium-delta' }, signed(s.chips - start)),
            h('div', { class: 'podium-block' }, h('span', null, t('match.place', { n: s.place }))),
          ),
        ),
      ),
      sorted.length > 3
        ? h('div', { class: 'standings-rest' },
            sorted.slice(3).map((s) =>
              h('div', { class: 'standing-row' },
                h('span', null, t('match.place', { n: s.place })),
                h('span', null, s.name),
                h('span', null, String(s.chips)),
              ),
            ),
          )
        : null,
      h('div', { class: 'standings-note muted' },
        sorted.map((s) => `${s.name}: ${t('match.totalPoints', { n: s.totalPoints })}`).join(' / '),
      ),
      !opts.onAgain && opts.waitingNote
        ? h('div', { class: 'match-waiting', role: 'status' }, h('span', { class: 'match-waiting-dot', 'aria-hidden': 'true' }), opts.waitingNote)
        : null,
    ],
    actions: [
      { label: t('match.backToTitle'), kind: 'ghost', onClick: opts.onExit },
      ...(opts.onAgain ? [{ label: againLabel, kind: 'gold' as const, onClick: onAgainClick, keepOpen: !!opts.againPending }] : []),
    ],
    onClose: () => {
      if (retryTimer) clearTimeout(retryTimer);
    },
  });
  return modal;
}
