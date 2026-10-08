// What's playing, from Windows' own media session (System Media Transport
// Controls — what the volume flyout shows): Spotify, a browser tab, Deezer,
// VLC… whichever app Windows considers current. Title, artist, cover,
// position, and play/pause/next/previous. No account, no network: the app
// playing hands this to Windows, and Windows to us.
//
// WinRT: every call is made from a thread that joined the multithreaded
// apartment (`join_apartment`).

use std::time::{SystemTime, UNIX_EPOCH};

use ::windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession as Session,
    GlobalSystemMediaTransportControlsSessionManager as Manager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
};
use ::windows::Storage::Streams::DataReader;
use ::windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};

/// One snapshot of the current session.
#[derive(Debug, Clone, PartialEq)]
pub struct NowPlaying {
    /// App User Model ID of the player ("Spotify.exe", "MSEdge"…).
    pub app_id: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub playing: bool,
    /// Where it is now, already moved on since the player last reported it.
    pub position_ms: u64,
    /// 0 when the player gives no length (live streams, some browsers).
    pub duration_ms: u64,
}

/// WinRT needs the calling thread in an apartment. Harmless if it already is.
pub fn join_apartment() {
    unsafe {
        let _ = RoInitialize(RO_INIT_MULTITHREADED);
    }
}

fn manager() -> Option<Manager> {
    Manager::RequestAsync().ok()?.get().ok()
}

fn session() -> Option<Session> {
    manager()?.GetCurrentSession().ok()
}

/// WinRT DateTime: 100 ns ticks since 1601-01-01.
const TICKS_1601_TO_1970: i64 = 116_444_736_000_000_000;

fn now_ticks() -> i64 {
    let since_1970 = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos() / 100).unwrap_or(0);
    since_1970 as i64 + TICKS_1601_TO_1970
}

pub fn now_playing() -> Option<NowPlaying> {
    let session = session()?;
    let props = session.TryGetMediaPropertiesAsync().ok()?.get().ok()?;
    let title = props.Title().ok()?.to_string();
    if title.trim().is_empty() {
        return None;
    }
    let playing = session
        .GetPlaybackInfo()
        .and_then(|info| info.PlaybackStatus())
        .map(|status| status == Status::Playing)
        .unwrap_or(false);

    let (mut position, mut duration) = (0i64, 0i64);
    if let Ok(timeline) = session.GetTimelineProperties() {
        let start = timeline.StartTime().map(|t| t.Duration).unwrap_or(0);
        let end = timeline.EndTime().map(|t| t.Duration).unwrap_or(0);
        duration = (end - start).max(0);
        position = timeline.Position().map(|t| t.Duration - start).unwrap_or(0);
        // Players report the position now and then, not every second: add the
        // time since, while it plays.
        if playing {
            if let Ok(updated) = timeline.LastUpdatedTime() {
                let since = now_ticks() - updated.UniversalTime;
                if since > 0 && updated.UniversalTime > 0 {
                    position += since;
                }
            }
        }
        if duration > 0 {
            position = position.clamp(0, duration);
        }
    }

    Some(NowPlaying {
        app_id: session.SourceAppUserModelId().map(|s| s.to_string()).unwrap_or_default(),
        title,
        artist: props.Artist().map(|s| s.to_string()).unwrap_or_default(),
        album: props.AlbumTitle().map(|s| s.to_string()).unwrap_or_default(),
        playing,
        position_ms: (position.max(0) / 10_000) as u64,
        duration_ms: (duration / 10_000) as u64,
    })
}

/// The cover, as the player gave it: (MIME type, bytes). Capped at 2 MB.
pub fn media_thumbnail() -> Option<(String, Vec<u8>)> {
    let props = session()?.TryGetMediaPropertiesAsync().ok()?.get().ok()?;
    let stream = props.Thumbnail().ok()?.OpenReadAsync().ok()?.get().ok()?;
    let size = stream.Size().ok()?;
    if size == 0 || size > 2 * 1024 * 1024 {
        return None;
    }
    let mime = stream.ContentType().map(|s| s.to_string()).unwrap_or_default();
    let reader = DataReader::CreateDataReader(&stream.GetInputStreamAt(0).ok()?).ok()?;
    let loaded = reader.LoadAsync(size as u32).ok()?.get().ok()?;
    let mut bytes = vec![0u8; loaded as usize];
    reader.ReadBytes(&mut bytes).ok()?;
    let mime = if mime.starts_with("image/") { mime } else { "image/png".to_string() };
    Some((mime, bytes))
}

/// play/pause, next, previous, or seek (to `position_ms`).
pub fn media_control(action: &str, position_ms: Option<u64>) -> Result<(), String> {
    let session = session().ok_or("Nothing is playing.")?;
    let op = match action {
        "toggle" => session.TryTogglePlayPauseAsync(),
        "next" => session.TrySkipNextAsync(),
        "previous" => session.TrySkipPreviousAsync(),
        "seek" => {
            let start = session
                .GetTimelineProperties()
                .and_then(|t| t.StartTime())
                .map(|t| t.Duration)
                .unwrap_or(0);
            let ticks = position_ms.unwrap_or(0) as i64 * 10_000 + start;
            session.TryChangePlaybackPositionAsync(ticks)
        }
        _ => return Err(format!("Unknown media action: {action}")),
    };
    let accepted = op.and_then(|op| op.get()).map_err(|e| e.to_string())?;
    if accepted {
        Ok(())
    } else {
        Err("The player didn't accept that.".into())
    }
}
