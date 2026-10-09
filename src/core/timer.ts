// The timer: one countdown at a time, with a label. Its alarm is kept by Rust
// (alarms.rs, through core/alarms.ts) so it rings on time whatever the island
// is doing. The state is remembered in localStorage, so a restart or an update
// in the middle doesn't lose it.

import { Alarms } from "./alarms";
import { State } from "./state";

export type TimerPhase = "idle" | "running" | "paused" | "ringing";

/** The timer's alarm id, and its key while ringing. */
const ALARM_ID = "timer";
/** A timer that ended while the app was closed still rings if it is this recent. */
const MISSED_GRACE_MS = 10 * 60_000;
const STORE_KEY = "coucou.timer";

export const TIMER_PRESETS_MIN = [1, 3, 5, 10, 15, 25, 45];

interface Saved {
  phase: TimerPhase;
  durationMs: number;
  endsAt: number | null;
  leftMs: number;
  label: string;
}

/** "4:05", "12:00", "1:02:03". */
export function formatTimer(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/**
 * What the user typed: "5" (minutes), "1:30", "1:00:00", or with units —
 * "90s", "10m", "1h", "1h30". Null when it can't be read or is zero.
 */
export function parseDuration(text: string): number | null {
  const t = text.trim().toLowerCase().replace(",", ".");
  if (!t) return null;
  let ms: number | null = null;
  if (/^\d+(\.\d+)?$/.test(t)) {
    ms = parseFloat(t) * 60_000;
  } else if (/^\d+(:\d{1,2}){1,2}$/.test(t)) {
    const parts = t.split(":").map(Number);
    if (parts.slice(1).some((p) => p >= 60)) return null;
    const [a, b, c] = parts;
    ms = parts.length === 3 ? (a * 3600 + b * 60 + c) * 1000 : (a * 60 + b) * 1000;
  } else {
    // With units: "90s", "10m", "10 min", "1h", "1h30", "1h 5m 10s".
    const u = t.replace(/\s+/g, "");
    const short = u.match(/^(\d+)h(\d{1,2})$/);
    const full = u.match(/^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)(?:min|mn|m))?(?:(\d+)(?:sec|s))?$/);
    if (short) {
      ms = (parseInt(short[1]) * 60 + parseInt(short[2])) * 60_000;
    } else if (full && (full[1] || full[2] || full[3])) {
      ms = (parseFloat(full[1] ?? "0") * 3600 + parseFloat(full[2] ?? "0") * 60 + parseFloat(full[3] ?? "0")) * 1000;
    }
  }
  if (ms == null || !Number.isFinite(ms) || ms < 1000) return null;
  return Math.min(ms, 24 * 3600_000);
}

class TimerStore {
  phase: TimerPhase = "idle";
  /** The length picked: what a reset goes back to. */
  durationMs = 5 * 60_000;
  /** When it rings, while running. */
  endsAt: number | null = null;
  /** What was left when paused. */
  leftMs = 0;
  label = "";

  private ticker: number | null = null;
  private ticking = false;

  remaining(now = Date.now()): number {
    switch (this.phase) {
      case "running":
        return Math.max(0, (this.endsAt ?? now) - now);
      case "paused":
        return this.leftMs;
      case "ringing":
        return 0;
      default:
        return this.durationMs;
    }
  }

  /** How far along, 0 → 1, for the progress line. */
  progress(now = Date.now()): number {
    if (this.phase === "idle") return 0;
    if (this.phase === "ringing") return 1;
    return Math.min(1, Math.max(0, 1 - this.remaining(now) / this.durationMs));
  }

  get active(): boolean {
    return this.phase !== "idle";
  }

  setDuration(ms: number) {
    if (this.phase !== "idle") return;
    this.durationMs = ms;
    this.changed();
  }

  setLabel(label: string) {
    this.label = label.slice(0, 40);
    this.save();
  }

  start(ms = this.durationMs) {
    this.stopRinging(false);
    this.durationMs = ms;
    this.run(ms);
  }

  pause() {
    if (this.phase !== "running") return;
    this.leftMs = this.remaining();
    this.phase = "paused";
    this.endsAt = null;
    this.schedule();
    this.changed();
  }

