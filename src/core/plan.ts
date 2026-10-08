// Claude plan usage — the logic of upstream's core/plan.ts (itself
// ClaudePlanGauge.swift), with no DOM. The numbers come from Claude Code's own
// `rate_limit_event` (claude_code.rs): with every Mochi turn, or from the ↻ on
// the card. Nothing is read from any credentials.

export interface PlanWindow {
  /** 0–100. */
  usedPct: number;
  /** Epoch milliseconds. */
  resetsAt: number;
}

export interface PlanUsage {
  fiveHour?: PlanWindow | null;
  sevenDay?: PlanWindow | null;
  /** When the numbers arrived (epoch ms). */
  updatedAt: number;
}

/** Older than this, opening the card asks Claude Code again by itself. */
export const PLAN_STALE_MS = 15 * 60_000;

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** What to show for a window: 0 once its reset time has passed. */
export const effectivePct = (w: PlanWindow, now = Date.now()): number => (w.resetsAt <= now ? 0 : w.usedPct);

/** The higher of the two effective percentages; null when there are no windows. */
export function dominantPct(u: PlanUsage | null | undefined, now = Date.now()): number | null {
  const pcts = [u?.fiveHour, u?.sevenDay]
    .filter((w): w is PlanWindow => !!w)
    .map((w) => effectivePct(w, now));
  return pcts.length ? Math.max(...pcts) : null;
}

/** Green below 50 %, orange up to 80 %, red above, grey without data. */
export function planColor(pct: number | null): string {
  if (pct == null) return "#6B7079";
  if (pct < 50) return "#22C55E";
  if (pct < 80) return "#F59E0B";
  return "#F4505E";
}

/** "Claude 73%", or "Claude —" while there are no numbers. */
export function pillLabel(u: PlanUsage | null | undefined, now = Date.now()): string {
  const pct = dominantPct(u, now);
  return pct == null ? "Claude —" : `Claude ${Math.round(pct)}%`;
}

/** "just now", "12 min ago", "3 h ago". */
export function ageLabel(updatedAt: number, now = Date.now()): string {
  const secs = (now - updatedAt) / 1000;
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  return mins < 60 ? `${mins} min ago` : `${Math.floor(mins / 60)} h ago`;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "in 1 h 20" / "in 5 min" for the 5-hour window, "Mon 9:00" for the week. */
export function resetLabel(w: PlanWindow, weekly: boolean, now = Date.now()): string {
  const secs = (w.resetsAt - now) / 1000;
  if (secs <= 0) return "resetting…";
  if (weekly) {
    const d = new Date(w.resetsAt);
    return `${WEEKDAYS[d.getDay()]} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
  const hours = Math.floor(secs / 3600);
  const mins = Math.floor((secs % 3600) / 60);
  return hours > 0 ? `in ${hours} h ${mins}` : `in ${mins} min`;
}

export const planIsStale = (u: PlanUsage | null, now = Date.now()): boolean =>
  !u || now - u.updatedAt >= PLAN_STALE_MS;

/** Numbers as they come from Rust (or storage), if they still look like some. */
export function parsePlanUsage(raw: unknown): PlanUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  if (!isNum(v.updatedAt)) return null;
  const win = (w: unknown): PlanWindow | null => {
    if (!w || typeof w !== "object") return null;
    const o = w as Record<string, unknown>;
    return isNum(o.usedPct) && isNum(o.resetsAt) && o.usedPct >= 0 && o.usedPct <= 100
      ? { usedPct: o.usedPct, resetsAt: o.resetsAt }
      : null;
  };
  const fiveHour = win(v.fiveHour);
  const sevenDay = win(v.sevenDay);
  return fiveHour || sevenDay ? { fiveHour, sevenDay, updatedAt: v.updatedAt } : null;
}
