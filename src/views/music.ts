// The music widget. In compact, the island widens and shows what's playing —
// a little sound wave, the title, the artist and the time, a thin progress
// line along its bottom edge — while the Claude plan slides to the right. The
// music tab has the cover, the progress (click to seek) and the controls.
//
// The numbers come from Windows' media session (media.rs), so it works with
// Spotify, a browser tab, Deezer… whichever app is playing.

import { Bridge } from "../core/bridge";
import {
  formatTime, playerColor, playerName, positionNow, sameTrack, type MediaInfo,
} from "../core/media";
import { State } from "../core/state";
import { clear, dot, h, svg } from "./dom";
import { ICONS } from "./icons";
import type { ViewHost } from "./views";

/** A new report from Rust; the cover only comes with a new track, so it is kept. */
export function setMedia(raw: MediaInfo | null): void {
  if (!raw || !raw.title) {
    State.media = null;
  } else {
    const prev = State.media;
    State.media = { ...raw, cover: raw.cover ?? (sameTrack(prev, raw) ? prev?.cover ?? null : null) };
  }
  State.notify();
}

/** The music is shown: the widget is on and something is playing or paused. */
export const musicShown = (): boolean => State.settings.musicWidget && State.media != null;

/** Four bars dancing while it plays, resting low when paused. Pure CSS. */
export function musicWave(): HTMLElement {
  return h("span", { class: "mw-wave" }, h("i"), h("i"), h("i"), h("i"));
}

// ── Compact ───────────────────────────────────────────────────────────────────

export interface MusicCompact {
  el: HTMLElement;
  progress: HTMLElement;
  sync(): void;
  /** The time and the progress line, once a second while it plays. */
  tick(): void;
}

export function buildMusicCompact(): MusicCompact {
  const wave = musicWave();
  const title = h("span", { class: "mw-title" });
  const sub = h("span", { class: "mw-sub" });
  const time = h("span", { class: "mw-time" });
  const el = h("div", { id: "music-compact" }, wave, h("div", { class: "mw-text" }, title, h("div", { class: "mw-line" }, sub, time)));
  const fill = h("i");
  const progress = h("div", { id: "music-progress" }, fill);
  let key = "";

  function tick() {
    const m = State.media;
    if (!m) return;
    const pos = positionNow(m);
    time.textContent = m.durationMs > 0 ? formatTime(pos) : "";
    fill.style.width = m.durationMs > 0 ? `${(pos / m.durationMs) * 100}%` : "0%";
  }

  return {
    el,
    progress,
    tick,
    sync() {
      const m = State.media;
      const on = musicShown() && State.mode === "compact";
      el.classList.toggle("on", on);
      progress.classList.toggle("on", on && (m?.durationMs ?? 0) > 0);
      if (!m) return;
      const next = `${m.appId}|${m.title}|${m.artist}|${m.playing}`;
      if (next !== key) {
        key = next;
        title.textContent = m.title;
        sub.textContent = m.artist || playerName(m.appId);
        el.classList.toggle("playing", m.playing);
        const color = playerColor(m.appId);
        el.style.setProperty("--mw", color);
        progress.style.setProperty("--mw", color);
      }
      tick();
    },
  };
}

// ── Music tab ─────────────────────────────────────────────────────────────────

