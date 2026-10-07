// Notes, stored as one JSON document in notes.json under platform::config_dir().
// The island owns the shape of that document; Rust only checks it is JSON and
// writes it without ever leaving a half-written file behind.

use std::path::PathBuf;

use crate::platform::{config_dir, ensure_private_dir};

/// Far beyond any amount of typed notes; a guard against a runaway write.
const MAX_BYTES: usize = 32 * 1024 * 1024;

fn notes_path() -> PathBuf {
    config_dir().join("notes.json")
}

/// The stored document, or None when there are no notes yet.
pub fn load() -> std::io::Result<Option<String>> {
    match std::fs::read_to_string(notes_path()) {
        Ok(text) => Ok(Some(text)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err),
    }
}

pub fn save(json: &str) -> std::io::Result<()> {
    let invalid = |msg: String| std::io::Error::new(std::io::ErrorKind::InvalidData, msg);
    if json.len() > MAX_BYTES {
        return Err(invalid("notes are too large to save".into()));
    }
    serde_json::from_str::<serde_json::Value>(json).map_err(|e| invalid(e.to_string()))?;

    let dir = config_dir();
    ensure_private_dir(&dir)?;
    let path = notes_path();
    // Write next to the real file, then swap: a crash mid-write keeps the old notes.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json)?;
    std::fs::rename(&tmp, &path)
}
