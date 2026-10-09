// Reminders: "remind me to … at …". Kept in %APPDATA%\Coucou\reminders.json
// (written by Rust, like the notes), each with an alarm in Rust (alarms.rs) so
// it goes off on time with the island folded. One that came due while the app
// was closed rings as soon as it starts again.

import { Alarms } from "./alarms";
import { Bridge, IS_TAURI } from "./bridge";
import { State } from "./state";

export interface Reminder {
  id: string;
  text: string;
  /** When it rings, ms since the epoch. */
  at: number;
  created: number;
}

/** Alarm ids of reminders: "rem:<id>". */
const PREFIX = "rem:";
const DEV_KEY = "coucou.reminders";
const MINUTE = 60_000;

// ── Reading "when" ────────────────────────────────────────────────────────────

/** Weekday names, English and French, Sunday first (Date.getDay order). */
const WEEKDAYS: string[][] = [
  ["sunday", "sun", "dimanche", "dim"],
  ["monday", "mon", "lundi", "lun"],
  ["tuesday", "tue", "tues", "mardi", "mar"],
  ["wednesday", "wed", "mercredi", "mer"],
  ["thursday", "thu", "thur", "thurs", "jeudi", "jeu"],
  ["friday", "fri", "vendredi", "ven"],
  ["saturday", "sat", "samedi", "sam"],
];

/** "10m", "1h30", "90s", "2 h", "1:30" — a length, for "in …". */
function relative(text: string): number | null {
  const t = text.replace(/\s+/g, "");
  let m = t.match(/^(\d+(?:\.\d+)?)(s|sec|m|min|mn|h|d|j)?$/);
  if (m) {
    const n = parseFloat(m[1]);
    const unit = m[2] ?? "m";
    const mult = unit.startsWith("s") ? 1000 : unit === "h" ? 3600_000 : unit === "d" || unit === "j" ? 86_400_000 : MINUTE;
    return n * mult;
  }
  m = t.match(/^(\d+)h(\d{1,2})(?:m|min)?$/);
  if (m) return (parseInt(m[1]) * 60 + parseInt(m[2])) * MINUTE;
  m = t.match(/^(\d+):(\d{2})$/);
  if (m) return (parseInt(m[1]) * 60 + parseInt(m[2])) * MINUTE;
  return null;
}

/**
 * A time of day: "14:30", "14h30", "14h", "9.15", "2pm", "2:30 pm"; with
 * `bareHour`, "9" too. Empty text gives `fallback` (for a day with no time).
 */
function timeOfDay(text: string, bareHour: boolean, fallback: [number, number] | null): [number, number] | null {
  const t = text.trim().replace(/^(at|à|a) /, "");
  if (!t) return fallback;
  let m = t.match(/^(\d{1,2})(?:[:h.](\d{2}))?\s*(am|pm)$/);
  if (m) {
    const h = (parseInt(m[1]) % 12) + (m[3] === "pm" ? 12 : 0);
    return [h, m[2] ? parseInt(m[2]) : 0];
  }
  m = t.match(/^(\d{1,2})(?::(\d{2})|h(\d{2})?|\.(\d{2}))$/);
  if (m) return [parseInt(m[1]), parseInt(m[2] ?? m[3] ?? m[4] ?? "0")];
  if (bareHour && /^\d{1,2}$/.test(t)) return [parseInt(t), 0];
  return null;
}

