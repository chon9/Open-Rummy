/**
 * Rule options panel (RULES.md §12): presets + the main toggles. The value is kept
 * as a minimal Partial<RulesConfig> diff against DEFAULT_RULES so saved prefs stay
 * small and new defaults apply automatically.
 */
import { DEFAULT_RULES, PENANG_CLASSIC, type RulesConfig } from '@open-rummy/shared';
import { h } from './dom';
import { segmented } from './screen';
import { sound } from './sound';
import { t, type I18nKey } from '../i18n';

type Key = keyof RulesConfig;

interface OptionDef {
  key: Key;
  label: I18nKey;
  values: { value: unknown; label: I18nKey | string }[];
  /** only relevant online (timers) */
  onlineOnly?: boolean;
}

const ON_OFF = [
  { value: true, label: 'common.on' as I18nKey },
  { value: false, label: 'common.off' as I18nKey },
];

const OPTIONS: OptionDef[] = [
  { key: 'players', label: 'rule.players', values: [3, 4, 5].map((n) => ({ value: n, label: String(n) })) },
  { key: 'handsPerMatch', label: 'rule.handsPerMatch', values: [
    { value: undefined, label: 'rule.auto' },
    ...[4, 8, 12, 16].map((n) => ({ value: n, label: String(n) })),
  ] },
  { key: 'setAllowedAsPort', label: 'rule.setAllowedAsPort', values: ON_OFF },
  { key: 'portTiming', label: 'rule.portTiming', values: [
    { value: 'simultaneous', label: 'rule.portTiming.simultaneous' },
    { value: 'sequential', label: 'rule.portTiming.sequential' },
  ] },
  { key: 'cutOnlyWhenCannotExtend', label: 'rule.cutOnlyWhenCannotExtend', values: [
    { value: true, label: 'rule.cut.onlyWhenStuck' },
    { value: false, label: 'rule.cut.anyTime' },
  ] },
  { key: 'newRunsAfterPort', label: 'rule.newRunsAfterPort', values: ON_OFF },
  { key: 'unlimitedActions', label: 'rule.unlimitedActions', values: [
    { value: false, label: 'rule.actions.one' },
    { value: true, label: 'rule.actions.many' },
  ] },
  { key: 'jokerSwap', label: 'rule.jokerSwap', values: [
    { value: 'off', label: 'common.off' },
    { value: 'keep', label: 'rule.jokerSwap.keep' },
    { value: 'useSameTurn', label: 'rule.jokerSwap.useSameTurn' },
  ] },
  { key: 'jokers', label: 'rule.jokers', values: [6, 8, 12].map((n) => ({ value: n, label: String(n) })) },
  { key: 'minNaturalsInNewMeld', label: 'rule.minNaturals', values: [1, 2].map((n) => ({ value: n, label: String(n) })) },
  { key: 'aceHigh', label: 'rule.aceHigh', values: ON_OFF },
  { key: 'instantWins', label: 'rule.instantWins', values: ON_OFF },
  { key: 'setPriority', label: 'rule.setPriority', values: ON_OFF },
  { key: 'setCapFourDistinct', label: 'rule.setCap', values: ON_OFF },
  { key: 'dealerRotation', label: 'rule.dealerRotation', values: [
    { value: 'next', label: 'rule.dealer.next' },
    { value: 'winner', label: 'rule.dealer.winner' },
  ] },
  { key: 'turnTimerMs', label: 'rule.turnTimer', onlineOnly: true, values: [15000, 20000, 30000, 45000].map((ms) => ({ value: ms, label: `${ms / 1000}s` })) },
];

function labelOf(l: I18nKey | string): string {
  return /^(common|rule)\./.test(l) ? t(l as I18nKey) : l;
}

/** Remove keys equal to the default so the diff stays minimal. */
export function normalizeRules(p: Partial<RulesConfig>): Partial<RulesConfig> {
  const out: Partial<RulesConfig> = {};
  for (const [k, v] of Object.entries(p) as [Key, unknown][]) {
    if (v === undefined) continue;
    if (JSON.stringify(v) === JSON.stringify(DEFAULT_RULES[k])) continue;
    (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

export function rulesOptionsPanel(
  initial: Partial<RulesConfig>,
  onChange: (p: Partial<RulesConfig>) => void,
  opts: { online: boolean },
): HTMLElement {
  let value: Partial<RulesConfig> = normalizeRules(initial);
  const rows = h('div', { class: 'rule-rows' });
  const presetRow = h('div', { class: 'preset-row' });

  const isPreset = (p: Partial<RulesConfig>): boolean =>
    JSON.stringify(normalizeRules(p)) === JSON.stringify(normalizeRules(value));

  const presets: { label: string; value: Partial<RulesConfig> }[] = [
    { label: t('rule.preset.cariMakan'), value: {} },
    { label: t('rule.preset.penang'), value: { ...PENANG_CLASSIC } },
  ];

  const renderPresets = (): void => {
    presetRow.replaceChildren(
      h('span', { class: 'muted' }, t('rule.presets')),
      ...presets.map((p) =>
        h('button', {
          class: `chip-btn ${isPreset(p.value) ? 'on' : ''}`,
          'aria-pressed': String(isPreset(p.value)),
          onclick: () => {
            sound.click();
            value = normalizeRules(p.value);
            onChange(value);
            render();
          },
        }, p.label),
      ),
    );
  };

  const render = (): void => {
    renderPresets();
    rows.replaceChildren(
      ...OPTIONS.filter((o) => opts.online || !o.onlineOnly).map((o) => {
        const current = o.key in value ? value[o.key] : o.key === 'handsPerMatch' ? undefined : DEFAULT_RULES[o.key];
        const control = segmented(
          o.values.map((v) => ({ value: v.value, label: labelOf(v.label) })),
          o.values.find((v) => JSON.stringify(v.value) === JSON.stringify(current))?.value ?? current,
          (picked) => {
            const next: Partial<RulesConfig> = { ...value };
            if (picked === undefined) delete next[o.key];
            else (next as Record<string, unknown>)[o.key] = picked;
            value = normalizeRules(next);
            onChange(value);
            renderPresets();
          },
          t(o.label),
        );
        return h('div', { class: 'rule-row' }, h('span', { class: 'rule-label' }, t(o.label)), control);
      }),
    );
  };
  render();
  return h('div', { class: 'rules-options' }, presetRow, rows);
}

/** Short human summary of non-default rules (for the room view). */
export function rulesSummary(cfg: RulesConfig): string[] {
  const out: string[] = [t('rule.summary.players', { n: cfg.players }), t('rule.summary.hands', { n: cfg.handsPerMatch })];
  for (const o of OPTIONS) {
    if (o.key === 'players' || o.key === 'handsPerMatch') continue;
    const v = cfg[o.key];
    if (JSON.stringify(v) === JSON.stringify(DEFAULT_RULES[o.key])) continue;
    const val = o.values.find((x) => JSON.stringify(x.value) === JSON.stringify(v));
    out.push(`${t(o.label)}: ${val ? labelOf(val.label) : String(v)}`);
  }
  return out;
}
