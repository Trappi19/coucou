// Local notes: one document in %APPDATA%\Coucou\notes.json, written by Rust.
// Nothing leaves the machine. Outside Tauri (`npm run dev`) the document lives
// in localStorage instead so the view can be worked on in a browser.

import { Bridge, IS_TAURI } from "./bridge";

export interface Note {
  id: string;
  title: string;
  /** Sanitised rich text (see views/richtext.ts). */
  html: string;
  /** At most one folder; null = not filed. */
  folder: string | null;
  tags: string[];
  created: number;
  updated: number;
}

interface NotesDoc {
  version: 1;
  /** Kept separately so a folder survives being empty. */
  folders: string[];
  notes: Note[];
}

/** Typing saves this long after the last keystroke. */
const SAVE_DELAY_MS = 500;
const DEV_KEY = "coucou.notes";

export type NotesStatus = "loading" | "ready" | "error";

function cleanName(name: string): string {
  return name.replace(/\s+/g, " ").trim().slice(0, 40);
}

/** Tags are single words, without the leading #. */
export function cleanTag(tag: string): string {
  return tag.replace(/^#+/, "").replace(/\s+/g, "-").trim().toLowerCase().slice(0, 32);
}

function newId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function sameName(a: string, b: string): boolean {
  return a.localeCompare(b, undefined, { sensitivity: "accent" }) === 0;
}

function parseDoc(text: string): NotesDoc {
  const raw = JSON.parse(text) as Partial<NotesDoc>;
  const notes = Array.isArray(raw.notes) ? raw.notes : [];
  const folders = Array.isArray(raw.folders) ? raw.folders.filter((f) => typeof f === "string") : [];
  return {
    version: 1,
    folders,
    notes: notes
      .filter((n) => n && typeof n.id === "string")
      .map((n) => ({
        id: n.id,
        title: typeof n.title === "string" ? n.title : "",
        html: typeof n.html === "string" ? n.html : "",
        folder: typeof n.folder === "string" ? n.folder : null,
        tags: Array.isArray(n.tags) ? n.tags.filter((t) => typeof t === "string") : [],
        created: Number(n.created) || Date.now(),
        updated: Number(n.updated) || Date.now(),
      })),
  };
}

class NotesStore {
  status: NotesStatus = "loading";
  /** Why loading or the last save failed. */
  error: string | null = null;
  private doc: NotesDoc = { version: 1, folders: [], notes: [] };
  private loadPromise: Promise<void> | null = null;
  private saveTimer: number | null = null;
  private dirty = false;
  private saving = false;
  private listeners = new Set<() => void>();

  get notes(): readonly Note[] {
    return this.doc.notes;
  }

  /** Every folder, the declared ones and any a note points at. */
  get folders(): string[] {
    const all = [...this.doc.folders];
    for (const n of this.doc.notes) {
      if (n.folder && !all.some((f) => sameName(f, n.folder!))) all.push(n.folder);
    }
    return all.sort((a, b) => a.localeCompare(b));
  }

  get tags(): string[] {
    const all = new Set<string>();
    for (const n of this.doc.notes) n.tags.forEach((t) => all.add(t));
    return [...all].sort((a, b) => a.localeCompare(b));
  }

  get(id: string | null): Note | null {
    return id ? this.doc.notes.find((n) => n.id === id) ?? null : null;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }

  load(): Promise<void> {
    this.loadPromise ??= this.read();
    return this.loadPromise;
  }

  private async read() {
    try {
      const text = IS_TAURI ? await Bridge.notesLoad() : readDev();
      if (text) this.doc = parseDoc(text);
      this.status = "ready";
    } catch (err) {
      // Never save over a file that could not be read: it may be the only copy.
      this.status = "error";
      this.error = `Couldn't read your notes: ${String(err).replace(/^Error:\s*/, "")}`;
      this.loadPromise = null;
    }
    this.emit();
  }

  // ── Notes ─────────────────────────────────────────────────────────────────

  create(folder: string | null, tags: string[] = []): Note {
    const now = Date.now();
    const note: Note = { id: newId(), title: "", html: "", folder, tags, created: now, updated: now };
    this.doc.notes.unshift(note);
    this.changed();
    return note;
  }

  update(id: string, patch: Partial<Pick<Note, "title" | "html" | "folder" | "tags">>) {
    const note = this.get(id);
    if (!note) return;
    Object.assign(note, patch);
    note.updated = Date.now();
    this.changed();
  }

  remove(id: string) {
    this.doc.notes = this.doc.notes.filter((n) => n.id !== id);
    this.changed();
  }

  addTag(id: string, tag: string) {
    const note = this.get(id);
    const t = cleanTag(tag);
    if (!note || !t || note.tags.includes(t)) return;
    this.update(id, { tags: [...note.tags, t] });
  }

  removeTag(id: string, tag: string) {
    const note = this.get(id);
    if (note) this.update(id, { tags: note.tags.filter((t) => t !== tag) });
  }

  // ── Folders ───────────────────────────────────────────────────────────────

  /** Returns the folder's name as stored (an existing one when it matches). */
  addFolder(name: string): string | null {
    const clean = cleanName(name);
    if (!clean) return null;
    const existing = this.folders.find((f) => sameName(f, clean));
    if (existing) return existing;
    this.doc.folders.push(clean);
    this.changed();
    return clean;
  }

  /** Deletes the folder only: its notes stay, unfiled. */
  removeFolder(name: string) {
    this.doc.folders = this.doc.folders.filter((f) => f !== name);
    for (const n of this.doc.notes) if (n.folder === name) n.folder = null;
    this.changed();
  }

  // ── Saving ────────────────────────────────────────────────────────────────

  private changed() {
    this.emit();
    if (this.status !== "ready") return;
    this.dirty = true;
    if (this.saveTimer != null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => void this.flush(), SAVE_DELAY_MS);
  }

  /** Writes now whatever is waiting. One write at a time; edits made meanwhile follow. */
  async flush() {
    if (this.saveTimer != null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this.dirty || this.saving || this.status !== "ready") return;
    this.saving = true;
    this.dirty = false;
    try {
      const json = JSON.stringify(this.doc);
      if (IS_TAURI) await Bridge.notesSave(json);
      else writeDev(json);
      if (this.error) {
        this.error = null;
        this.emit();
      }
    } catch (err) {
      // The next edit tries again.
      this.error = `Couldn't save: ${String(err).replace(/^Error:\s*/, "")}`;
      this.emit();
    } finally {
      this.saving = false;
    }
    if (this.dirty) void this.flush();
  }
}

function readDev(): string | null {
  try {
    return localStorage.getItem(DEV_KEY);
  } catch {
    return null;
  }
}

function writeDev(json: string) {
  try {
    localStorage.setItem(DEV_KEY, json);
  } catch {
    /* dev only */
  }
}

export const Notes = new NotesStore();
