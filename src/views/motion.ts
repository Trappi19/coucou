// Little entrance motions for the cards, in the spirit of the chat's words that
// fade in one by one: numbers that count up to their value, and pieces that
// come in one after the other. Only used when a card comes on screen — a card
// redrawn with fresh numbers in the background stays still.

/** easeOutCubic: quick at first, settling gently, like the island's springs. */
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

/**
 * Counts `el` up from 0 to `to`, written by `format` at each step. Lands on
 * the exact text even if frames stop coming (a hidden webview throttles them).
 * Returns a stop function, for when something else takes over the text.
 */
export function countUp(
  el: HTMLElement,
  to: number,
  format: (n: number) => string,
  { delay = 0, duration = 700 }: { delay?: number; duration?: number } = {},
): () => void {
  if (!Number.isFinite(to) || to <= 0) {
    el.textContent = format(Math.max(0, to || 0));
    return () => {};
  }
  let stopped = false;
  el.textContent = format(0);
  const start = performance.now() + delay;
  const step = (now: number) => {
    if (stopped || !el.isConnected) return;
    const t = Math.min(1, Math.max(0, (now - start) / duration));
    el.textContent = format(Math.round(to * easeOut(t)));
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  const land = window.setTimeout(() => {
    if (!stopped && el.isConnected) el.textContent = format(to);
  }, delay + duration + 200);
  return () => {
    stopped = true;
    window.clearTimeout(land);
  };
}

/** New text that fades in instead of just appearing (the activity header). */
export function swapText(el: HTMLElement, text: string): void {
  if (el.textContent === text) return;
  el.textContent = text;
  el.classList.remove("swap");
  // Reading a layout property restarts the animation on the same element.
  void el.offsetWidth;
  el.classList.add("swap");
}

/** The `index`-th of a series comes in `gap` ms after the previous one. */
export function staggered<T extends HTMLElement | SVGElement>(el: T, index: number, gap = 45, base = 0): T {
  el.style.animationDelay = `${base + index * gap}ms`;
  return el;
}
