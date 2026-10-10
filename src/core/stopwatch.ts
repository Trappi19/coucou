// The stopwatch: start, pause, laps. Counted against the wall clock, so it
// keeps time while the island is folded and even across a restart (the state is
// remembered in localStorage). Nothing runs to count: the time is worked out
// whenever it is shown.

import { State } from "./state";

const STORE_KEY = "coucou.stopwatch";
/** More than this would never fit on screen or mean anything. */
const MAX_LAPS = 99;

export type StopwatchPhase = "idle" | "running" | "paused";

interface Saved {
  startedAt: number | null;
  base: number;
  laps: number[];
}

/** "0:07.42", "12:03.10", "1:02:03.4" — tenths only past an hour. */
export function formatChrono(ms: number): { main: string; fraction: string } {
  const t = Math.max(0, Math.floor(ms));
  const h = Math.floor(t / 3_600_000);
  const m = Math.floor((t % 3_600_000) / 60_000);
  const s = Math.floor((t % 60_000) / 1000);
  const ss = String(s).padStart(2, "0");
  if (h > 0) {
    return { main: `${h}:${String(m).padStart(2, "0")}:${ss}`, fraction: `.${Math.floor((t % 1000) / 100)}` };
  }
  return { main: `${m}:${ss}`, fraction: `.${String(Math.floor((t % 1000) / 10)).padStart(2, "0")}` };
}

/** The whole thing as one string. */
export function chronoText(ms: number): string {
  const { main, fraction } = formatChrono(ms);
  return main + fraction;
}

class StopwatchStore {
  /** When the current run started (epoch ms), while running. */
  private startedAt: number | null = null;
  /** Time counted before the current run. */
  private base = 0;
  /** Each lap's total time when it was marked, oldest first. */
  laps: number[] = [];

  private ticker: number | null = null;
  private ticking = false;

  get phase(): StopwatchPhase {
    if (this.startedAt != null) return "running";
    return this.base > 0 ? "paused" : "idle";
  }

  get active(): boolean {
    return this.phase !== "idle";
  }

  elapsed(now = Date.now()): number {
    return this.base + (this.startedAt != null ? Math.max(0, now - this.startedAt) : 0);
  }

  /** The lap in progress: time since the last mark. */
  currentLap(now = Date.now()): number {
    return this.elapsed(now) - (this.laps.at(-1) ?? 0);
  }

  /** Each lap's own length, oldest first. */
  splits(): number[] {
    return this.laps.map((t, i) => t - (i > 0 ? this.laps[i - 1] : 0));
  }

  start() {
    if (this.startedAt != null) return;
    this.startedAt = Date.now();
    this.changed();
  }

  pause() {
    if (this.startedAt == null) return;
    this.base = this.elapsed();
    this.startedAt = null;
    this.changed();
  }

  /** Marks a lap; false when not running (or too many). */
  lap(): boolean {
    if (this.startedAt == null || this.laps.length >= MAX_LAPS) return false;
    this.laps.push(this.elapsed());
    this.changed();
    return true;
  }

  reset() {
    this.startedAt = null;
    this.base = 0;
    this.laps = [];
    this.changed();
  }

  /** The small island and the header show it: once a second, never while hidden. */
  setTicking(on: boolean) {
    const want = on && this.phase === "running";
    if (want === this.ticking) return;
    this.ticking = want;
    if (this.ticker != null) window.clearTimeout(this.ticker);
    this.ticker = null;
    if (want) this.tick();
  }

  restore() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      const saved = raw ? (JSON.parse(raw) as Saved) : null;
      if (!saved) return;
      this.startedAt = Number.isFinite(saved.startedAt) ? saved.startedAt : null;
      this.base = Number.isFinite(saved.base) ? Math.max(0, saved.base) : 0;
      this.laps = Array.isArray(saved.laps) ? saved.laps.filter(Number.isFinite).slice(0, MAX_LAPS) : [];
      State.notify();
    } catch {
      /* a fresh stopwatch, then */
    }
  }

  private tick = () => {
    this.ticker = null;
    if (!this.ticking) return;
    State.notify();
    if (this.phase !== "running") {
      this.ticking = false;
      return;
    }
    // Just after the shown second changes.
    this.ticker = window.setTimeout(this.tick, 1030 - (this.elapsed() % 1000));
  };

  private changed() {
    try {
      const saved: Saved = { startedAt: this.startedAt, base: this.base, laps: this.laps };
      localStorage.setItem(STORE_KEY, JSON.stringify(saved));
    } catch {
      /* still works, just not remembered */
    }
    State.notify();
  }
}

export const Stopwatch = new StopwatchStore();
