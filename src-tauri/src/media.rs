// The music widget: watches what's playing (platform::now_playing — Windows'
// media session, so Spotify, a browser, Deezer…) and tells the island when it
// changes. The island moves the time along itself between two reports, so one
// look a second is plenty, and nothing is sent while nothing changes.

use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::island::WINDOW_LABEL;
use crate::platform::{self, NowPlaying};

const LOOK_EVERY: Duration = Duration::from_millis(1000);
/// A position further than this from where it should be is a seek.
const SEEK_TOLERANCE_MS: i64 = 2500;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct MediaUpdate {
    app_id: String,
    title: String,
    artist: String,
    album: String,
    playing: bool,
    position_ms: u64,
    duration_ms: u64,
    /// When position_ms was true (epoch ms): the island counts on from there.
    at: u64,
    /// The cover as a data: URL, sent with each new track only.
    #[serde(skip_serializing_if = "Option::is_none")]
    cover: Option<String>,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn track_key(n: &NowPlaying) -> String {
    format!("{}\u{1}{}\u{1}{}", n.app_id, n.title, n.artist)
}

/// Worth telling the island: another track, play/pause, or a seek.
fn changed(old: &NowPlaying, old_at: u64, new: &NowPlaying, now: u64) -> bool {
    if track_key(old) != track_key(new) || old.playing != new.playing || old.duration_ms != new.duration_ms {
        return true;
    }
    let expected = old.position_ms as i64 + if old.playing { (now - old_at) as i64 } else { 0 };
    (new.position_ms as i64 - expected).abs() > SEEK_TOLERANCE_MS
}

fn cover() -> Option<String> {
    let (mime, bytes) = platform::media_thumbnail()?;
    Some(format!("data:{mime};base64,{}", crate::claude::base64_for(&bytes)))
}

pub fn start(app: AppHandle) {
    start_meter();
    std::thread::spawn(move || {
        platform::join_apartment();
        let mut last: Option<(NowPlaying, u64)> = None;
        loop {
            std::thread::sleep(LOOK_EVERY);
            // Paused means paused, and a widget turned off looks at nothing.
            let enabled = app
                .try_state::<crate::Shared>()
                .map(|s| s.settings.lock().unwrap().music_widget)
                .unwrap_or(true);
            if !enabled || crate::integrations::PAUSED.load(Ordering::Relaxed) {
                if last.take().is_some() {
                    let _ = app.emit_to(WINDOW_LABEL, "media", Option::<MediaUpdate>::None);
                }
                continue;
            }
            let now = now_ms();
            let current = platform::now_playing();
            match (&last, current) {
                (None, None) => {}
                (Some(_), None) => {
                    last = None;
                    let _ = app.emit_to(WINDOW_LABEL, "media", Option::<MediaUpdate>::None);
                }
                (prev, Some(n)) => {
                    let new_track = prev.as_ref().map_or(true, |(p, _)| track_key(p) != track_key(&n));
                    let send = prev.as_ref().map_or(true, |(p, at)| changed(p, *at, &n, now));
                    if send {
                        let update = MediaUpdate {
                            app_id: n.app_id.clone(),
                            title: n.title.clone(),
                            artist: n.artist.clone(),
                            album: n.album.clone(),
                            playing: n.playing,
                            position_ms: n.position_ms,
                            duration_ms: n.duration_ms,
                            at: now,
                            cover: if new_track { cover() } else { None },
                        };
                        let _ = app.emit_to(WINDOW_LABEL, "media", Some(update));
                        last = Some((n, now));
                    }
                }
            }
        }
    });
}

// ── Level, for the equalizer ──────────────────────────────────────────────────
//
// The island asks for the level ~30 times a second while its equalizer is on
// screen. A thread reads the peak meter at that pace and keeps the last value;
// when nobody has asked for a moment it lets go of the meter and sleeps, so a
// folded island or a paused track costs nothing.

static LEVEL: AtomicU32 = AtomicU32::new(0);
static ASKED_AT: AtomicU64 = AtomicU64::new(0);
static LEVEL_APP: Mutex<String> = Mutex::new(String::new());
static METER_THREAD: OnceLock<std::thread::Thread> = OnceLock::new();

const LEVEL_EVERY: Duration = Duration::from_millis(33);
/// Nobody asked for this long: the meter thread goes to sleep.
const LEVEL_IDLE_AFTER_MS: u64 = 1500;
/// Sessions come and go (another tab, headphones plugged in): look again this often.
const METER_REFRESH: Duration = Duration::from_secs(3);

/// The last level of `app_id`'s audio, 0..1 (wakes the meter thread if needed).
pub fn level(app_id: String) -> f32 {
    ASKED_AT.store(now_ms(), Ordering::Relaxed);
    *LEVEL_APP.lock().unwrap() = app_id;
    if let Some(t) = METER_THREAD.get() {
        t.unpark();
    }
    f32::from_bits(LEVEL.load(Ordering::Relaxed))
}

fn start_meter() {
    let handle = std::thread::spawn(|| {
        platform::join_apartment();
        let mut meter: Option<(platform::AudioMeter, String, Instant)> = None;
        loop {
            if now_ms().saturating_sub(ASKED_AT.load(Ordering::Relaxed)) > LEVEL_IDLE_AFTER_MS {
                meter = None;
                LEVEL.store(0f32.to_bits(), Ordering::Relaxed);
                std::thread::park();
                continue;
            }
            let app = LEVEL_APP.lock().unwrap().clone();
            let stale = meter.as_ref().map_or(true, |(_, a, at)| *a != app || at.elapsed() > METER_REFRESH);
            if stale {
                meter = platform::audio_meter(&app).map(|m| (m, app, Instant::now()));
                if meter.is_none() {
                    std::thread::sleep(Duration::from_secs(1));
                    continue;
                }
            }
            match meter.as_ref().and_then(|(m, _, _)| m.peak()) {
                Some(v) => LEVEL.store(v.clamp(0.0, 1.0).to_bits(), Ordering::Relaxed),
                None => meter = None,
            }
            std::thread::sleep(LEVEL_EVERY);
        }
    });
    let _ = METER_THREAD.set(handle.thread().clone());
}

/// The music tab's buttons. Blocking WinRT calls: run off the main thread.
pub async fn control(action: String, position_ms: Option<u64>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        platform::join_apartment();
        platform::media_control(&action, position_ms)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track(title: &str, playing: bool, pos: u64) -> NowPlaying {
        NowPlaying {
            app_id: "Spotify.exe".into(),
            title: title.into(),
            artist: "Artist".into(),
            album: String::new(),
            playing,
            position_ms: pos,
            duration_ms: 200_000,
        }
    }

    #[test]
    fn only_real_changes_are_sent() {
        let old = track("A", true, 10_000);
        // Playing on, a second later, where it should be: nothing to say.
        assert!(!changed(&old, 0, &track("A", true, 11_000), 1_000));
        // Seek, pause, another track: all worth telling.
        assert!(changed(&old, 0, &track("A", true, 60_000), 1_000));
        assert!(changed(&old, 0, &track("A", false, 11_000), 1_000));
        assert!(changed(&old, 0, &track("B", true, 0), 1_000));
        // Paused, still paused at the same spot: nothing.
        let paused = track("A", false, 10_000);
        assert!(!changed(&paused, 0, &track("A", false, 10_000), 5_000));
    }
}
