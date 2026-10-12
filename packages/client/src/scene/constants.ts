/**
 * Scene dimensions in metres (real-world scale so VRM avatars fit naturally).
 * Table space: origin at the centre of the felt surface, +Y up, the local player's
 * seat (camera) toward +Z, their right-hand neighbour (下家) toward +X.
 */

/** height of the felt above the floor */
export const TABLE_Y = 0.68;
/** half extent of the square felt */
export const TABLE_HALF = 0.56;
export const RIM_WIDTH = 0.07;
export const RIM_HEIGHT = 0.035;

/** tile body: width (x), face height (y), thickness (z) */
export const TILE_W = 0.03;
export const TILE_H = 0.04;
export const TILE_D = 0.021;
export const TILE_RADIUS = 0.0026;
/** gap between neighbouring tiles in a row */
export const TILE_GAP = 0.0012;

/** distance of an opponent's standing rack from the table centre */
export const RACK_DIST = 0.455;
/** max rack length before tiles are scaled down to fit */
export const RACK_MAX_LEN = 0.64;
/** distance of seated avatars (their hips) from the table centre */
export const AVATAR_DIST = 0.84;
/** chair seat height; avatar hips are placed just above it */
export const SEAT_HIP_Y = 0.6;

/**
 * Area of the felt used for table melds. The near edge stops short of the camera side:
 * the DOM action bar and hand tray cover the bottom of the screen.
 */
export const MELD_AREA = { minX: -0.4, maxX: 0.4, minZ: -0.37, maxZ: 0.31 };
/**
 * Table melds are drawn larger than life so faces stay readable from the camera; the
 * layout picks the largest scale in this range that fits everything.
 */
export const MELD_MAX_SCALE = 2.45;
export const MELD_MIN_SCALE = 1.0;
/** meld tiles lean back from flat by this angle (radians) so their faces turn toward the camera */
export const MELD_TILT = 0.42;

/** where the local player's tiles appear from / vanish to (bottom of the screen) */
export const OWN_ORIGIN = { x: 0, y: 0.16, z: 0.68 };

export const COLOURS_3D = {
  felt: '#0f5a52',
  feltDeep: '#073a35',
  gold: '#f3c461',
  turn: '#ffd27a',
  dead: '#8a8f96',
  background: '#1c110c',
};
