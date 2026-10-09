// The little status cluster: the Claude plan, the battery (laptops only — a
// desktop PC has none to show) and the time. In the small island it sits in
// the middle, sliding to the right as one piece when music plays; in the open
// island the battery and the time sit in the header, before the plan pill.

import { Bridge } from "../core/bridge";
import { dominantPct, planColor } from "../core/plan";
import { State } from "../core/state";
import { Timer, formatTimer } from "../core/timer";
import { dot, h, svg } from "./dom";
import { ICONS } from "./icons";

/** How often the battery is asked about. It moves slowly. */
const BATTERY_EVERY_MS = 60_000;

/** "14:32", in the user's own convention (24 h in French). */
export function clockText(d = new Date()): string {
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * Wakes once a minute, on the minute, for the clock, and asks for the battery
 * every minute too. Both only redraw what shows them.
 */
export function startStatusClock(): void {
  const battery = async () => {
    const b = await Bridge.batteryStatus();
    const next = b ?? null;
    if (JSON.stringify(next) !== JSON.stringify(State.battery)) {
      State.battery = next;
      State.notify();
    }
  };
  void battery();
  window.setInterval(() => void battery(), BATTERY_EVERY_MS);

  const minute = () => {
    State.notify();
    window.setTimeout(minute, 60_000 - (Date.now() % 60_000) + 50);
  };
  window.setTimeout(minute, 60_000 - (Date.now() % 60_000) + 50);
}

/** Red when low and unplugged, green while charging, white otherwise. */
function batteryColor(percent: number, charging: boolean): string {
  if (charging) return "#22C55E";
  if (percent <= 20) return "#F4505E";
  return "#C5C8CD";
}

/** A tiny battery drawn in CSS, filled to the level, with a bolt while charging. */
export function batteryIcon(percent: number, charging: boolean): HTMLElement {
  const fill = h("i", { class: "bat-fill" });
  fill.style.width = `${Math.max(6, Math.min(100, percent))}%`;
  const el = h("span", { class: charging ? "bat charging" : "bat" }, h("span", { class: "bat-body" }, fill));
  el.style.setProperty("--bat", batteryColor(percent, charging));
  return el;
}

export interface StatusCluster {
  el: HTMLElement;
  /** Redraws what changed; true when something is shown at all. */
  sync(withPlan: boolean): boolean;
}

/** For the small island: "● 62%  ▮ 84%  14:32". */
export function buildStatusCluster(): StatusCluster {
  const timerText = h("span");
  const timer = h("span", { class: "sc-item sc-timer" }, svg(ICONS.timer, 10), timerText);
  const plan = h("span", { class: "sc-item sc-plan" });
  const battery = h("span", { class: "sc-item sc-battery" });
  const clock = h("span", { class: "sc-item sc-clock" });
  const el = h("div", { id: "plan-compact" }, timer, plan, battery, clock);
  let planKey = "";
  let batteryKey = "";

  return {
    el,
    sync(withPlan) {
      const extras = State.settings.clockBattery;

      // A timer, running, paused or ringing, comes first.
      timer.style.display = Timer.active ? "" : "none";
      if (Timer.active) {
        timerText.textContent = formatTimer(Timer.remaining());
        timer.className = `sc-item sc-timer ${Timer.phase}`;
      }

      const pct = withPlan ? dominantPct(State.planUsage) : null;
      plan.style.display = pct != null ? "" : "none";
      if (pct != null) {
        const label = `${Math.round(pct)}%`;
        if (planKey !== label) {
          planKey = label;
          const color = planColor(pct);
          plan.replaceChildren(dot(color, 5), h("span", { text: label }));
          plan.style.color = color;
        }
      }

      const b = extras ? State.battery : null;
      battery.style.display = b ? "" : "none";
      if (b) {
        const key = `${b.percent}|${b.charging}`;
        if (batteryKey !== key) {
          batteryKey = key;
          battery.replaceChildren(batteryIcon(b.percent, b.charging), h("span", { text: `${b.percent}%` }));
          battery.style.color = batteryColor(b.percent, b.charging);
        }
      }

      clock.style.display = extras ? "" : "none";
      if (extras) clock.textContent = clockText();

      return Timer.active || pct != null || b != null || extras;
    },
  };
}

/** For the open island's header: battery and time, quiet, before the plan pill. */
export function buildHeaderStatus(): { el: HTMLElement; sync(): void } {
  const battery = h("span", { class: "hs-battery" });
  const clock = h("span", { class: "hs-clock" });
  const el = h("span", { class: "header-status" }, battery, clock);
  let batteryKey = "";
  return {
    el,
    sync() {
      const on = State.settings.clockBattery && !State.resizing;
      el.style.display = on ? "" : "none";
      if (!on) return;
      const b = State.battery;
      battery.style.display = b ? "" : "none";
      if (b) {
        const key = `${b.percent}|${b.charging}`;
        if (batteryKey !== key) {
          batteryKey = key;
          battery.replaceChildren(batteryIcon(b.percent, b.charging), h("span", { text: `${b.percent}%` }));
        }
      }
      clock.textContent = clockText();
    },
  };
}
