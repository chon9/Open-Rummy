/**
 * Tile art contract. The 3D scene uses canvas textures for tile faces; the DOM hand
 * uses the same art as image URLs so the look is consistent.
 * Implementation: src/art/tileArt.ts (procedural canvas drawing, no external assets).
 */
export interface TileArt {
  /** draw the face of tile `id` into a canvas of the given size (ivory face, coloured suit + rank) */
  drawFace(ctx: CanvasRenderingContext2D, id: string, w: number, h: number): void;
  /** cached data/blob URL of the face image for DOM use */
  faceUrl(id: string): string;
  /** back of tile (for opponents' hands / dead wall) */
  backUrl(): string;
}
