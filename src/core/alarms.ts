// What rings. Rust keeps the alarm times (alarms.rs) and says when one is due;
// the timer and the reminders each handle their own ids, and whatever is due
// rings here — the bell and Mochi going off — until it is answered.

import { Bridge, IS_TAURI } from "./bridge";
import type { IslandViewName } from "./layout";

/** Between two rings (bell + Mochi) while something is due. */
const RING_EVERY_MS = 2000;
/** After this long nobody has answered: the bell stops, the card stays up. */
const RING_FOR_MS = 60_000;
/** setTimeout's ceiling (~24.8 days); only the dev backup uses it. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

class AlarmCenter {
  /** Opens the island on the view that answers this alarm, and keeps it up. */
  onOpen: (view: IslandViewName) => void = () => {};
  /** Each ring: the bell and Mochi's dance. */
  onPulse: () => void = () => {};
  /** Nothing rings any more: the island may fold again. */
  onAnswered: () => void = () => {};

  private handlers: { prefix: string; fn: (id: string) => void }[] = [];
  private backups = new Map<string, number>();
  private ringing = new Set<string>();
  private pulse: number | null = null;
  private quietAt = 0;

  /** Ids starting with `prefix` are handed to `fn` when they are due. */
  on(prefix: string, fn: (id: string) => void) {
    this.handlers.push({ prefix, fn });
  }

  /** Sets (or with null, calls off) the alarm `id` for `atMs`, ms since the epoch. */
  schedule(id: string, atMs: number | null) {
    void Bridge.alarmSet(id, atMs == null ? null : Math.round(atMs));
    // Outside Tauri (`npm run dev`) the page has to keep time itself.
    if (IS_TAURI) return;
    const old = this.backups.get(id);
    if (old != null) window.clearTimeout(old);
    this.backups.delete(id);
    if (atMs != null) {
      const delay = Math.min(MAX_TIMEOUT_MS, Math.max(0, atMs - Date.now()));
      this.backups.set(id, window.setTimeout(() => this.due(id), delay));
    }
  }

  /** Rust (or the dev backup) says `id` is due. */
  due(id: string) {
    this.backups.delete(id);
    this.handlers.find((h) => id.startsWith(h.prefix))?.fn(id);
  }

  /** Starts ringing for `key`, opening the island on `view`. */
  ring(key: string, view: IslandViewName) {
    this.ringing.add(key);
    this.onOpen(view);
    this.quietAt = Date.now() + RING_FOR_MS;
    this.onPulse();
    // Also after a bell that went quiet: something new is due, it rings again.
    if (this.pulse == null) {
      this.pulse = window.setInterval(() => {
        // Nobody came: the bell stops, what is due waits for them on screen.
        if (Date.now() >= this.quietAt) this.silence();
        else this.onPulse();
      }, RING_EVERY_MS);
    }
  }

  /** `key` was answered (stopped, snoozed, done). */
  answer(key: string) {
    if (!this.ringing.delete(key) || this.ringing.size > 0) return;
    this.silence();
    this.onAnswered();
  }

  isRinging(key: string): boolean {
    return this.ringing.has(key);
  }

  private silence() {
    if (this.pulse != null) window.clearInterval(this.pulse);
    this.pulse = null;
  }
}

export const Alarms = new AlarmCenter();
