/**
 * Source model of each bundled character (mirrors CREDITS.md; keyed by catalog id).
 * The catalog keeps only persona names, so the model/author/license live here.
 */
export const MODEL_SOURCES: Record<string, string> = {
  mei: 'three-vrm-girl - pixiv Inc. (VRoid Hub: redistribution allowed, credit unnecessary)',
  kaya: 'VRM1_Constraint_Twist_Sample - pixiv Inc. (VRM Public License 1.0)',
  pandan: 'AvatarSample_E (Bibi) - VRoid Project / pixiv Inc. (CC0)',
  lingling: 'Sendagaya Shino - VRoid Project / pixiv Inc. (CC0)',
  rambutan: 'AvatarSample_F (Vita) - VRoid Project / pixiv Inc. (CC0)',
};
