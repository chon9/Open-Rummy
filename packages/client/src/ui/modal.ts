/**
 * Modal dialogs: generic panel modal plus a promise-based choice picker.
 */
import { h, icon, ICONS, type Child } from './dom';
import { t } from '../i18n';
import { sound } from './sound';

export interface ModalAction {
  label: string;
  kind?: 'gold' | 'teal' | 'ghost' | 'danger';
  onClick: () => void;
  /** keep the modal open after click */
  keepOpen?: boolean;
  disabled?: boolean;
}

export interface ModalOptions {
  title?: string;
  body: Child;
  actions?: ModalAction[];
  /** close on Escape / backdrop / close button (default true) */
  dismissible?: boolean;
  className?: string;
  onClose?: () => void;
}

export interface ModalHandle {
  el: HTMLElement;
  close(): void;
}

const open = new Set<ModalHandle>();

export function openModal(opts: ModalOptions): ModalHandle {
  const dismissible = opts.dismissible !== false;
  const prevFocus = document.activeElement as HTMLElement | null;
  let closed = false;

  const close = (): void => {
    if (closed) return;
    closed = true;
    open.delete(handle);
    document.removeEventListener('keydown', onKey);
    backdrop.classList.add('out');
    setTimeout(() => backdrop.remove(), 220);
    opts.onClose?.();
    prevFocus?.focus?.();
  };

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && dismissible) close();
  };

  const panel = h('div', { class: `modal panel ${opts.className ?? ''}`, role: 'dialog', 'aria-modal': 'true' },
    opts.title ? h('h2', { class: 'modal-title' }, opts.title) : null,
    dismissible
      ? h('button', { class: 'icon-btn modal-close', 'aria-label': t('common.close'), onclick: () => { sound.click(); close(); } }, icon(ICONS.close))
      : null,
    h('div', { class: 'modal-body' }, opts.body),
    opts.actions?.length
      ? h('div', { class: 'modal-actions' },
          opts.actions.map((a) =>
            h('button', {
              class: `btn btn-${a.kind ?? 'gold'}`,
              disabled: a.disabled,
              onclick: () => {
                sound.click();
                a.onClick();
                if (!a.keepOpen) close();
              },
            }, a.label),
          ),
        )
      : null,
  );
  const backdrop = h('div', {
    class: 'modal-backdrop',
    onclick: (e: MouseEvent) => {
      if (dismissible && e.target === backdrop) close();
    },
  }, panel);
  document.body.appendChild(backdrop);
  document.addEventListener('keydown', onKey);
  const handle: ModalHandle = { el: panel, close };
  open.add(handle);
  // focus the primary action (or the first focusable element) for keyboard users
  requestAnimationFrame(() => {
    const target = panel.querySelector<HTMLElement>('.modal-actions .btn, button, input, select');
    target?.focus();
  });
  return handle;
}

export function closeAllModals(): void {
  for (const m of Array.from(open)) m.close();
}

export interface Choice<T> {
  label: Child;
  value: T;
}

/**
 * Ask the player to pick one option; resolves null when dismissed. Aborting `signal`
 * closes the picker (resolving null), e.g. when the decision it belongs to is stale.
 */
export function choose<T>(title: string, options: Choice<T>[], hint?: string, signal?: AbortSignal): Promise<T | null> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(null);
      return;
    }
    let done = false;
    const finish = (v: T | null): void => {
      if (done) return;
      done = true;
      resolve(v);
    };
    const m = openModal({
      title,
      className: 'modal-choice',
      body: h('div', { class: 'choice-list' },
        hint ? h('p', { class: 'muted' }, hint) : null,
        options.map((o) =>
          h('button', {
            class: 'choice',
            onclick: () => {
              sound.click();
              finish(o.value);
              m.close();
            },
          }, o.label),
        ),
      ),
      actions: [{ label: t('common.cancel'), kind: 'ghost', onClick: () => finish(null) }],
      onClose: () => {
        signal?.removeEventListener('abort', onAbort);
        finish(null);
      },
    });
    const onAbort = (): void => m.close();
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