export function buildMusic(): ViewHost {
  const backdrop = h("img", { class: "mu-backdrop", alt: "" }) as HTMLImageElement;
  const cover = h("div", { class: "mu-cover" });
  const appRow = h("div", { class: "mu-app" });
  const title = h("div", { class: "mu-title" });
  const artist = h("div", { class: "mu-artist" });
  const fill = h("i", { class: "mu-fill" });
  const bar = h("div", { class: "mu-bar", title: "Click to jump there" }, fill);
  const elapsed = h("span", { class: "mu-t" });
  const total = h("span", { class: "mu-t" });
  const playBtn = h("button", { class: "mu-play", title: "Play / pause" });
  const prevBtn = h("button", { class: "mu-skip", title: "Previous" }, svg(ICONS.previous, 13));
  const nextBtn = h("button", { class: "mu-skip", title: "Next" }, svg(ICONS.next, 13));
  // Controls and progress share one line: the card is only ~108 px tall.
  const info = h(
    "div",
    { class: "mu-info" },
    appRow,
    title,
    artist,
    h(
      "div",
      { class: "mu-progress" },
      h("div", { class: "mu-controls" }, prevBtn, playBtn, nextBtn),
      elapsed,
      bar,
      total,
    ),
  );
  const empty = h(
    "div",
    { class: "mu-empty" },
    h("div", { class: "title", text: "Nothing playing." }),
    h("div", { class: "sub", text: "Play something in Spotify, YouTube, Deezer… and it shows up here." }),
  );
  const el = h("div", { class: "view" }, h("div", { class: "card mu-card" }, backdrop, h("div", { class: "mu-body" }, cover, info), empty));

  let key = "";
  let coverKey: string | null | undefined = undefined;
  /** A play/pause that hasn't come back from the player yet. */
  let optimistic: boolean | null = null;

  const control = (action: "toggle" | "next" | "previous" | "seek", ms?: number) => {
    void Bridge.mediaControl(action, ms).catch(() => {
      optimistic = null;
      State.notify();
    });
  };
  playBtn.addEventListener("click", () => {
    if (!State.media) return;
    optimistic = !(optimistic ?? State.media.playing);
    State.notify();
    control("toggle");
  });
  prevBtn.addEventListener("click", () => control("previous"));
  nextBtn.addEventListener("click", () => control("next"));
  bar.addEventListener("click", (e) => {
    const m = State.media;
    if (!m || m.durationMs <= 0) return;
    const r = bar.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const ms = Math.round(ratio * m.durationMs);
    // Moves at once; the player confirms with its next report.
    State.media = { ...m, positionMs: ms, at: Date.now() };
    State.notify();
    control("seek", ms);
  });

  function tick() {
    const m = State.media;
    if (!m) return;
    const pos = positionNow(m);
    elapsed.textContent = formatTime(pos);
    total.textContent = m.durationMs > 0 ? formatTime(m.durationMs) : "";
    fill.style.width = m.durationMs > 0 ? `${(pos / m.durationMs) * 100}%` : "0%";
  }

  return {
    el,
    tick,
    sync() {
      const m = State.media;
      el.classList.toggle("nothing", !m);
      if (!m) return;
      // The player answered: what it says wins over the guess.
      const playing = optimistic ?? m.playing;
      if (optimistic === m.playing) optimistic = null;

      const next = `${m.appId}|${m.title}|${m.artist}|${m.album}|${playing}`;
      if (next !== key) {
        const newTrack = !key.startsWith(`${m.appId}|${m.title}|${m.artist}|`);
        key = next;
        const color = playerColor(m.appId);
        el.style.setProperty("--mw", color);
        clear(appRow);
        appRow.append(dot(color, 6), h("span", { text: playerName(m.appId) }), musicWave());
        appRow.classList.toggle("playing", playing);
        title.textContent = m.title;
        artist.textContent = [m.artist, m.album].filter(Boolean).join(" · ");
        clear(playBtn);
        playBtn.append(svg(playing ? ICONS.pause : ICONS.play, 14));
        // A new track slides in, like a card does.
        if (newTrack) {
          info.classList.remove("swap");
          void info.offsetWidth;
          info.classList.add("swap");
        }
      }
      if (m.cover !== coverKey) {
        coverKey = m.cover;
        clear(cover);
        if (m.cover) {
          cover.append(h("img", { src: m.cover, alt: "" }));
          backdrop.src = m.cover;
          backdrop.style.opacity = "";
        } else {
          cover.append(svg(ICONS.music, 26, { stroke: 1.8 }));
          backdrop.removeAttribute("src");
          backdrop.style.opacity = "0";
        }
      }
      tick();
    },
  };
}
