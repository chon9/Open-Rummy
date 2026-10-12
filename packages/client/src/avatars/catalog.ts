/**
 * Bundled characters (public/avatars). Licenses: see docs/ARCHITECTURE.md.
 * Persona names are our own; the models keep their original licenses/credits.
 */
import type { AvatarDef } from '../scene/api';

const base = (import.meta.env?.BASE_URL ?? '/').replace(/\/?$/, '/');

export const AVATARS: AvatarDef[] = [
  {
    id: 'mei',
    url: `${base}avatars/vrm-girl.vrm`,
    nameZh: '美美',
    nameEn: 'Mei Mei',
    taglineZh: '槟城甜心，最爱接长龙！',
    taglineEn: 'Penang sweetheart who lives for a long run!',
    credit: '',
    color: '#ff6f9d',
  },
  {
    id: 'kaya',
    url: `${base}avatars/twist.vrm`,
    nameZh: '咖椰',
    nameEn: 'Kaya',
    taglineZh: '笑得甜甜，斩得狠狠。',
    taglineEn: 'Sweet smile, sharp cuts.',
    credit: '',
    color: '#f2a93b',
  },
  {
    id: 'pandan',
    url: `${base}avatars/sample-e.vrm`,
    nameZh: '班兰',
    nameEn: 'Pandan',
    taglineZh: '清新像班兰蛋糕，冷静像一杯Kopi-O。',
    taglineEn: 'Fresh as pandan cake, cool as a kopi-o.',
    credit: '',
    color: '#35b56a',
  },
  {
    id: 'lingling',
    url: `${base}avatars/shino.vrm`,
    nameZh: '玲玲',
    nameEn: 'Ling Ling',
    taglineZh: '怡保白咖啡上瘾，每一张牌都算得清清楚楚。',
    taglineEn: 'Ipoh white-coffee addict who counts every tile.',
    credit: '',
    color: '#5f86ff',
  },
  {
    id: 'rambutan',
    url: `${base}avatars/sample-f.vrm`,
    nameZh: '红毛丹',
    nameEn: 'Rambutan',
    taglineZh: '外表带刺，赢的时候最甜。Huat ah！',
    taglineEn: 'Spiky outside, sweetest when she wins. Huat ah!',
    credit: '',
    color: '#e5484d',
  },
];

const byId = new Map(AVATARS.map((a) => [a.id, a]));

/**
 * Look up an avatar. Unknown ids (old clients, bots with arbitrary ids) map to a
 * stable pick from the catalog so the same id always gets the same character.
 */
export function avatarById(id: string): AvatarDef {
  const hit = byId.get(id);
  if (hit) return hit;
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return AVATARS[h % AVATARS.length];
}
