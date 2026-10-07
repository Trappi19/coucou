// Island size picked by the user: one zoom factor for compact, one for open.
// The island is drawn at its original size and scaled as a whole, so every
// view keeps its layout and the shape stays centred under the top edge.

export const SCALE_MIN = 0.75;
export const SCALE_MAX = 1.5;
export const SCALE_DEFAULT = 1;

/** Within this of 100 %, a drag lands exactly on the original size. */
const SNAP = 0.03;

export function clampScale(s: number): number {
  if (!Number.isFinite(s)) return SCALE_DEFAULT;
  const c = Math.min(SCALE_MAX, Math.max(SCALE_MIN, s));
  return Math.abs(c - SCALE_DEFAULT) < SNAP ? SCALE_DEFAULT : Math.round(c * 100) / 100;
}

let renderScale = 1;

/** The largest scale on screen, so canvases are drawn with enough pixels to stay sharp. */
export function setRenderScale(s: number) {
  renderScale = Math.max(1, s);
}

/** Backing-store pixels per CSS pixel for every canvas in the island. */
export function canvasDpr(): number {
  return Math.min(3, (window.devicePixelRatio || 1) * renderScale);
}
