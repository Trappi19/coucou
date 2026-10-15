// The music widget. In compact, the island widens and shows what's playing —
// a little sound wave, the title, the artist and the time, a thin progress
// line along its bottom edge — while the Claude plan slides to the right. The
// music tab has the cover, the progress (click to seek) and the controls.
//
// The numbers come from Windows' media session (media.rs), so it works with
// Spotify, a browser tab, Deezer… whichever app is playing.

import { Bridge, IS_TAURI } from "../core/bridge";
import { canvasDpr } from "../core/scale";
import {
  formatTime, playerColor, playerName, positionNow, sameTrack, type MediaInfo,
} from "../core/media";
import { State } from "../core/state";
import { clear, dot, h, svg } from "./dom";
import { ICONS } from "./icons";
import { fadeSwap } from "./motion";
import type { ViewHost } from "./views";

/**
 * Paused this long, the music leaves the small island as if the player were
 * closed: Spotify left open in the background isn't music playing. It comes
 * back the moment it plays again; the music tab keeps it meanwhile.
 */
const IDLE_HIDE_MS = 60_000;

let idleTimer: number | null = null;

/** A new report from Rust; the cover only comes with a new track, so it is kept. */
export function setMedia(raw: MediaInfo | null): void {
  if (!raw || !raw.title) {
    State.media = null;
  } else {
    const prev = State.media;
    State.media = { ...raw, cover: raw.cover ?? (sameTrack(prev, raw) ? prev?.cover ?? null : null) };
  }
  // Paused: look again once the minute is up (Rust says nothing while nothing changes).
  if (idleTimer != null) window.clearTimeout(idleTimer);
  idleTimer = null;
  if (State.media && !State.media.playing) {
    idleTimer = window.setTimeout(() => {
      idleTimer = null;
      State.notify();
    }, IDLE_HIDE_MS + 250);
  }
  State.notify();
}

/** Paused for over a minute (`at` is when the player last reported, i.e. the pause). */
const idle = (m: MediaInfo, now = Date.now()): boolean => !m.playing && now - m.at >= IDLE_HIDE_MS;

/** The music is in the small island: the widget is on, and it plays or was just paused. */
export const musicShown = (): boolean =>
  State.settings.musicWidget && State.media != null && !idle(State.media);

/** Four bars dancing while it plays, resting low when paused. Pure CSS. */
export function musicWave(): HTMLElement {
  return h("span", { class: "mw-wave" }, h("i"), h("i"), h("i"), h("i"));
}

// ── Compact ───────────────────────────────────────────────────────────────────

export interface MusicCompact {
  el: HTMLElement;
  progress: HTMLElement;
  /** ⏮ ⏯ ⏭, shown over the status cluster while the cursor is on the island. */
  controls: HTMLElement;
  sync(): void;
}

/** One sample of the player's level this often while the equalizer plays. */
const EQ_EVERY_MS = 40;
/** Bar width and bar + gap, CSS pixels. */
const EQ_BAR = 2.5;
const EQ_PITCH = 4.5;

/**
 * The equalizer: bars pulsing out from its middle with how loud the player
 * really is (media.rs reads Windows' peak meter). Each sample enters at the
 * centre and moves outwards, fading, so the beat ripples across. The level is
 * scaled to the loudest moment of the last few seconds, so a quiet song moves
 * the bars as much as a loud one. Samples only while it plays and is seen;
 * paused, the bars settle flat and the timer stops.
 */
