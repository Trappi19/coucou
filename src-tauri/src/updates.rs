// Local updates: no server, no network. `npm run release` builds a new
// installer and drops it, with a small latest.json, into
// %LOCALAPPDATA%\Coucou\updates. Coucou notices it, Mochi offers it, and one
// explicit click runs Tauri's own NSIS installer over the installed app:
//   /P       passive — a progress bar, no questions
//   /UPDATE  installs over the current version, without uninstalling it first
//   /R       starts Coucou again once it is done
// Settings, Credential Manager entries and Claude Code's files are untouched.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::{platform, settings};

/// How often the folder is looked at. One small file read: nothing at all for
/// the CPU, and a fresh build shows up a minute or so after it lands.
const CHECK_EVERY: Duration = Duration::from_secs(60);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    version: String,
    file: String,
    #[serde(default)]
    built_at: Option<String>,
}

#[derive(Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub path: String,
    pub built_at: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub current: String,
    pub folder: String,
    pub available: Option<UpdateInfo>,
}

pub fn updates_dir() -> PathBuf {
    settings::local_dir().join("updates")
}

fn current_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// "0.1.12" → [0, 1, 12]. Anything after a `-` (pre-release tag) is ignored.
fn parse_version(v: &str) -> Vec<u64> {
    v.trim()
        .trim_start_matches('v')
        .split('-')
        .next()
        .unwrap_or("")
        .split('.')
        .map(|n| n.parse().unwrap_or(0))
        .collect()
}

fn is_newer(candidate: &str, current: &str) -> bool {
    let (mut a, mut b) = (parse_version(candidate), parse_version(current));
    let len = a.len().max(b.len());
    a.resize(len, 0);
    b.resize(len, 0);
    a > b
}

/// The installer named by latest.json, if it is newer than this build and
/// really is an installer sitting in the updates folder.
pub fn check() -> Option<UpdateInfo> {
    let dir = updates_dir();
    let raw = std::fs::read(dir.join("latest.json")).ok()?;
    let manifest: Manifest = serde_json::from_slice(&raw).ok()?;
    if !is_newer(&manifest.version, current_version()) {
        return None;
    }
    // A bare file name only: latest.json must not point anywhere else.
    let name = Path::new(&manifest.file).file_name()?.to_str()?.to_string();
    if name != manifest.file || !name.to_lowercase().ends_with("-setup.exe") {
        return None;
    }
    let path = dir.join(&name);
    path.is_file().then(|| UpdateInfo {
        version: manifest.version,
        path: path.to_string_lossy().to_string(),
        built_at: manifest.built_at,
    })
}

pub fn status() -> UpdateStatus {
    UpdateStatus {
        current: current_version().to_string(),
        folder: updates_dir().to_string_lossy().to_string(),
        available: check(),
    }
}

/// Only ever called from an explicit click. Starts the installer, then quits so
/// nothing of ours is locked while it copies; it starts Coucou again itself.
pub fn install(app: &AppHandle) -> Result<(), String> {
    let update = check().ok_or_else(|| "No newer version in the updates folder.".to_string())?;
    crate::log::line(format!("update: installing {} from {}", update.version, update.path));
    let mut cmd = Command::new(&update.path);
    cmd.args(["/P", "/UPDATE", "/R"]);
    platform::no_console(&mut cmd)
        .spawn()
        .map_err(|e| format!("Could not start the installer: {e}"))?;
    app.exit(0);
    Ok(())
}

/// Watches the folder and tells both windows when a new version lands. Asleep
/// between looks; only latest.json's timestamp is read unless it changed.
pub fn start(app: AppHandle) {
    let _ = std::fs::create_dir_all(updates_dir());
    std::thread::spawn(move || {
        let manifest = updates_dir().join("latest.json");
        let mut seen: Option<SystemTime> = None;
        let mut announced: Option<UpdateInfo> = None;
        loop {
            let stamp = std::fs::metadata(&manifest).and_then(|m| m.modified()).ok();
            if stamp != seen {
                seen = stamp;
                let found = check();
                if found.is_some() && found != announced {
                    let _ = app.emit("update-available", found.clone());
                }
                announced = found;
            }
            std::thread::sleep(CHECK_EVERY);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_compare_numerically() {
        assert!(is_newer("0.1.10", "0.1.9"));
        assert!(is_newer("0.2.0", "0.1.99"));
        assert!(is_newer("1.0", "0.9.9"));
        assert!(!is_newer("0.1.1", "0.1.1"));
        assert!(!is_newer("0.1.0", "0.1.1"));
        assert!(!is_newer("0.1.1-beta", "0.1.1"));
    }
}
