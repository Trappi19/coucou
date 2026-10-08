// What's playing, as Rust reports it (media.rs: Windows' media session — Spotify,
// a browser, Deezer…). No DOM: the compact widget and the music tab read it.

export interface MediaInfo {
  appId: string;
  title: string;
  artist: string;
  album: string;
  playing: boolean;
  positionMs: number;
  durationMs: number;
  /** When positionMs was true (epoch ms): the time moves on from there while playing. */
  at: number;
  /** data: URL of the cover, kept across updates of the same track. */
  cover?: string | null;
}

/** Where the track is now, moved on since the last report while it plays. */
export function positionNow(m: MediaInfo, now = Date.now()): number {
  const pos = m.playing ? m.positionMs + (now - m.at) : m.positionMs;
  return m.durationMs > 0 ? Math.min(m.durationMs, Math.max(0, pos)) : Math.max(0, pos);
}

/** 83_000 → "1:23", 3_723_000 → "1:02:03". */
export function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** A player's name from its App User Model ID ("Spotify.exe", "MSEdge"…). */
export function playerName(appId: string): string {
  const id = appId.toLowerCase();
  const known: [string, string][] = [
    ["spotify", "Spotify"],
    ["msedge", "Edge"],
    ["chrome", "Chrome"],
    ["firefox", "Firefox"],
    ["opera", "Opera"],
    ["brave", "Brave"],
    ["deezer", "Deezer"],
    ["zunemusic", "Media Player"],
    ["vlc", "VLC"],
    ["applemusic", "Apple Music"],
    ["tidal", "TIDAL"],
  ];
  const hit = known.find(([key]) => id.includes(key));
  if (hit) return hit[1];
  const base = appId.split("!").pop()?.replace(/\.exe$/i, "").split(/[\\/.]/).pop() ?? "";
  return base || "Music";
}

/** Spotify's green for Spotify, Mochi's violet for anything else. */
export function playerColor(appId: string): string {
  return appId.toLowerCase().includes("spotify") ? "#1DB954" : "#A78BFA";
}

/** The same track as before (same player, title, artist): its cover can stay. */
export const sameTrack = (a: MediaInfo | null, b: MediaInfo | null): boolean =>
  !!a && !!b && a.appId === b.appId && a.title === b.title && a.artist === b.artist;
