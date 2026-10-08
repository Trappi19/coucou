// The music widget: watches what's playing (platform::now_playing — Windows'
// media session, so Spotify, a browser, Deezer…) and tells the island when it
// changes. The island moves the time along itself between two reports, so one
// look a second is plenty, and nothing is sent while nothing changes.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

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
            if !enabled || crate::integrations::PAUSED.load(std::sync::atomic::Ordering::Relaxed) {
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
