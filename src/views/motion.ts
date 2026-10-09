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

// ── Lists that move instead of jumping ────────────────────────────────────────

/** A slight overshoot, like the views coming in. */
const SPRING = "cubic-bezier(0.3, 1.25, 0.4, 1)";

/** The island's zoom at `el`: screen pixels per CSS pixel. */
function zoomAt(el: HTMLElement): number {
  const r = el.getBoundingClientRect();
  return el.offsetHeight > 0 && r.height > 0 ? r.height / el.offsetHeight : 1;
}

/** Where each element is now, to slide it from there once the DOM has changed. */
export function measure(els: Iterable<HTMLElement>): Map<HTMLElement, number> {
  const tops = new Map<HTMLElement, number>();
  for (const el of els) if (el.isConnected) tops.set(el, el.getBoundingClientRect().top);
  return tops;
}

/** Slides each element from where `measure` saw it to where it is now (FLIP). */
export function slideFrom(tops: Map<HTMLElement, number>, duration = 320): void {
  for (const [el, top] of tops) {
    if (!el.isConnected) continue;
    const dy = (top - el.getBoundingClientRect().top) / zoomAt(el);
    if (Math.abs(dy) < 0.5) continue;
    el.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration, easing: SPRING });
  }
}

/** Comes in: from slightly above, small and clear, with a little overshoot. */
export function popIn(el: HTMLElement, delay = 0): void {
  el.animate(
    [
      { opacity: 0, transform: "translateY(-8px) scale(0.96)" },
      { opacity: 1, transform: "none" },
    ],
    { duration: 340, delay, easing: SPRING, fill: "backwards" },
  );
}

/** A quick swell, for a value that just changed (the timer's digits). */
export function bump(el: HTMLElement, scale = 1.08): void {
  el.animate(
    [{ transform: "scale(1)" }, { transform: `scale(${scale})`, offset: 0.35 }, { transform: "scale(1)" }],
    { duration: 380, easing: "ease-out" },
  );
}

/** New text rolls in from below (a fresh length on the timer). */
export function rollIn(el: HTMLElement): void {
  el.animate(
    [
      { opacity: 0, transform: "translateY(7px)" },
      { opacity: 1, transform: "none" },
    ],
    { duration: 260, easing: SPRING },
  );
}

/** Restarts a CSS animation class on `el` (a flash). */
export function flash(el: HTMLElement, cls = "flash"): void {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

/**
 * Leaves the list: taken out of the flow where it stands (so the others can
 * slide into its room), then gone — sideways when deleted, upwards after a
 * beat when done. Removed even if frames stop coming.
 */
export function leave(el: HTMLElement, how: "delete" | "done" = "delete"): void {
  const parent = el.parentElement;
  if (!parent) return;
  const top = el.offsetTop;
  const width = el.offsetWidth;
  el.style.position = "absolute";
  el.style.top = `${top}px`;
  el.style.left = `${el.offsetLeft}px`;
  el.style.width = `${width}px`;
  el.style.pointerEvents = "none";
  const frames =
    how === "done"
      ? [
          { opacity: 1, transform: "none" },
          { opacity: 1, transform: "scale(1.02)", offset: 0.35 },
          { opacity: 0, transform: "translateY(-10px) scale(0.96)" },
        ]
      : [
          { opacity: 1, transform: "none" },
          { opacity: 0, transform: "translateX(36px)" },
        ];
  const duration = how === "done" ? 620 : 240;
  const anim = el.animate(frames, { duration, easing: "ease-in", fill: "forwards" });
  const gone = () => el.remove();
  anim.onfinish = gone;
  window.setTimeout(gone, duration + 200);
}