function buildEqualizer() {
  const canvas = h("canvas", { class: "mw-eq" }) as HTMLCanvasElement;
  /** Newest first. */
  const levels: number[] = [];
  let ceiling = 0.05;
  let timer: number | null = null;
  let busy = false;
  let appId = "";
  let playing = false;
  let color = "#a78bfa";

  function draw() {
    const w = canvas.clientWidth;
    const hh = canvas.clientHeight;
    if (w <= 0 || hh <= 0) return;
    const dpr = canvasDpr();
    const pw = Math.round(w * dpr);
    const ph = Math.round(hh * dpr);
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hh);
    ctx.fillStyle = color;
    const half = Math.floor(w / 2 / EQ_PITCH);
    for (let i = 0; i < half; i++) {
      const bh = Math.max(EQ_BAR, (levels[i] ?? 0) * hh);
      ctx.globalAlpha = 0.95 - (i / half) * 0.75;
      for (const side of [-1, 1]) {
        const x = w / 2 + side * (i * EQ_PITCH + EQ_PITCH / 2) - EQ_BAR / 2;
        ctx.beginPath();
        ctx.roundRect(x, (hh - bh) / 2, EQ_BAR, bh, EQ_BAR / 2);
        ctx.fill();
      }
    }
  }

  /** Outside Coucou (npm run dev) there is no meter: something that looks like music. */
  const fakeLevel = () => {
    const t = performance.now() / 1000;
    return Math.max(0, 0.45 + 0.35 * Math.sin(t * 7.3) * Math.sin(t * 2.1) + (Math.random() - 0.5) * 0.3);
  };

  async function sample() {
    if (busy) return;
    busy = true;
    let v = 0;
    if (playing) {
      const raw = IS_TAURI ? (await Bridge.audioLevel(appId)) ?? 0 : fakeLevel();
      ceiling = Math.max(raw, ceiling * 0.994, 0.04);
      v = Math.pow(Math.min(1, raw / ceiling), 0.85);
      // A touch of smoothing, so the bars swell rather than flicker.
      v = 0.65 * v + 0.35 * (levels[0] ?? 0);
    }
    busy = false;
    levels.unshift(v);
    if (levels.length > 80) levels.length = 80;
    draw();
    if (!playing && levels.every((x) => x < 0.01)) run(false);
  }

  function run(on: boolean) {
    if (on && timer == null) timer = window.setInterval(() => void sample(), EQ_EVERY_MS);
    if (!on && timer != null) {
      window.clearInterval(timer);
      timer = null;
    }
  }

  return {
    el: canvas,
    /** `on`: the widget is on screen. Playing samples; paused lets the bars settle. */
    set(on: boolean, m: MediaInfo | null, c: string) {
      color = c;
      appId = m?.appId ?? "";
      playing = on && m?.playing === true;
      if (playing) run(true);
      else if (on) run(levels.some((x) => x >= 0.01));
      else {
        run(false);
        levels.length = 0;
      }
      if (timer == null) draw();
    },
  };
}

/**
 * The time and the progress line need their own clock: the island's frame loop
 * is paused by WebView2 while nobody touches the window, so the music would
 * freeze until the mouse moved. A timer twice a second, only while it plays.
 */
function playClock(tick: () => void): (on: boolean) => void {
  let timer: number | null = null;
  return (on) => {
    if (on && timer == null) timer = window.setInterval(tick, 500);
    if (!on && timer != null) {
      window.clearInterval(timer);
      timer = null;
    }
  };
}