/** `day` at h:m, or null for an impossible time. */
function onDay(day: Date, [h, m]: [number, number]): number | null {
  if (h > 23 || m > 59) return null;
  const d = new Date(day);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

/**
 * When a reminder should ring, read from what was typed, or null:
 * "14:30", "14h30", "9h", "2pm" (today, or tomorrow once past);
 * "tomorrow 9h", "demain 14:30", "monday 9:00", "lundi" (9:00), "12/10 14:30";
 * "in 20 min", "dans 1h", "+45", "20 min". A bare number is minutes from now.
 */
export function parseWhen(text: string, nowMs = Date.now()): number | null {
  const now = new Date(nowMs);
  const t = text.trim().toLowerCase().replace(/\s+/g, " ").replace(/^(at|à|a|le|on) /, "");
  if (!t) return null;
  const nine: [number, number] = [9, 0];

  // In …: "in 20 min", "dans 1h", "+45".
  const rel = t.match(/^(?:in |dans |\+ ?)(.+)$/);
  if (rel) {
    const ms = relative(rel[1]);
    return ms != null && ms > 0 ? nowMs + ms : null;
  }

  // Today / tomorrow.
  const dayWord = t.match(/^(tomorrow|tmrw?|demain|today|aujourd'hui|auj)\b ?/);
  if (dayWord) {
    const day = new Date(now);
    if (/^(tomorrow|tmr|demain)/.test(dayWord[1])) day.setDate(day.getDate() + 1);
    const time = timeOfDay(t.slice(dayWord[0].length), true, nine);
    return time ? onDay(day, time) : null;
  }

  // A weekday: the next one ("monday" on a Monday morning, after 9:00, is next week).
  const first = t.split(" ")[0].replace(/\.$/, "");
  const weekday = WEEKDAYS.findIndex((names) => names.includes(first));
  if (weekday >= 0) {
    const time = timeOfDay(t.slice(t.split(" ")[0].length), true, nine);
    if (!time) return null;
    const day = new Date(now);
    day.setDate(day.getDate() + ((weekday - now.getDay() + 7) % 7));
    let at = onDay(day, time);
    if (at != null && at <= nowMs) at += 7 * 86_400_000;
    return at;
  }

  // A date, day first: "12/10", "12-10", "12/10/2027 14:30" (once past, next
  // year's). Not with dots: "9.15" is a time.
  const date = t.match(/^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?(?: (.*))?$/);
  if (date) {
    const time = timeOfDay(date[4] ?? "", true, nine);
    if (!time) return null;
    const year = date[3] ? (date[3].length === 2 ? 2000 + parseInt(date[3]) : parseInt(date[3])) : now.getFullYear();
    const day = new Date(year, parseInt(date[2]) - 1, parseInt(date[1]));
    if (day.getMonth() !== parseInt(date[2]) - 1) return null; // 31/02
    let at = onDay(day, time);
    if (at != null && at <= nowMs && !date[3]) {
      day.setFullYear(day.getFullYear() + 1);
      at = onDay(day, time);
    }
    return at;
  }

  // A time of day: today, or tomorrow once it is past.
  const time = timeOfDay(t, false, null);
  if (time) {
    let at = onDay(now, time);
    if (at != null && at <= nowMs) {
      const tomorrow = new Date(now);
      tomorrow.setDate(now.getDate() + 1);
      at = onDay(tomorrow, time);
    }
    return at;
  }

  // Otherwise a length with a unit, or a bare number of minutes: "20 min", "45".
  const ms = relative(t);
  return ms != null && ms > 0 ? nowMs + ms : null;
}

// ── Showing "when" ────────────────────────────────────────────────────────────

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** "14:30", "Tomorrow 09:00", "Mon 09:00", "12 Oct 09:00". */
export function whenLabel(at: number, nowMs = Date.now()): string {
  const d = new Date(at);
  const now = new Date(nowMs);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (sameDay(d, now)) return time;
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (sameDay(d, tomorrow)) return `Tomorrow ${time}`;
  if (at - nowMs < 6 * 86_400_000 && at > nowMs) {
    return `${d.toLocaleDateString([], { weekday: "short" })} ${time}`;
  }
  return `${d.toLocaleDateString([], { day: "numeric", month: "short" })} ${time}`;
}

/** "in 25 min", "in 3 h", "in 2 d", "now". */
export function inLabel(at: number, nowMs = Date.now()): string {
  const ms = at - nowMs;
  if (ms <= 30_000) return "now";
  const min = Math.round(ms / MINUTE);
  if (min < 60) return `in ${min} min`;
  const h = ms / 3600_000;
  if (h < 24) return `in ${h < 10 ? Math.round(h * 10) / 10 : Math.round(h)} h`;
  return `in ${Math.round(h / 24)} d`;
}

// ── The list ──────────────────────────────────────────────────────────────────

class ReminderStore {
  status: "loading" | "ready" | "error" = "loading";
  error: string | null = null;
  private items: Reminder[] = [];
  private saving: Promise<void> = Promise.resolve();

  /** Soonest first. */
  get list(): readonly Reminder[] {
    return this.items;
  }

  isRinging(id: string): boolean {
    return Alarms.isRinging(PREFIX + id);
  }

  async load() {
    try {
      const text = IS_TAURI ? await Bridge.remindersLoad() : devRead();
      const raw = text ? (JSON.parse(text) as { reminders?: Reminder[] }) : {};
      this.items = (raw.reminders ?? [])
        .filter((r) => r && typeof r.id === "string" && typeof r.text === "string" && Number.isFinite(r.at))
        .sort((a, b) => a.at - b.at);
      this.status = "ready";
    } catch (err) {
      // Never written over: the file may be the only copy.
      this.status = "error";
      this.error = `Couldn't read your reminders: ${String(err).replace(/^Error:\s*/, "")}`;
      State.notify();
      return;
    }
    const now = Date.now();
    for (const r of this.items) {
      if (r.at <= now) this.due(r.id);
      else Alarms.schedule(PREFIX + r.id, r.at);
    }
    State.notify();
  }

  add(text: string, at: number): Reminder | null {
    const clean = text.trim().slice(0, 120);
    if (!clean || this.status !== "ready") return null;
    const r: Reminder = {
      id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      text: clean,
      at,
      created: Date.now(),
    };
    this.items.push(r);
    this.items.sort((a, b) => a.at - b.at);
    Alarms.schedule(PREFIX + r.id, at);
    this.changed();
    return r;
  }

  /** New wording and time. Due already (a time just past): it rings now. */
  update(id: string, text: string, at: number): boolean {
    const r = this.items.find((x) => x.id === id);
    const clean = text.trim().slice(0, 120);
    if (!r || !clean) return false;
    r.text = clean;
    r.at = at;
    this.items.sort((a, b) => a.at - b.at);
    if (at <= Date.now()) {
      Alarms.schedule(PREFIX + id, null);
      this.changed();
      this.due(id);
    } else {
      Alarms.answer(PREFIX + id);
      Alarms.schedule(PREFIX + id, at);
      this.changed();
    }
    return true;
  }

  /** Done, or deleted: gone, and silent. */
  remove(id: string) {
    Alarms.schedule(PREFIX + id, null);
    this.items = this.items.filter((r) => r.id !== id);
    Alarms.answer(PREFIX + id);
    this.changed();
  }

  /** Again in `ms`. */
  snooze(id: string, ms: number) {
    const r = this.items.find((x) => x.id === id);
    if (!r) return;
    r.at = Date.now() + ms;
    this.items.sort((a, b) => a.at - b.at);
    Alarms.answer(PREFIX + id);
    Alarms.schedule(PREFIX + id, r.at);
    this.changed();
  }

  /** Its alarm went off. */
  due(id: string) {
    const r = this.items.find((x) => x.id === id);
    if (!r || this.isRinging(id)) return;
    // A stale alarm from before a snooze: not yet.
    if (r.at - Date.now() > 1000) {
      Alarms.schedule(PREFIX + id, r.at);
      return;
    }
    Alarms.ring(PREFIX + id, "reminders");
    State.notify();
  }

  private changed() {
    State.notify();
    if (this.status !== "ready") return;
    const json = JSON.stringify({ version: 1, reminders: this.items });
    // One write at a time, in order: the last one is always the newest list.
    this.saving = this.saving
      .then(() => (IS_TAURI ? Bridge.remindersSave(json) : devWrite(json)))
      .then(() => {
        this.error = null;
      })
      .catch((err) => {
        this.error = `Couldn't save: ${String(err).replace(/^Error:\s*/, "")}`;
        State.notify();
      });
  }
}

function devRead(): string | null {
  try {
    return localStorage.getItem(DEV_KEY);
  } catch {
    return null;
  }
}

function devWrite(json: string) {
  try {
    localStorage.setItem(DEV_KEY, json);
  } catch {
    /* dev only */
  }
}

export const Reminders = new ReminderStore();

Alarms.on(PREFIX, (alarmId) => Reminders.due(alarmId.slice(PREFIX.length)));