  resume() {
    if (this.phase !== "paused") return;
    this.run(this.leftMs);
  }

  reset() {
    this.stopRinging(false);
    this.phase = "idle";
    this.endsAt = null;
    this.leftMs = 0;
    this.schedule();
    this.changed();
  }

  /** "+1 min": on a running timer it adds time; ringing, it snoozes. */
  add(ms: number) {
    if (this.phase === "running" && this.endsAt != null) {
      this.endsAt += ms;
      this.durationMs += ms;
      this.schedule();
      this.changed();
    } else if (this.phase === "paused") {
      this.leftMs += ms;
      this.durationMs += ms;
      this.changed();
    } else {
      this.stopRinging(false);
      this.durationMs = ms;
      this.run(ms);
    }
  }

  /** The alarm went off. */
  ring() {
    if (this.phase !== "running") return;
    // A stale alarm from before a change: only ring once the time is really up.
    if (this.endsAt != null && this.endsAt - Date.now() > 1000) {
      this.schedule();
      return;
    }
    this.startRinging();
  }

  /** Answered: silence, back to the length it had. */
  stopRinging(notify = true) {
    if (this.phase !== "ringing") return;
    this.phase = "idle";
    this.endsAt = null;
    Alarms.answer(ALARM_ID);
    if (notify) this.changed();
  }

  /**
   * The island shows the countdown: tick every second, on the second. Not while
   * hidden — the island must cost nothing then; the alarm doesn't need it.
   */
  setTicking(on: boolean) {
    const want = on && this.phase === "running";
    if (want === this.ticking) return;
    this.ticking = want;
    if (this.ticker != null) window.clearTimeout(this.ticker);
    this.ticker = null;
    if (want) this.tick();
  }

  /** Brings back a timer from before a restart. Call once the callbacks are wired. */
  restore() {
    let saved: Saved | null = null;
    try {
      const raw = localStorage.getItem(STORE_KEY);
      saved = raw ? (JSON.parse(raw) as Saved) : null;
    } catch {
      saved = null;
    }
    if (!saved) return;
    this.durationMs = saved.durationMs > 0 ? saved.durationMs : this.durationMs;
    this.label = saved.label ?? "";
    if (saved.phase === "paused" && saved.leftMs > 0) {
      this.phase = "paused";
      this.leftMs = saved.leftMs;
    } else if ((saved.phase === "running" || saved.phase === "ringing") && saved.endsAt != null) {
      const late = Date.now() - saved.endsAt;
      if (late < 0) {
        this.phase = "running";
        this.endsAt = saved.endsAt;
        this.schedule();
      } else if (late < MISSED_GRACE_MS) {
        this.phase = "running";
        this.endsAt = saved.endsAt;
        this.startRinging();
        return;
      }
    }
    this.changed();
  }

  // ── Inside ────────────────────────────────────────────────────────────────

  private run(ms: number) {
    this.phase = "running";
    this.endsAt = Date.now() + ms;
    this.leftMs = 0;
    this.schedule();
    this.changed();
  }

  private startRinging() {
    this.phase = "ringing";
    this.schedule();
    this.changed();
    Alarms.ring(ALARM_ID, "timer");
  }

  /** Tells Rust when to ring, or that it shouldn't. */
  private schedule() {
    Alarms.schedule(ALARM_ID, this.phase === "running" ? this.endsAt : null);
  }

  private tick = () => {
    this.ticker = null;
    if (!this.ticking) return;
    State.notify();
    if (this.phase !== "running") {
      this.ticking = false;
      return;
    }
    // Wake just after the displayed second changes.
    this.ticker = window.setTimeout(this.tick, Math.max(50, (this.remaining() % 1000) + 30));
  };

  private changed() {
    this.save();
    State.notify();
  }

  private save() {
    try {
      const saved: Saved = {
        phase: this.phase,
        durationMs: this.durationMs,
        endsAt: this.endsAt,
        leftMs: this.leftMs,
        label: this.label,
      };
      localStorage.setItem(STORE_KEY, JSON.stringify(saved));
    } catch {
      /* a timer that isn't remembered still works */
    }
  }
}

export const Timer = new TimerStore();

Alarms.on(ALARM_ID, () => Timer.ring());
