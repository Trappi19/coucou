// Resize mode: handles on the island's edges and a bar under it to pick which
// size is being set (open or compact), go back to the original size, cancel or
// keep it. The island itself holds still meanwhile; only Mochi keeps living.

import { SCALE_DEFAULT, clampScale } from "../core/scale";
import { State } from "../core/state";
import { h, svg } from "../views/dom";
import { ICONS } from "../views/icons";

export type ResizeTarget = "compact" | "expanded";

export interface ResizeHost {
  setTarget(target: ResizeTarget): void;
  /** One of State.resizeScales changed: animate the island to it. */
  preview(): void;
  cancel(): void;
  confirm(): void;
  /** Unscaled size of the island being sized. */
  baseSize(): { w: number; h: number };
}

type Edge = "left" | "right" | "bottom";

export class ResizeController {
  readonly bar: HTMLElement;
  readonly handles: HTMLElement[];

  private pct: HTMLElement;
  private segOpen: HTMLElement;
  private segSmall: HTMLElement;
  private bottom: HTMLElement;

  constructor(private host: ResizeHost) {
    this.segOpen = h("button", { text: "Open", onclick: () => host.setTarget("expanded") });
    this.segSmall = h("button", { text: "Small", onclick: () => host.setTarget("compact") });
    this.pct = h("span", { class: "rs-pct" });
    this.bar = h(
      "div",
      { id: "resize-bar" },
      h("div", { class: "rs-seg" }, this.segOpen, this.segSmall),
      this.pct,
      h("button", {
        class: "rs-reset",
        text: "Default",
        title: "Back to the original size, open and small",
        onclick: () => {
          State.resizeScales = { compact: SCALE_DEFAULT, expanded: SCALE_DEFAULT };
          host.preview();
        },
      }),
      h("button", { class: "rs-icon cancel", title: "Cancel (Esc)", onclick: () => host.cancel() },
        svg(ICONS.xmark, 11)),
      h("button", { class: "rs-icon ok", title: "Keep this size", onclick: () => host.confirm() },
        svg(ICONS.check, 13, { stroke: 2.8 })),
    );

    const left = this.handle("left");
    const right = this.handle("right");
    this.bottom = this.handle("bottom");
    this.handles = [left, right, this.bottom];
  }

  /** Both sides move together: dragging one edge by d grows the island by 2d. */
  private handle(edge: Edge): HTMLElement {
    const el = h("div", { class: `rs-handle ${edge}` });
    // The island takes mousedown for itself (open, slap Mochi): not this one.
    el.addEventListener("mousedown", (e) => e.stopPropagation());
    el.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      // Keeps the drag going when the cursor leaves the thin handle.
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        // Pointer already gone: the drag simply ends on the first move.
      }
      el.classList.add("dragging");
      const target = State.resizeTarget;
      const start = { x: e.clientX, y: e.clientY, scale: State.resizeScales[target] };
      const base = this.host.baseSize();

      const move = (ev: PointerEvent) => {
        const dx = ev.clientX - start.x;
        const dy = ev.clientY - start.y;
        const grown =
          edge === "right" ? start.scale + (2 * dx) / base.w
          : edge === "left" ? start.scale - (2 * dx) / base.w
          : start.scale + dy / base.h;
        const next = clampScale(grown);
        if (next === State.resizeScales[target]) return;
        State.resizeScales[target] = next;
        this.host.preview();
      };
      const up = () => {
        el.classList.remove("dragging");
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", up);
        el.removeEventListener("pointercancel", up);
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
      el.addEventListener("pointercancel", up);
    });
    return el;
  }

  sync() {
    const on = State.resizing;
    this.bar.classList.toggle("on", on);
    for (const handle of this.handles) handle.classList.toggle("on", on);
    if (!on) return;
    const target = State.resizeTarget;
    this.segOpen.classList.toggle("on", target === "expanded");
    this.segSmall.classList.toggle("on", target === "compact");
    // 32 px tall: the bottom edge would be far too touchy on the small island.
    this.bottom.classList.toggle("on", target === "expanded");
    this.pct.textContent = `${Math.round(State.resizeScales[target] * 100)} %`;
  }

  /** Keeps the bar just under the island as it grows and shrinks. */
  place(islandBottom: number) {
    this.bar.style.top = `${Math.round(islandBottom + 12)}px`;
  }

  /** Where the bar is, in window coordinates, so it can take clicks. */
  rect(): { x: number; y: number; w: number; h: number } | null {
    if (!State.resizing) return null;
    const r = this.bar.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  }
}
