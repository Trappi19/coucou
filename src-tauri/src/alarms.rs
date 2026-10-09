// Alarms for the timer and the reminders. The waiting is done here rather than
// in the page: a webview that believes it is out of sight throttles its own
// timers, down to once a minute, and an alarm has to go off on time with the
// island folded.
//
// Each alarm is a wall-clock time. It is checked against the clock at least
// every half minute, so a PC that slept through it rings as soon as it wakes
// and a clock change is followed.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter};

/// Longest nap between two looks at the clock.
const CHECK_EVERY: Duration = Duration::from_secs(30);

/// The current generation of each alarm: setting it again silences the old one.
fn generations() -> &'static Mutex<HashMap<String, u64>> {
    static MAP: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn current(id: &str, generation: u64) -> bool {
    generations().lock().unwrap().get(id) == Some(&generation)
}

/// Rings `id` ("alarm-due" to the island) at `at_ms` (ms since the epoch), or
/// calls it off (None).
pub fn set(app: &AppHandle, id: String, at_ms: Option<u64>) {
    let generation = {
        let mut map = generations().lock().unwrap();
        let next = map.get(&id).copied().unwrap_or(0) + 1;
        if at_ms.is_some() {
            map.insert(id.clone(), next);
        } else {
            map.remove(&id);
        }
        next
    };
    let Some(at) = at_ms else { return };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            if !current(&id, generation) {
                return;
            }
            let now = now_ms();
            if now >= at {
                break;
            }
            tokio::time::sleep(Duration::from_millis(at - now).min(CHECK_EVERY)).await;
        }
        let fire = {
            let mut map = generations().lock().unwrap();
            let fire = map.get(&id) == Some(&generation);
            if fire {
                map.remove(&id);
            }
            fire
        };
        if fire {
            let _ = app.emit_to(crate::island::WINDOW_LABEL, "alarm-due", id);
        }
    });
}
