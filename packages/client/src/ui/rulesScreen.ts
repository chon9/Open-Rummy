/**
 * Rules reference: a concise bilingual summary of docs/RULES.md with tile images,
 * plus the glossary (RULES.md §14). Usable as a full screen or inside a modal.
 */
import { h } from './dom';
import { screenHeader, type Screen } from './screen';
import { tileStrip } from './tileView';
import { openModal, type ModalHandle } from './modal';
import { t, type I18nKey } from '../i18n';

interface Section {
  title: I18nKey;
  body: I18nKey[];
  /** example tile groups */
  tiles?: string[][];
}

const SECTIONS: Section[] = [
  { title: 'rules.tiles.title', body: ['rules.tiles.b1', 'rules.tiles.b2'], tiles: [['BA_1', 'R10_1', 'Y7_1', 'GK_1'], ['JK_1', 'JK_3']] },
  { title: 'rules.goal.title', body: ['rules.goal.b1', 'rules.goal.b2'] },
  { title: 'rules.instant.title', body: ['rules.instant.b1', 'rules.instant.b2'], tiles: [['B9_1', 'R9_1', 'Y9_1', 'G9_1', 'B9_2', 'R9_2', 'Y9_2']] },
  { title: 'rules.port.title', body: ['rules.port.b1', 'rules.port.b2', 'rules.port.b3'], tiles: [['R3_1', 'R4_1', 'JK_2', 'R6_1'], ['GQ_1', 'GK_1', 'GA_1']] },
  { title: 'rules.extend.title', body: ['rules.extend.b1'], tiles: [['Y4_1'], ['Y5_1', 'Y6_1', 'Y7_1'], ['Y8_2', 'Y9_1']] },
  { title: 'rules.cut.title', body: ['rules.cut.b1', 'rules.cut.b2'], tiles: [['B8_1', 'R8_1', 'Y8_2']] },
  { title: 'rules.follow.title', body: ['rules.follow.b1'], tiles: [['B8_1', 'R8_1', 'Y8_2'], ['G8_1']] },
  { title: 'rules.swap.title', body: ['rules.swap.b1'], tiles: [['B5_1', 'JK_4', 'B7_1'], ['B6_2']] },
  { title: 'rules.dead.title', body: ['rules.dead.b1', 'rules.dead.b2'] },
  { title: 'rules.scoring.title', body: ['rules.scoring.b1', 'rules.scoring.b2'], tiles: [['RA_1'], ['B10_1', 'GJ_1', 'YQ_1', 'RK_1'], ['G2_1', 'B9_1'], ['JK_5']] },
  { title: 'rules.payout.title', body: ['rules.payout.b1', 'rules.payout.b2', 'rules.payout.b3'] },
  { title: 'rules.ranks.title', body: ['rules.ranks.b1'] },
];

const GLOSSARY: { zh: string; en: I18nKey; def: I18nKey }[] = [
  { zh: '庄家', en: 'gloss.dealer', def: 'glossDef.dealer' },
  { zh: '下家 / 上家 / 对家', en: 'gloss.seats', def: 'glossDef.seats' },
  { zh: '开牌', en: 'gloss.port', def: 'glossDef.port' },
  { zh: '顺子', en: 'gloss.run', def: 'glossDef.run' },
  { zh: '接牌 / 接龙', en: 'gloss.extend', def: 'glossDef.extend' },
  { zh: '斩', en: 'gloss.cut', def: 'glossDef.cut' },
  { zh: '跟斩', en: 'gloss.follow', def: 'glossDef.follow' },
  { zh: 'Joker / 鬼牌', en: 'gloss.joker', def: 'glossDef.joker' },
  { zh: '换Joker', en: 'gloss.swap', def: 'glossDef.swap' },
  { zh: '盖牌', en: 'gloss.dead', def: 'glossDef.dead' },
  { zh: '全餐', en: 'gloss.quancan', def: 'glossDef.quancan' },
  { zh: 'Game牌', en: 'gloss.game', def: 'glossDef.game' },
  { zh: '天糊', en: 'gloss.tianhu', def: 'glossDef.tianhu' },
  { zh: '赢家', en: 'gloss.winner', def: 'glossDef.winner' },
  { zh: '小哥 / 二哥 / 大哥', en: 'gloss.ranks', def: 'glossDef.ranks' },
  { zh: '点数', en: 'gloss.points', def: 'glossDef.points' },
  { zh: '筹码', en: 'gloss.chips', def: 'glossDef.chips' },
  { zh: '栋', en: 'gloss.stack', def: 'glossDef.stack' },
  { zh: '牌墙', en: 'gloss.wall', def: 'glossDef.wall' },
  { zh: '骰子', en: 'gloss.dice', def: 'glossDef.dice' },
];

export function rulesContent(): HTMLElement {
  return h('div', { class: 'rules-doc' },
    h('p', { class: 'rules-intro' }, t('rules.intro')),
    h('div', { class: 'rules-sections' },
      SECTIONS.map((s, i) =>
        h('section', { class: 'rules-card', style: `--i:${i}` },
          h('h3', null, t(s.title)),
          s.body.map((b) => h('p', null, t(b))),
          s.tiles ? h('div', { class: 'rules-tiles' }, s.tiles.map((g) => tileStrip(g))) : null,
        ),
      ),
    ),
    h('h3', { class: 'gloss-title' }, t('rules.glossary')),
    h('table', { class: 'gloss' },
      h('thead', null, h('tr', null, h('th', null, '中文'), h('th', null, 'English'), h('th', null, t('rules.meaning')))),
      h('tbody', null, GLOSSARY.map((g) => h('tr', null, h('td', null, g.zh), h('td', null, t(g.en)), h('td', null, t(g.def))))),
    ),
    h('p', { class: 'muted rules-source' }, t('credits.rulesSource')),
  );
}

export function rulesScreen(onBack: () => void): Screen {
  return { el: h('div', { class: 'screen doc-screen' }, screenHeader(t('menu.rules'), onBack), h('div', { class: 'doc-body panel' }, rulesContent())) };
}

export function openRulesModal(): ModalHandle {
  return openModal({ title: t('menu.rules'), body: rulesContent(), className: 'modal-wide' });
}
