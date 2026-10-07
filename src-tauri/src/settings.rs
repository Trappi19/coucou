// Preferences, stored as plain JSON in settings.json under platform::config_dir().
// No secret ever lands here — API keys live in the OS keychain (see secrets.rs).

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub sound_enabled: bool,
    pub sound_volume: f64,
    pub auto_close_interval: f64,
    pub absence_interval: f64,
    pub active_integrations: Vec<String>,
    /// "primary" = the main display, "cursor" = whichever display the mouse is on.
    pub screen: String,
    pub autostart: bool,
    pub hooks_installed: bool,
    /// Claude model used by the chat. Changeable in the settings window.
    /// Defaulted explicitly so a settings.json written by an older build still loads.
    #[serde(default = "default_model")]
    pub model: String,
    /// Who answers the chat: `BACKEND_CLAUDE_CODE` (the user's own Claude
    /// subscription, through the Claude Code CLI) or `BACKEND_API` (an API key).
    #[serde(default = "default_backend")]
    pub chat_backend: String,
    /// Claude Code model alias ("opus", "sonnet"…). Empty = the account's default.
    #[serde(default)]
    pub cli_model: String,
    /// Compact opens by itself when the cursor rests on it, no click needed.
    #[serde(default)]
    pub open_on_hover: bool,
    /// An open conversation folds like any other view (timer, click elsewhere)
    /// instead of staying up until it is folded by hand.
    #[serde(default)]
    pub fold_during_chat: bool,
    /// Island zoom picked by the user, compact and open separately. 1 = original size.
    #[serde(default = "default_scale")]
    pub compact_scale: f64,
    #[serde(default = "default_scale")]
    pub expanded_scale: f64,
}

fn default_scale() -> f64 {
    1.0
}

pub const BACKEND_CLAUDE_CODE: &str = "claudeCode";
pub const BACKEND_API: &str = "api";

fn default_model() -> String {
    crate::claude::DEFAULT_MODEL.to_string()
}

fn default_backend() -> String {
    BACKEND_CLAUDE_CODE.to_string()
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            sound_enabled: true,
            sound_volume: 0.12,
            auto_close_interval: 15.0,
            absence_interval: 180.0,
            active_integrations: vec![
                "integration_resend".into(),
                "integration_n8n".into(),
                "integration_vercel".into(),
                "integration_github".into(),
            ],
            screen: "primary".into(),
            autostart: false,
            hooks_installed: false,
            model: default_model(),
            chat_backend: default_backend(),
            cli_model: String::new(),
            open_on_hover: false,
            fold_during_chat: false,
            compact_scale: default_scale(),
            expanded_scale: default_scale(),
        }
    }
}

pub use crate::platform::{config_dir, local_dir};

pub fn hook_exe_path() -> PathBuf {
    local_dir().join("bin").join(crate::platform::HOOK_EXE)
}

fn settings_path() -> PathBuf {
    config_dir().join("settings.json")
}

pub fn load() -> Settings {
    match std::fs::read(settings_path()) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(_) => Settings::default(),
    }
}

pub fn save(settings: &Settings) -> std::io::Result<()> {
    let dir = config_dir();
    crate::platform::ensure_private_dir(&dir)?;
    let json = serde_json::to_vec_pretty(settings)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    std::fs::write(settings_path(), json)
}
