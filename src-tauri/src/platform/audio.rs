// How loud the music is right now, for the equalizer in the small island.
//
// Windows' peak meters (Core Audio): the level of the player's own audio
// session when it can be found (Spotify, a browser…), so a Discord call or a
// notification doesn't move the bars; the whole output otherwise. A number
// between 0 and 1 — nothing of the sound itself is read, and nothing leaves
// the machine.
//
// COM: every call is made from a thread that joined the multithreaded
// apartment (`join_apartment` in media.rs does it).

use ::windows::core::{Interface, PWSTR};
use ::windows::Win32::Foundation::CloseHandle;
use ::windows::Win32::Media::Audio::Endpoints::IAudioMeterInformation;
use ::windows::Win32::Media::Audio::{
    eConsole, eRender, IAudioSessionControl2, IAudioSessionManager2, IMMDeviceEnumerator, MMDeviceEnumerator,
};
use ::windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};
use ::windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};

/// The peak meters to read: the player's sessions, or the whole output.
pub struct AudioMeter {
    meters: Vec<IAudioMeterInformation>,
    /// True when the player's own sessions were found.
    pub per_app: bool,
}

// The meters are free-threaded COM objects, used from one thread at a time.
unsafe impl Send for AudioMeter {}

impl AudioMeter {
    /// The loudest of the meters, 0..1. None once the device is gone.
    pub fn peak(&self) -> Option<f32> {
        let mut best: Option<f32> = None;
        for m in &self.meters {
            if let Ok(v) = unsafe { m.GetPeakValue() } {
                best = Some(best.map_or(v, |b: f32| b.max(v)));
            }
        }
        best
    }
}

/// "Spotify.exe", "MSEdge", "SpotifyAB.SpotifyMusic_…!Spotify" → does a process
/// called `stem` ("spotify", "msedge") play for that player?
pub fn app_matches(app_id: &str, stem: &str) -> bool {
    stem.len() >= 3 && app_id.to_lowercase().contains(stem)
}

/// The executable's name without ".exe", lowercased ("spotify").
fn process_stem(pid: u32) -> Option<String> {
    if pid == 0 {
        return None;
    }
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 520];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len);
        let _ = CloseHandle(handle);
        ok.ok()?;
        let path = String::from_utf16_lossy(&buf[..len as usize]);
        let file = path.rsplit('\\').next()?.to_lowercase();
        Some(file.trim_end_matches(".exe").to_string())
    }
}

/// The meters for `app_id` on the default output, or the output's own meter.
pub fn audio_meter(app_id: &str) -> Option<AudioMeter> {
    unsafe {
        let devices: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).ok()?;
        let device = devices.GetDefaultAudioEndpoint(eRender, eConsole).ok()?;

        let mut meters = Vec::new();
        if !app_id.is_empty() {
            if let Ok(manager) = device.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) {
                if let Ok(sessions) = manager.GetSessionEnumerator() {
                    for i in 0..sessions.GetCount().unwrap_or(0) {
                        let Ok(session) = sessions.GetSession(i) else { continue };
                        let Ok(control) = session.cast::<IAudioSessionControl2>() else { continue };
                        let Ok(pid) = control.GetProcessId() else { continue };
                        let Some(stem) = process_stem(pid) else { continue };
                        if !app_matches(app_id, &stem) {
                            continue;
                        }
                        if let Ok(meter) = session.cast::<IAudioMeterInformation>() {
                            meters.push(meter);
                        }
                    }
                }
            }
        }
        if !meters.is_empty() {
            return Some(AudioMeter { meters, per_app: true });
        }
        let meter = device.Activate::<IAudioMeterInformation>(CLSCTX_ALL, None).ok()?;
        Some(AudioMeter { meters: vec![meter], per_app: false })
    }
}

#[cfg(test)]
mod tests {
    use super::app_matches;

    #[test]
    fn players_find_their_process() {
        assert!(app_matches("Spotify.exe", "spotify"));
        assert!(app_matches("SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify", "spotify"));
        assert!(app_matches("MSEdge", "msedge"));
        assert!(app_matches("Chrome", "chrome"));
        assert!(!app_matches("Spotify.exe", "discord"));
        // Too short to mean anything.
        assert!(!app_matches("Spotify.exe", "t"));
    }
}