export function buildMusicCompact(): MusicCompact {
  const cover = h("span", { class: "mw-cover" });
  const title = h("span", { class: "mw-title" });
  const sub = h("span", { class: "mw-sub" });
  const time = h("span", { class: "mw-time" });
  const text = h("div", { class: "mw-text" }, title, h("div", { class: "mw-line" }, sub, time));
  // The cover and the words change together, so they fade together.
  const now = h("div", { class: "mw-now" }, cover, text);
  const eq = buildEqualizer();
  const el = h("div", { id: "music-compact" }, now, eq.el);
  const fill = h("i");
  const progress = h("div", { id: "music-progress" }, fill);

  // ⏮ ⏯ ⏭: a press here plays the music, it doesn't open the island.
  const playBtn = h("button", { class: "mc-btn mc-play", title: "Play / pause" });
  const prevBtn = h("button", { class: "mc-btn", title: "Previous" }, svg(ICONS.previous, 10));
  const nextBtn = h("button", { class: "mc-btn", title: "Next" }, svg(ICONS.next, 10));
  const controls = h("div", { id: "music-controls" }, prevBtn, playBtn, nextBtn);
  /** A play/pause that hasn't come back from the player yet. */
  let optimistic: boolean | null = null;
  let shownPlaying: boolean | null = null;
  const press = (btn: HTMLElement, action: "toggle" | "next" | "previous") => {
    btn.addEventListener("mousedown", (e) => e.stopPropagation());
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!State.media) return;
      if (action === "toggle") {
        optimistic = !(optimistic ?? State.media.playing);
        State.notify();
      }
      void Bridge.mediaControl(action).catch(() => {
        optimistic = null;
        State.notify();
      });
    });
  };
  press(prevBtn, "previous");
  press(playBtn, "toggle");
  press(nextBtn, "next");

  let key = "";
  let track = "";
  let coverKey: string | null | undefined = undefined;
  /** The old track is fading out: its time stays put until the new one comes in. */
  let fading = false;

  function write(m: MediaInfo) {
    title.textContent = m.title;
    sub.textContent = m.artist || playerName(m.appId);
    if (m.cover !== coverKey) {
      coverKey = m.cover;
      cover.replaceChildren(m.cover ? h("img", { src: m.cover, alt: "" }) : svg(ICONS.music, 11, { stroke: 2 }));
      cover.classList.toggle("none", !m.cover);
    }
  }

  function tick() {
    const m = State.media;
    if (!m) return;
    const pos = positionNow(m);
    if (!fading) time.textContent = m.durationMs > 0 ? formatTime(pos) : "";
    fill.style.width = m.durationMs > 0 ? `${(pos / m.durationMs) * 100}%` : "0%";
  }
  const clock = playClock(tick);

  return {
    el,
    progress,
    controls,
    sync() {
      const m = State.media;
      const on = musicShown() && State.mode === "compact";
      el.classList.toggle("on", on);
      progress.classList.toggle("on", on && (m?.durationMs ?? 0) > 0);
      clock(on && m?.playing === true);
      eq.set(on, m, m ? playerColor(m.appId) : "#a78bfa");
      if (!m) return;

      // The player answered: what it says wins over the guess.
      const playing = optimistic ?? m.playing;
      if (optimistic === m.playing) optimistic = null;
      if (playing !== shownPlaying) {
        shownPlaying = playing;
        playBtn.replaceChildren(svg(playing ? ICONS.pause : ICONS.play, 11));
      }
      // Another track (next, previous, a new video): the words fade over to it.
      // Not on the first one, nor while the widget isn't on screen.
      const nextTrack = `${m.appId}|${m.title}|${m.artist}`;
      if (nextTrack !== track) {
        const animate = track !== "" && on;
        track = nextTrack;
        if (animate) {
          fading = true;
          fadeSwap(now, () => {
            fading = false;
            write(State.media ?? m);
            tick();
          });
        } else {
          write(m);
        }
      } else if (!fading && m.cover !== coverKey) {
        // The cover can come a moment after the title.
        write(m);
      }
      const next = `${m.appId}|${m.playing}`;
      if (next !== key) {
        key = next;
        el.classList.toggle("playing", m.playing);
        const color = playerColor(m.appId);
        el.style.setProperty("--mw", color);
        progress.style.setProperty("--mw", color);
        controls.style.setProperty("--mw", color);
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
  const clock = playClock(tick);
  let shown = false;

  return {
    el,
    show() {
      shown = true;
      clock(State.media?.playing === true);
    },
    hide() {
      shown = false;
      clock(false);
    },
    sync() {
      const m = State.media;
      el.classList.toggle("nothing", !m);
      clock(shown && m?.playing === true);
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
