// The timer tab: pick a length (a preset, or type one), start, pause, reset.
// When it is up the same card turns into the alarm — "Time's up", with Stop
// and a snooze — while Mochi rings like an alarm clock.

import { h, svg, clear } from "./dom";
import { Bridge } from "../core/bridge";
import { ICONS } from "./icons";
import { TIMER_PRESETS_MIN, Timer, formatTimer, parseDuration, type TimerPhase } from "../core/timer";
import { washRGBA } from "../core/layout";
import { timeSwitch } from "./reminders";
import { bump, popIn, rollIn } from "./motion";
import type { ViewActions, ViewHost } from "./views";

function btn(label: string, kind: "primary" | "secondary", onClick: () => void, icon?: string): HTMLElement {
  return h(
    "button",
    { class: `btn ${kind} tm-btn`, onclick: onClick },
    icon ? svg(icon, 10) : null,
    h("span", { text: label }),
  );
}

export function buildTimer(actions: ViewActions): ViewHost {
  const time = h("input", {
    class: "tm-time",
    type: "text",
    spellcheck: "false",
    title: "Type a length: 5, 1:30, 90s, 1h30…",
  }) as HTMLInputElement;
  const label = h("input", {
    class: "tm-label",
    type: "text",
    placeholder: "What's it for?",
    maxlength: "40",
    spellcheck: "false",
  }) as HTMLInputElement;
  const heading = h("div", { class: "tm-heading" });
  const presets = h("div", { class: "tm-presets" });
  const row = h("div", { class: "tm-actions" });
  const bar = h("div", { class: "tm-bar" }, h("i"));
  const left = h("div", { class: "tm-left" }, heading, time, label);
  const right = h("div", { class: "tm-right" }, presets, row);
  const card = h(
    "div",
    { class: "card wash tm-card" },
    h("div", { class: "tm-body" }, left, right),
    timeSwitch(actions, "timer"),
    bar,
  );
  const el = h("div", { class: "view" }, card);

  const presetButtons = TIMER_PRESETS_MIN.map((min) => {
    const b = h("button", {
      class: "tm-preset",
      title: `${min} min`,
      onclick: () => {
        actions.blip();
        const changed = Timer.durationMs !== min * 60_000;
        Timer.setDuration(min * 60_000);
        if (changed) motion = "roll";
      },
    }, String(min));
    return { min, b };
  });
  presets.append(...presetButtons.map((p) => p.b), h("span", { class: "tm-unit", text: "min" }));

  let phaseKey = "";
  /** The typed length isn't overwritten by the countdown while it is being typed. */
  let editing = false;

  /** Applies a typed length; Enter also starts it. */
  function applyTyped(startNow: boolean) {
    const ms = parseDuration(time.value);
    editing = false;
    if (ms == null) {
      time.classList.add("bad");
      window.setTimeout(() => time.classList.remove("bad"), 500);
      sync();
      return;
    }
    if (startNow) {
      actions.react("start");
      motion = "pop";
      Timer.start(ms);
    } else {
      motion = "roll";
      Timer.setDuration(ms);
    }
  }

  time.addEventListener("focus", () => {
    if (Timer.phase !== "idle") {
      time.blur();
      return;
    }
    editing = true;
    time.select();
  });
  time.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      applyTyped(true);
      time.blur();
    } else if (e.key === "Escape") {
      e.stopPropagation();
      editing = false;
      time.blur();
      sync();
    }
  });
  time.addEventListener("blur", () => {
    if (editing) applyTyped(false);
  });

  // The island takes the keyboard only when a field is clicked: the alarm
  // opening this view must not catch what is being typed elsewhere.
  let tookFocus = false;
  for (const field of [time, label]) {
    field.addEventListener("mousedown", () => {
      if (tookFocus || field.readOnly) return;
      tookFocus = true;
      void Bridge.focusWindow(true);
    });
  }

  label.addEventListener("input", () => Timer.setLabel(label.value));
  label.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      label.blur();
      if (Timer.phase === "idle") {
        actions.react("start");
        motion = "pop";
        Timer.start();
      }
    }
  });

  /** What the digits do at the next draw: a pop (started, time added) or a roll (new length). */
  let motion: "pop" | "roll" | null = null;

  function buildRow(phase: TimerPhase, animate: boolean) {
    clear(row);
    /** A button's action, with Mochi's reaction and what the digits do. */
    const act = (fn: () => void, react: "start" | "done" | "snooze" | null, digits: "pop" | "roll" | null) => () => {
      if (react) actions.react(react);
      else actions.blip();
      motion = digits;
      fn();
    };
    switch (phase) {
      case "idle":
        row.append(btn("Start", "primary", act(() => Timer.start(), "start", "pop"), ICONS.play));
        break;
      case "running":
        row.append(
          btn("+1 min", "secondary", act(() => Timer.add(60_000), null, "pop")),
          btn("Reset", "secondary", act(() => Timer.reset(), null, "roll")),
          btn("Pause", "primary", act(() => Timer.pause(), null, null), ICONS.pause),
        );
        break;
      case "paused":
        row.append(
          btn("Reset", "secondary", act(() => Timer.reset(), null, "roll")),
          btn("Resume", "primary", act(() => Timer.resume(), "start", "pop"), ICONS.play),
        );
        break;
      case "ringing":
        row.append(
          btn("+1 min", "secondary", act(() => Timer.add(60_000), "snooze", "pop")),
          btn("+5 min", "secondary", act(() => Timer.add(5 * 60_000), "snooze", "pop")),
          btn("Stop", "primary", act(() => Timer.stopRinging(), "done", "roll"), ICONS.stop),
        );
        break;
    }
    // The new buttons come in one after the other.
    if (animate) [...row.children].forEach((b, i) => popIn(b as HTMLElement, i * 45));
  }

  function sync() {
    const phase = Timer.phase;
    if (phase !== phaseKey) {
      const animate = phaseKey !== "";
      phaseKey = phase;
      buildRow(phase, animate);
      card.classList.toggle("ringing", phase === "ringing");
      card.style.setProperty("--wash", phase === "ringing" ? washRGBA("amber") : "rgba(245,165,36,0.16)");
      time.readOnly = phase !== "idle";
      presets.classList.toggle("off", phase !== "idle");
    }
    if (!editing) time.value = formatTimer(Timer.remaining());
    if (motion === "pop") bump(time, 1.1);
    else if (motion === "roll") rollIn(time);
    motion = null;
    time.classList.toggle("paused", phase === "paused");
    if (document.activeElement !== label && label.value !== Timer.label) label.value = Timer.label;

    heading.textContent = phase === "ringing" ? "Time's up!" : phase === "paused" ? "Paused" : "Timer";
    heading.classList.toggle("alarm", phase === "ringing");
    for (const { min, b } of presetButtons) {
      b.classList.toggle("on", phase === "idle" && Timer.durationMs === min * 60_000);
    }
    (bar.firstElementChild as HTMLElement).style.width = `${Timer.progress() * 100}%`;
    bar.style.opacity = phase === "idle" ? "0" : "1";
  }

  return {
    el,
    sync,
    hide() {
      editing = false;
      const a = document.activeElement;
      if (a === time || a === label) (a as HTMLElement).blur();
      if (tookFocus) {
        tookFocus = false;
        void Bridge.focusWindow(false);
      }
    },
  };
}
