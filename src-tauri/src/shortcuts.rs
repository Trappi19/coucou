// Global keyboard shortcuts — a lighter take on upstream Coucou's shortcuts.rs
// (itself HotKeyCenter.swift). Registered with tauri-plugin-global-shortcut
// (RegisterHotKey on Windows); a press reaches the island as a `shortcut` event
// carrying the action id, and the island does the rest, as with the tray menu.
//
// The default keys are upstream's. Ctrl+Alt *is* AltGr on most European
// layouts, so a global Ctrl+Alt+E would swallow every € typed on a French
// keyboard; upstream checked these against the AltGr layer of the French,
// German, Spanish, Italian and Portuguese layouts. Notes is this fork's own.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::str::FromStr;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::island::WINDOW_LABEL;

/// Action id (stored in settings.json: never rename one), default keys, label.
pub const ACTIONS: &[(&str, &str, &str)] = &[
    ("openChat", "Ctrl+Alt+Space", "Open the chat"),
    ("toggleIsland", "Ctrl+Alt+N", "Open / fold the island"),
    ("goToAlert", "Ctrl+Alt+A", "Show what's waiting for you"),
    ("jumpToTerminal", "Ctrl+Alt+T", "Open the session's folder"),
    ("nextPill", "Ctrl+Alt+Right", "Next pill"),
    ("prevPill", "Ctrl+Alt+Left", "Previous pill"),
    ("muteToggle", "Ctrl+Alt+S", "Mute / unmute Mochi"),
    ("openNotes", "Ctrl+Alt+O", "Open the notes"),
    ("openUsage", "Ctrl+Alt+U", "Show the Claude plan usage"),
];

/// What the user chose for one action. Missing from settings.json = the default.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Binding {
    pub keys: String,
    pub enabled: bool,
}

impl Default for Binding {
    fn default() -> Self {
        Self { keys: String::new(), enabled: true }
    }
}

pub type Bindings = BTreeMap<String, Binding>;

fn effective(id: &str, default_keys: &str, stored: &Bindings) -> Binding {
    stored
        .get(id)
        .cloned()
        .unwrap_or_else(|| Binding { keys: default_keys.to_string(), enabled: true })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    Active,
    Off,
    /// Another app already holds this combination.
    InUse,
    /// Another Coucou shortcut has the same combination.
    Duplicate,
    /// Not a combination Windows can register.
    Invalid,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionStatus {
    pub id: &'static str,
    pub label: &'static str,
    pub keys: String,
    pub default_keys: &'static str,
    pub enabled: bool,
    pub status: Status,
}

/// What is registered right now: shortcut id → action id, plus the last report.
#[derive(Default)]
pub struct Registry {
    by_id: Mutex<HashMap<u32, &'static str>>,
    report: Mutex<Vec<ActionStatus>>,
}

/// The plugin, with the handler that turns a press into a `shortcut` event.
pub fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, shortcut, event| {
            if event.state() != ShortcutState::Pressed {
                return;
            }
            let action = app
                .try_state::<Registry>()
                .and_then(|r| r.by_id.lock().unwrap().get(&shortcut.id()).copied());
            if let Some(action) = action {
                let _ = app.emit_to(WINDOW_LABEL, "shortcut", action);
            }
        })
        .build()
}

/// (Re-)registers every shortcut from the settings. Called at launch and
/// whenever the settings change.
pub fn apply(app: &AppHandle, stored: &Bindings) {
    let Some(registry) = app.try_state::<Registry>() else { return };
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    let mut by_id = HashMap::new();
    let mut taken = HashSet::new();
    let mut report = Vec::new();

    for &(id, default_keys, label) in ACTIONS {
        let binding = effective(id, default_keys, stored);
        let status = if !binding.enabled || binding.keys.trim().is_empty() {
            Status::Off
        } else {
            match Shortcut::from_str(binding.keys.trim()) {
                Err(_) => Status::Invalid,
                Ok(shortcut) if !taken.insert(shortcut.id()) => Status::Duplicate,
                Ok(shortcut) => match gs.register(shortcut) {
                    Ok(()) => {
                        by_id.insert(shortcut.id(), id);
                        Status::Active
                    }
                    Err(_) => Status::InUse,
                },
            }
        };
        report.push(ActionStatus {
            id,
            label,
            keys: binding.keys,
            default_keys,
            enabled: binding.enabled,
            status,
        });
    }
    *registry.by_id.lock().unwrap() = by_id;
    *registry.report.lock().unwrap() = report;
}

pub fn report(app: &AppHandle) -> Vec<ActionStatus> {
    app.try_state::<Registry>()
        .map(|r| r.report.lock().unwrap().clone())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_default_parses_and_none_repeat() {
        let mut seen = HashSet::new();
        for &(id, keys, _) in ACTIONS {
            let shortcut = Shortcut::from_str(keys).unwrap_or_else(|_| panic!("{id}: {keys}"));
            assert!(seen.insert(shortcut.id()), "{id} repeats another default");
        }
    }

    #[test]
    fn stored_bindings_win_over_defaults() {
        let mut stored = Bindings::new();
        stored.insert("openChat".into(), Binding { keys: "Ctrl+Alt+K".into(), enabled: false });
        assert_eq!(effective("openChat", "Ctrl+Alt+Space", &stored).keys, "Ctrl+Alt+K");
        assert!(!effective("openChat", "Ctrl+Alt+Space", &stored).enabled);
        assert_eq!(effective("muteToggle", "Ctrl+Alt+S", &stored).keys, "Ctrl+Alt+S");
    }
}
