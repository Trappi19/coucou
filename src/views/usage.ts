// Claude plan usage in the island — upstream's views/usage.ts (ClaudePlanHeaderPill
// and ClaudePlanCardView on the Mac), adapted: the pill sits in the header of
// every open view and opens its own card, and compact shows the percentage too,
// so the plan is always in sight. The numbers come from core/plan.ts.

import { Bridge } from "../core/bridge";
import {
  ageLabel, dominantPct, effectivePct, parsePlanUsage, pillLabel, planColor, planIsStale,
  resetLabel, type PlanUsage, type PlanWindow,
} from "../core/plan";
import { State } from "../core/state";
import { clear, dot, h, svg } from "./dom";
import { ICONS } from "./icons";
import type { ViewActions, ViewHost } from "./views";

const STORE_KEY = "coucou.claudePlanUsage";

export const planColorNow = (now = Date.now()) => planColor(dominantPct(State.planUsage, now));

// ── Numbers ───────────────────────────────────────────────────────────────────

/** New numbers from Claude Code; kept so the gauges survive a restart. */
export function setPlanUsage(raw: unknown): void {
  const usage = parsePlanUsage(raw);
  if (!usage) return;
  State.planUsage = usage;
  State.planError = null;
  try {
    window.localStorage?.setItem(STORE_KEY, JSON.stringify(usage));
  } catch {
    // Storage off or full: the numbers just won't outlive this run.
  }
  State.notify();
}

/** The last numbers seen, if any were kept. */
export function restorePlanUsage(): void {
  try {
    State.planUsage = parsePlanUsage(JSON.parse(window.localStorage?.getItem(STORE_KEY) ?? "null"));
  } catch {
    State.planUsage = null;
  }
}

/** Asks Claude Code again. Never while paused, never twice at once. */
export function refreshPlanUsage(): void {
  if (State.planRefreshing || State.paused || !State.usesClaudeCode) return;
  State.planRefreshing = true;
  State.planError = null;
  State.notify();
  Bridge.planRefresh()
    .then((raw) => setPlanUsage(raw))
    .catch((err) => {
      State.planError = String(err).replace(/^Error:\s*/, "");
    })
    .finally(() => {
      State.planRefreshing = false;
      State.notify();
    });
}

/** How often the background check looks at the clock. Cheap: no request unless due. */
const AUTO_TICK_MS = 60_000;
/** A little early is fine: a check due in under this counts as due. */
const AUTO_SLACK_MS = 15_000;

/**
 * Keeps the gauges current without opening the card: every few minutes
 * (Settings → Mochi's chat), unless a Mochi turn just brought fresh numbers,
 * the app is paused, or the chat isn't on the Claude plan. One ~700-token
 * question to Haiku each time.
 */
export function startPlanAutoRefresh(): void {
  const check = () => {
    const minutes = State.settings.planRefreshMinutes;
    if (!minutes || minutes <= 0) return;
    const age = Date.now() - (State.planUsage?.updatedAt ?? 0);
    if (age >= minutes * 60_000 - AUTO_SLACK_MS) refreshPlanUsage();
  };
  // A first look shortly after launch, once the greeting is over.
  window.setTimeout(check, 20_000);
  window.setInterval(check, AUTO_TICK_MS);
}

// ── Header pill ───────────────────────────────────────────────────────────────

/** "Claude 28%" in the plan's colour; opens the card, or goes back from it. */
export function buildPlanPill(actions: ViewActions): { el: HTMLElement; sync(): void } {
  const label = h("span", { class: "plan-pill-label" });
  const dotEl = h("i", { class: "plan-pill-dot" });
  let back: Parameters<ViewActions["setView"]>[0] = "overview";
  const el = h("button", {
    class: "plan-pill",
    title: "Claude plan usage",
    onclick: () => {
      actions.blip();
      if (State.view === "usage") {
        actions.setView(back);
      } else {
        back = State.view;
        actions.setView("usage");
      }
    },
  }, dotEl, label);
  return {
    el,
    sync() {
      const show = State.usesClaudeCode && !State.resizing;
      el.style.display = show ? "" : "none";
      if (!show) return;
      const color = planColorNow();
      el.style.setProperty("--plan", color);
      el.classList.toggle("active", State.view === "usage");
      dotEl.style.background = color;
      label.textContent = pillLabel(State.planUsage);
    },
  };
}

// ── Card ──────────────────────────────────────────────────────────────────────

function gaugeRow(label: string, w: PlanWindow | null | undefined, weekly: boolean, now: number): HTMLElement {
  const row = h("div", { class: "plan-row" }, h("span", { class: "plan-label", text: label }));
  if (!w) {
    row.append(h("span", { class: "plan-none", text: "—" }));
    return row;
  }
  const pct = effectivePct(w, now);
  const fill = h("i", { class: "plan-fill" });
  fill.style.width = `${pct}%`;
  fill.style.background = planColor(pct);
  row.append(
    h("span", { class: "plan-bar" }, fill),
    h("span", { class: "plan-pct", text: `${Math.round(pct)}%` }),
    h("span", { class: "plan-reset-icon" }, svg(ICONS.arrowClockwise, 8, { stroke: 2.6 })),
    h("span", { class: "plan-reset", text: resetLabel(w, weekly, now) }),
  );
  return row;
}

function subtitle(u: PlanUsage | null, now: number): string {
  if (State.planRefreshing) return "asking Claude Code…";
  if (State.planError) return State.planError;
  return u ? ageLabel(u.updatedAt, now) : "no numbers yet";
}

export function buildUsage(): ViewHost {
  const body = h("div", { class: "plan-card" });
  const refresh = h("button", {
    class: "icon-btn plan-refresh",
    title: "Ask Claude Code again (a one-word question to Haiku)",
    onclick: () => refreshPlanUsage(),
  }, svg(ICONS.arrowClockwise, 9, { stroke: 2.6 }));
  const el = h("div", { class: "view" }, h("div", { class: "card plan-view" }, body, refresh));
  let key = "";

  function draw(now: number) {
    const u = State.planUsage;
    clear(body);
    const head = h("div", { class: "plan-head" },
      dot(planColorNow(now), 7),
      h("span", { class: "plan-title", text: "Claude plan" }),
      h("span", { class: `plan-sub${State.planError ? " err" : ""}`, text: subtitle(u, now) }),
    );
    body.append(
      head,
      h("div", { class: "plan-rows" },
        gaugeRow("5 hours", u?.fiveHour, false, now),
        gaugeRow("Week", u?.sevenDay, true, now),
      ),
      h("div", { class: "plan-hint", text: "Your whole account: Claude Desktop, the terminal and Mochi." }),
    );
    refresh.classList.toggle("spinning", State.planRefreshing);
  }

  return {
    el,
    show() {
      // Opening the card is asking: numbers older than 15 min are fetched again.
      if (planIsStale(State.planUsage)) refreshPlanUsage();
    },
    sync() {
      const now = Date.now();
      // Again every 30 s for the countdowns, and whenever the numbers move.
      const next = [JSON.stringify(State.planUsage), State.planRefreshing, State.planError, Math.floor(now / 30_000)].join("|");
      if (next === key) return;
      key = next;
      draw(now);
    },
    tick() {
      this.sync();
    },
  };
}
