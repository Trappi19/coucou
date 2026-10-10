// The stopwatch tab: start, lap, pause, reset. The big digits run with the
// hundredths while the card is on screen; laps stack up underneath, newest on
// top, the fastest in green and the slowest in red once there are three. The
// island grows with them, like the chat with its messages.

import { h, svg, clear } from "./dom";
import { ICONS } from "./icons";
import { Stopwatch, chronoText, formatChrono, type StopwatchPhase } from "../core/stopwatch";
import { viewHeights } from "../core/layout";
import { timeSwitch } from "./reminders";
import { bump, flash, popIn, rollIn } from "./motion";
import type { ViewActions, ViewHost } from "./views";

/** Laps visible before the list scrolls. */
const LAPS_SHOWN = 4;
const LAP_ROW_H = 24;

function btn(label: string, kind: "primary" | "secondary", onClick: () => void, icon?: SVGSVGElement): HTMLElement {
  return h("button", { class: `btn ${kind} tm-btn`, onclick: onClick }, icon ?? null, h("span", { text: label }));
}

export function buildStopwatch(actions: ViewActions, onHeightChange: () => void): ViewHost {
  const heading = h("div", { class: "tm-heading", text: "Stopwatch" });
  const main = h("span");
  const fraction = h("span", { class: "sw-fraction" });
  const digits = h("div", { class: "sw-digits" }, main, fraction);
  const lapLine = h("div", { class: "sw-lapline" });
  const row = h("div", { class: "tm-actions" });
  const laps = h("div", { class: "sw-laps" });
  const left = h("div", { class: "tm-left" }, heading, digits, lapLine);
  const right = h("div", { class: "tm-right" }, row);
  const card = h(
    "div",
    { class: "card wash tm-card sw-card" },
    h("div", { class: "sw-body" }, h("div", { class: "sw-main" }, left, right), laps),
    timeSwitch(actions, "stopwatch"),
  );
  card.style.setProperty("--wash", "rgba(56,189,248,0.14)");
  const el = h("div", { class: "view" }, card);

  // Taller with each lap, up to LAPS_SHOWN rows; then the list scrolls.
  viewHeights.stopwatch = () =>
    160 + (Stopwatch.laps.length ? 18 + Math.min(Stopwatch.laps.length, LAPS_SHOWN) * LAP_ROW_H : 0);

  let phaseKey: StopwatchPhase | "" = "";
  let lapCount = -1;
  let visible = false;
  let raf = 0;
  /** What the digits do at the next draw. */
  let motion: "pop" | "roll" | null = null;

  // ── The running digits ───────────────────────────────────────────────────

  function paint(now = Date.now()) {
    const { main: m, fraction: f } = formatChrono(Stopwatch.elapsed(now));
    if (main.textContent !== m) main.textContent = m;
    fraction.textContent = f;
    lapLine.textContent = Stopwatch.laps.length
      ? `Lap ${Stopwatch.laps.length + 1} · ${chronoText(Stopwatch.currentLap(now))}`
      : "";
  }

  /** Runs only while the card is on screen and the stopwatch is going. */
  function run() {
    if (raf || !visible || Stopwatch.phase !== "running") return;
    const frame = () => {
      raf = 0;
      if (!visible || Stopwatch.phase !== "running") return;
      paint();
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
  }

  function stop() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  // ── Buttons ──────────────────────────────────────────────────────────────

  function buildRow(phase: StopwatchPhase, animate: boolean) {
    clear(row);
    switch (phase) {
      case "idle":
        row.append(btn("Start", "primary", () => {
          actions.react("start");
          motion = "pop";
          Stopwatch.start();
        }, svg(ICONS.play, 10)));
        break;
      case "running":
        row.append(
          btn("Lap", "secondary", () => {
            if (Stopwatch.lap()) actions.react("lap");
          }, svg(ICONS.flag, 10, { stroke: 2.2 })),
          btn("Pause", "primary", () => {
            actions.blip();
            Stopwatch.pause();
          }, svg(ICONS.pause, 10)),
        );
        break;
      case "paused":
        row.append(
          btn("Reset", "secondary", () => {
            actions.blip();
            motion = "roll";
            Stopwatch.reset();
          }),
          btn("Resume", "primary", () => {
            actions.react("start");
            motion = "pop";
            Stopwatch.start();
          }, svg(ICONS.play, 10)),
        );
        break;
    }
    if (animate) [...row.children].forEach((b, i) => popIn(b as HTMLElement, i * 45));
  }

  // ── Laps ─────────────────────────────────────────────────────────────────

  function lapRow(index: number): HTMLElement {
    const total = Stopwatch.laps[index];
    const split = total - (index > 0 ? Stopwatch.laps[index - 1] : 0);
    return h(
      "div",
      { class: "sw-lap" },
      h("span", { class: "sw-lap-n" }, svg(ICONS.flag, 9, { stroke: 2.4 }), h("span", { text: `Lap ${index + 1}` })),
      h("span", { class: "sw-lap-split", text: `+${chronoText(split)}` }),
      h("span", { class: "sw-lap-total", text: chronoText(total) }),
    );
  }

  /** Fastest and slowest, once there are three laps to compare. */
  function markExtremes() {
    const splits = Stopwatch.splits();
    const rows = [...laps.children] as HTMLElement[];
    const best = splits.length >= 3 ? splits.indexOf(Math.min(...splits)) : -1;
    const worst = splits.length >= 3 ? splits.indexOf(Math.max(...splits)) : -1;
    rows.forEach((r) => {
      const i = Number(r.dataset.i);
      r.classList.toggle("best", i === best);
      r.classList.toggle("worst", i === worst && worst !== best);
    });
  }

  function syncLaps(animate: boolean) {
    const n = Stopwatch.laps.length;
    if (n === lapCount) return;
    const grew = n > lapCount && lapCount >= 0;
    if (n === 0) {
      // Reset: the laps fade together as the island shrinks back.
      if (animate && laps.children.length) {
        const old = [...laps.children] as HTMLElement[];
        old.forEach((r) => r.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 180, fill: "forwards" }));
        window.setTimeout(() => old.forEach((r) => r.remove()), 200);
      } else {
        clear(laps);
      }
    } else if (grew && animate) {
      // Newest on top: each new one comes in and lights up.
      for (let i = lapCount; i < n; i++) {
        const r = lapRow(i);
        r.dataset.i = String(i);
        laps.prepend(r);
        popIn(r);
        flash(r);
      }
      laps.scrollTop = 0;
      bump(lapLine, 1.06);
    } else {
      clear(laps);
      for (let i = n - 1; i >= 0; i--) {
        const r = lapRow(i);
        r.dataset.i = String(i);
        laps.append(r);
      }
    }
    lapCount = n;
    markExtremes();
    card.classList.toggle("has-laps", n > 0);
    onHeightChange();
  }

  function sync() {
    const phase = Stopwatch.phase;
    if (phase !== phaseKey) {
      const animate = phaseKey !== "";
      phaseKey = phase;
      buildRow(phase, animate);
      digits.classList.toggle("paused", phase === "paused");
      heading.textContent = phase === "paused" ? "Paused" : "Stopwatch";
      card.style.setProperty("--wash", phase === "running" ? "rgba(56,189,248,0.24)" : "rgba(56,189,248,0.14)");
      if (phase === "running") run();
      else stop();
    }
    syncLaps(true);
    paint();
    if (motion === "pop") bump(digits, 1.08);
    else if (motion === "roll") rollIn(digits);
    motion = null;
  }

  return {
    el,
    sync,
    show() {
      visible = true;
      lapCount = -1;
      syncLaps(false);
      run();
    },
    hide() {
      visible = false;
      stop();
    },
  };
}
