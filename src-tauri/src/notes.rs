// Notes and reminders, each stored as one JSON document under
// platform::config_dir() (notes.json, reminders.json). The island owns the
// shape of those documents; Rust only checks they are JSON and writes them
// without ever leaving a half-written file behind.

use std::path::PathBuf;

use crate::platform::{config_dir, ensure_private_dir};

/// Far beyond any amount of typed notes; a guard against a runaway write.
const MAX_BYTES: usize = 32 * 1024 * 1024;

/// The documents the island may keep. Nothing else can be named from the page.
#[derive(Clone, Copy)]
pub enum Doc {
    Notes,
    Reminders,
}

fn doc_path(doc: Doc) -> PathBuf {
    config_dir().join(match doc {
        Doc::Notes => "notes.json",
        Doc::Reminders => "reminders.json",
    })
}

/// The stored document, or None when there is none yet.
pub fn load(doc: Doc) -> std::io::Result<Option<String>> {
    match std::fs::read_to_string(doc_path(doc)) {
        Ok(text) => Ok(Some(text)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err),
    }
}

pub fn save(doc: Doc, json: &str) -> std::io::Result<()> {
    let invalid = |msg: String| std::io::Error::new(std::io::ErrorKind::InvalidData, msg);
    if json.len() > MAX_BYTES {
        return Err(invalid("notes are too large to save".into()));
    }
    serde_json::from_str::<serde_json::Value>(json).map_err(|e| invalid(e.to_string()))?;

    let dir = config_dir();
    ensure_private_dir(&dir)?;
    let path = doc_path(doc);
    // Write next to the real file, then swap: a crash mid-write keeps the old notes.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json)?;
    std::fs::rename(&tmp, &path)
}
