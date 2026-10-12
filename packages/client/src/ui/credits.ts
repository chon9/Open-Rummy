/**
 * Credits: character model licenses (from the avatar catalog), libraries, rules source.
 */
import { AVATARS } from '../avatars/catalog';
import { MODEL_SOURCES } from './modelSources';
import { h } from './dom';
import { screenHeader, type Screen } from './screen';
import { pick, t } from '../i18n';

const LIBRARIES: { name: string; note: string }[] = [
  { name: 'three.js', note: 'MIT License, Copyright 2010-2025 three.js authors' },
  { name: '@pixiv/three-vrm', note: 'MIT License, Copyright (c) 2019-2025 pixiv Inc.' },
  // GSAP is not MIT: it ships under GreenSock's own free "Standard No Charge" license.
  { name: 'GSAP', note: 'GreenSock "Standard No Charge" License (free to use), Copyright GreenSock / Webflow' },
];

export function creditsScreen(onBack: () => void): Screen {
  const models = AVATARS.map((a) => {
    const source = a.credit || MODEL_SOURCES[a.id];
    return h('li', null,
      h('b', null, pick(a.nameZh, a.nameEn)),
      source ? h('span', null, ' - ', source) : null,
      a.credit ? null : h('span', { class: 'muted' }, ' - ', t('credits.noCreditRequired')),
    );
  });
  const el = h('div', { class: 'screen doc-screen credits-screen' },
    screenHeader(t('menu.credits'), onBack),
    h('div', { class: 'doc-body panel' },
      h('div', { class: 'credits-logo' }, h('div', { class: 'logo-zh small', 'data-text': '拉米麻将' }, '拉米麻将'), h('div', { class: 'logo-en' }, 'Open Rummy')),
      h('section', { class: 'credits-block' },
        h('h3', null, t('credits.models')),
        h('p', null, 'Character models: VRoid Project (CC0) and pixiv Inc. All bundled models allow redistribution; none requires attribution.'),
        h('ul', null, models),
      ),
      h('section', { class: 'credits-block' },
        h('h3', null, t('credits.libraries')),
        h('ul', null, LIBRARIES.map((l) => h('li', null, h('b', null, l.name), ' - ', l.note))),
      ),
      h('section', { class: 'credits-block' },
        h('h3', null, t('credits.rules')),
        h('p', null, 'Rules adapted from Cari Makan 揾到食 rule cards'),
        h('p', { class: 'muted' }, t('credits.rulesExtra')),
      ),
      h('section', { class: 'credits-block' },
        h('h3', null, t('credits.art')),
        h('p', null, t('credits.artBody')),
      ),
      h('p', { class: 'muted credits-foot' }, t('credits.fanProject')),
    ),
  );
  return { el };
}
