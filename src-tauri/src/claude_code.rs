// Chat through Claude Code, on the user's own Claude subscription.
//
// Anthropic does not let third-party apps sign in with a claude.ai account, so
// Mochi never touches a login token. It runs the official `claude` executable
// in print mode — exactly what `claude -p` does in a terminal — and reads its
// JSON. The login, the plan's limits and the conversation files all stay Claude
// Code's own, which is also what makes resuming work: the projects and sessions
// listed here are the ones in ~/.claude/projects.

use std::collections::HashSet;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{mpsc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use crate::claude::{ChatContext, ChatReply};
use crate::{files, island, platform, settings};

/// Where a conversation lands when the user hasn't picked a project.
pub const DEFAULT_PROJECT: &str = "Discussion";

/// Mochi reads and searches. It never edits, runs commands or starts MCP servers.
const TOOLS: &str = "Read,Glob,Grep,WebSearch,WebFetch";

/// A turn with a few web searches takes a minute; past this it is stuck.
const TURN_TIMEOUT: Duration = Duration::from_secs(600);

/// Set on every run so coucou-hook stays silent: Mochi's own conversations are
/// not Claude Code sessions to show on the island.
const SILENCE_HOOK_VAR: &str = "COUCOU_MOCHI_CHAT";

/// Left behind by a parent Claude Code session, these make the child believe it
/// is nested inside another one. An API key in the environment would also win
/// over the subscription login and bill the API instead.
const SCRUBBED_ENV: &[&str] = &[
    "CLAUDECODE",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_SSE_PORT",
    "ANTHROPIC_API_KEY",
];

const MAX_PROJECTS: usize = 40;
const MAX_SESSIONS: usize = 40;
const MAX_HISTORY: usize = 40;

const SYSTEM_PROMPT: &str = "You are Mochi, a personal AI companion living at the top of the user's screen, \
talking to them through a small chat bubble. You can read files and search the web. \
Help with absolutely anything: questions, research, advice, the project you are opened in, or just a chat. \
Respond in the user's language. No markdown formatting (no **, no ##, no bullet dashes). \
Use plain text with line breaks. Context about a dropped file or window arrives in a mochi-context block before the message.";

const NOT_INSTALLED: &str = "Claude Code isn't installed. Install it (or the Claude desktop app), \
or switch Mochi to an API key in Settings.";
const NOT_LOGGED_IN: &str = "Claude Code isn't logged in (or the login expired). Open a terminal, \
run `claude`, type /login and sign in with your Claude account.";

const RUNNING: u8 = 0;
const CANCELLED: u8 = 1;
const TIMED_OUT: u8 = 2;

#[derive(Default)]
pub struct CliChat {
    current: Mutex<Current>,
    /// The turn in flight, so Stop and the timeout can end it.
    running: Mutex<Option<Child>>,
    stop_reason: AtomicU8,
}

#[derive(Default)]
struct Current {
    /// None = the Discussion project.
    project: Option<PathBuf>,
    session_id: Option<String>,
}

impl CliChat {
    /// Next message starts a new conversation, in the same project.
    pub fn reset(&self) {
        self.current.lock().unwrap().session_id = None;
    }

    pub fn cancel(&self) {
        self.stop(CANCELLED);
    }

    fn stop(&self, reason: u8) {
        if let Some(child) = self.running.lock().unwrap().as_mut() {
            self.stop_reason.store(reason, Ordering::Relaxed);
            let _ = child.kill();
        }
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub name: String,
    pub path: String,
    pub is_default: bool,
    /// Last activity, milliseconds since the epoch (0 = never).
    pub updated: u64,
    pub sessions: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: String,
    pub title: String,
    pub updated: u64,
}

#[derive(Serialize)]
pub struct HistoryMessage {
    pub role: &'static str,
    pub content: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliStatus {
    pub found: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub logged_in: bool,
}

#[derive(Serialize, Clone)]
struct Activity {
    tool: String,
    label: String,
}

/// A piece of the answer as it is written. `reset` = a new message starts, and
/// what was streamed so far (the words before a tool call) is not the answer.
#[derive(Serialize, Clone)]
struct ChatDelta {
    text: String,
    reset: bool,
}

// ── The executable ───────────────────────────────────────────────────────────

pub fn find_cli() -> Option<PathBuf> {
    platform::find_on_path("claude")
        .or_else(|| platform::claude_cli_candidates().into_iter().find(|p| p.is_file()))
}

fn base_command(exe: &Path) -> Command {
    let mut cmd = Command::new(exe);
    for var in SCRUBBED_ENV {
        cmd.env_remove(var);
    }
    platform::no_console(&mut cmd);
    cmd
}

pub fn status() -> CliStatus {
    let exe = find_cli();
    let version = exe.as_ref().and_then(|p| {
        let out = base_command(p)
            .arg("--version")
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .ok()?;
        out.status
            .success()
            .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
            .filter(|v| !v.is_empty())
    });
    // Claude Code's own verdict: a credentials file can be there and expired.
    let logged_in = exe.as_ref().is_some_and(|p| {
        base_command(p)
            .args(["auth", "status", "--json"])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .ok()
            .and_then(|out| serde_json::from_slice::<Value>(&out.stdout).ok())
            .and_then(|v| v.get("loggedIn").and_then(Value::as_bool))
            .unwrap_or(false)
    });
    CliStatus {
        found: exe.is_some(),
        path: exe.map(|p| p.to_string_lossy().to_string()),
        version,
        logged_in,
    }
}

// ── One chat turn ────────────────────────────────────────────────────────────

pub async fn send(
    app: AppHandle,
    model: String,
    query: String,
    context: Option<ChatContext>,
) -> Result<ChatReply, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let chat = app.state::<CliChat>();
        run_turn(&app, &chat, &model, &query, context.as_ref())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn run_turn(
    app: &AppHandle,
    chat: &CliChat,
    model: &str,
    query: &str,
    context: Option<&ChatContext>,
) -> Result<ChatReply, String> {
    let exe = find_cli().ok_or_else(|| NOT_INSTALLED.to_string())?;
    let (project, resume) = {
        let current = chat.current.lock().unwrap();
        (
            current.project.clone().unwrap_or_else(discussion_dir),
            current.session_id.clone(),
        )
    };
    std::fs::create_dir_all(discussion_dir()).map_err(|e| e.to_string())?;
    if !project.is_dir() {
        return Err(format!("{} no longer exists.", project.display()));
    }
    // --add-dir refuses a folder that isn't there.
    let inbox = files::inbox_dir();
    let _ = std::fs::create_dir_all(&inbox);

    // Context rides along with the first message only, as with the API.
    let prompt = match (resume.is_none(), context) {
        (true, Some(ctx)) => format!("{}\n\n{query}", context_block(ctx)),
        _ => query.to_string(),
    };

    let mut cmd = base_command(&exe);
    cmd.args(["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"])
        .args(["--append-system-prompt", SYSTEM_PROMPT])
        .args(["--tools", TOOLS, "--allowedTools", TOOLS])
        .arg("--strict-mcp-config");
    // Aliases only ("opus", "sonnet"…): nothing that could read as another flag.
    if !model.is_empty() && model.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.') {
        cmd.args(["--model", model]);
    }
    if let Some(id) = &resume {
        cmd.args(["--resume", id]);
    }
    // Variadic, so it goes last. Dropped files are copied there, outside the project.
    cmd.arg("--add-dir").arg(&inbox);
    cmd.current_dir(&project)
        .env(SILENCE_HOOK_VAR, "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| format!("Could not start Claude Code: {e}"))?;
    let stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    chat.stop_reason.store(RUNNING, Ordering::Relaxed);
    *chat.running.lock().unwrap() = Some(child);

    // The prompt goes in on stdin: no command-line quoting to get wrong. Dropping
    // the handle closes it, which is what tells Claude Code the prompt is complete.
    if let Some(mut stdin) = stdin {
        let _ = stdin.write_all(prompt.as_bytes());
    }

    let stderr_reader = std::thread::spawn(move || {
        let mut text = String::new();
        if let Some(mut err) = stderr {
            let _ = err.read_to_string(&mut text);
        }
        text
    });

    let (done_tx, done_rx) = mpsc::channel::<()>();
    let watchdog_app = app.clone();
    std::thread::spawn(move || {
        if done_rx.recv_timeout(TURN_TIMEOUT) == Err(mpsc::RecvTimeoutError::Timeout) {
            watchdog_app.state::<CliChat>().stop(TIMED_OUT);
        }
    });

    let mut session: Option<String> = None;
    let mut result: Option<Value> = None;
    if let Some(out) = stdout {
        for line in BufReader::new(out).lines() {
            let Ok(line) = line else { break };
            let Ok(event) = serde_json::from_str::<Value>(&line) else { continue };
            if let Some(id) = event.get("session_id").and_then(Value::as_str) {
                session = Some(id.to_string());
            }
            match event.get("type").and_then(Value::as_str) {
                Some("assistant") => report_tools(app, &event),
                Some("stream_event") => stream_text(app, &event),
                Some("result") => result = Some(event),
                _ => {}
            }
        }
    }
    let _ = done_tx.send(());
    if let Some(mut child) = chat.running.lock().unwrap().take() {
        let _ = child.wait();
    }
    let stderr_text = stderr_reader.join().unwrap_or_default();

    let reason = chat.stop_reason.swap(RUNNING, Ordering::Relaxed);
    let succeeded = result.as_ref().is_some_and(|r| {
        r.get("subtype").and_then(Value::as_str) == Some("success")
            && !r.get("is_error").and_then(Value::as_bool).unwrap_or(false)
    });
    // A stopped turn still left the question in the session, so the next one
    // carries on from it rather than starting over.
    if succeeded || reason == CANCELLED {
        if let Some(id) = &session {
            let mut current = chat.current.lock().unwrap();
            if current.project.clone().unwrap_or_else(discussion_dir) == project {
                current.session_id = Some(id.clone());
            }
        }
    }

    match reason {
        CANCELLED => return Err("Stopped.".into()),
        TIMED_OUT => return Err("Claude Code took too long and was stopped.".into()),
        _ => {}
    }

    let Some(result) = result else {
        let detail = stderr_text.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("").trim();
        crate::log::line(format!("claude code: no result. stderr: {detail}"));
        return Err(if looks_logged_out(detail) {
            NOT_LOGGED_IN.into()
        } else if detail.is_empty() {
            "Claude Code stopped without answering.".into()
        } else {
            format!("Claude Code: {detail}")
        });
    };

    let text = result.get("result").and_then(Value::as_str).unwrap_or("").trim().to_string();
    if !succeeded {
        let subtype = result.get("subtype").and_then(Value::as_str).unwrap_or("error");
        crate::log::line(format!("claude code: {subtype}: {text}"));
        return Err(if looks_logged_out(&text) {
            NOT_LOGGED_IN.into()
        } else if text.is_empty() {
            format!("Claude Code: {subtype}")
        } else {
            text
        });
    }
    if text.is_empty() {
        return Err("No response text.".into());
    }
    Ok(ChatReply { text, session_id: session })
}

/// Claude Code answers a missing or expired login with a normal-looking result
/// ("Failed to authenticate: OAuth session expired…"), so it is recognised by text.
fn looks_logged_out(text: &str) -> bool {
    let t = text.to_lowercase();
    ["/login", "not logged in", "invalid api key", "failed to authenticate", "oauth"]
        .iter()
        .any(|needle| t.contains(needle))
}

fn context_block(context: &ChatContext) -> String {
    let body = match context {
        ChatContext::File { name, path } => format!(
            "The user dropped a file on Mochi: {name}\nPath: {path}\nRead it before answering."
        ),
        ChatContext::Window { app_name, title, url } => {
            let mut text = format!("App: {app_name}, Window: {title}");
            if let Some(url) = url {
                text.push_str(&format!(", URL: {url}"));
            }
            text
        }
    };
    format!("<mochi-context>\n{body}\n</mochi-context>")
}

/// The answer word by word, so the island can show it while it is written.
fn stream_text(app: &AppHandle, event: &Value) {
    let Some(inner) = event.get("event") else { return };
    let delta = match inner.get("type").and_then(Value::as_str) {
        Some("message_start") => ChatDelta { text: String::new(), reset: true },
        Some("content_block_delta") if inner.pointer("/delta/type").and_then(Value::as_str) == Some("text_delta") => {
            let text = inner.pointer("/delta/text").and_then(Value::as_str).unwrap_or("");
            if text.is_empty() {
                return;
            }
            ChatDelta { text: text.to_string(), reset: false }
        }
        _ => return,
    };
    let _ = app.emit_to(island::WINDOW_LABEL, "chat-delta", delta);
}

/// Tool calls become the line under the typing dots ("Searching the web…").
fn report_tools(app: &AppHandle, event: &Value) {
    let Some(blocks) = event.pointer("/message/content").and_then(Value::as_array) else { return };
    for block in blocks {
        if block.get("type").and_then(Value::as_str) != Some("tool_use") {
            continue;
        }
        let tool = block.get("name").and_then(Value::as_str).unwrap_or("").to_string();
        let label = match tool.as_str() {
            "WebSearch" => "Searching the web…".to_string(),
            "WebFetch" => "Reading a web page…".to_string(),
            "Read" => block
                .pointer("/input/file_path")
                .and_then(Value::as_str)
                .and_then(|p| Path::new(p).file_name())
                .map(|n| format!("Reading {}…", n.to_string_lossy()))
                .unwrap_or_else(|| "Reading…".into()),
            "Glob" | "Grep" => "Looking through the files…".to_string(),
            _ => "Working…".to_string(),
        };
        let _ = app.emit_to(island::WINDOW_LABEL, "chat-activity", Activity { tool, label });
    }
}

// ── Projects and sessions ────────────────────────────────────────────────────

pub fn discussion_dir() -> PathBuf {
    settings::local_dir().join(DEFAULT_PROJECT)
}

fn claude_home() -> PathBuf {
    std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| platform::home_dir().join(".claude"))
}

/// Claude Code's folder for a project: every character that isn't an ASCII
/// letter or digit becomes a dash (`C:\Dev\app` → `C--Dev-app`).
fn encode_project(path: &Path) -> String {
    path.to_string_lossy()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

fn sessions_dir(project: &Path) -> PathBuf {
    claude_home().join("projects").join(encode_project(project))
}

fn path_key(path: &Path) -> String {
    path.to_string_lossy()
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_lowercase()
}

fn millis(t: SystemTime) -> u64 {
    t.duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Top-level session files of a project, newest first.
fn session_files(dir: &Path) -> Vec<(PathBuf, SystemTime)> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut files: Vec<(PathBuf, SystemTime)> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "jsonl") && p.is_file())
        .filter_map(|p| {
            let modified = std::fs::metadata(&p).and_then(|m| m.modified()).ok()?;
            Some((p, modified))
        })
        .collect();
    files.sort_by(|a, b| b.1.cmp(&a.1));
    files
}

/// The folder name is lossy; the session itself records the real path.
fn recorded_cwd(file: &Path) -> Option<String> {
    let reader = BufReader::new(std::fs::File::open(file).ok()?);
    reader
        .split(b'\n')
        .take(80)
        .map_while(Result::ok)
        .filter_map(|line| serde_json::from_slice::<Value>(&line).ok())
        .find_map(|v| v.get("cwd").and_then(Value::as_str).map(str::to_string))
}

/// Discussion first, then every folder Claude Code has been used in, most recent first.
pub fn list_projects() -> Vec<Project> {
    let default = discussion_dir();
    let _ = std::fs::create_dir_all(&default);
    let default_files = session_files(&sessions_dir(&default));
    let mut out = vec![Project {
        name: DEFAULT_PROJECT.into(),
        path: default.to_string_lossy().to_string(),
        is_default: true,
        updated: default_files.first().map(|f| millis(f.1)).unwrap_or(0),
        sessions: default_files.len(),
    }];

    let mut seen: HashSet<String> = HashSet::new();
    seen.insert(path_key(&default));
    let temp = path_key(&std::env::temp_dir());
    let mut others = Vec::new();
    let Ok(entries) = std::fs::read_dir(claude_home().join("projects")) else { return out };
    for entry in entries.flatten() {
        let files = session_files(&entry.path());
        let Some(cwd) = files.iter().take(3).find_map(|(p, _)| recorded_cwd(p)) else { continue };
        let path = PathBuf::from(&cwd);
        // Worktrees and temp folders are throwaway copies, named after nothing.
        let key = path_key(&path);
        let throwaway = key.contains("\\.claude\\worktrees\\") || key.starts_with(&temp);
        if throwaway || !path.is_dir() || !seen.insert(key) {
            continue;
        }
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| cwd.clone());
        others.push(Project {
            name,
            path: cwd,
            is_default: false,
            updated: files.first().map(|f| millis(f.1)).unwrap_or(0),
            sessions: files.len(),
        });
    }
    others.sort_by(|a, b| b.updated.cmp(&a.updated));
    out.extend(others.into_iter().take(MAX_PROJECTS));
    out
}

pub fn list_sessions(project: &Path) -> Vec<SessionInfo> {
    session_files(&sessions_dir(project))
        .into_iter()
        .filter_map(|(path, modified)| {
            let id = path.file_stem()?.to_str()?.to_string();
            let title = session_title(&path)?;
            Some(SessionInfo { id, title, updated: millis(modified) })
        })
        .take(MAX_SESSIONS)
        .collect()
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}

fn string_field(line: &[u8], field: &str) -> Option<String> {
    let v: Value = serde_json::from_slice(line).ok()?;
    let s = v.get(field)?.as_str()?.trim().to_string();
    (!s.is_empty()).then_some(s)
}

/// The title Claude Code shows: the one the user gave, else the generated one,
/// else the first thing they asked. None for a session with no message at all.
fn session_title(file: &Path) -> Option<String> {
    let reader = BufReader::new(std::fs::File::open(file).ok()?);
    let (mut custom, mut generated, mut first) = (None, None, None);
    for line in reader.split(b'\n') {
        let Ok(line) = line else { break };
        if line.starts_with(br#"{"type":"custom-title""#) {
            custom = string_field(&line, "customTitle").or(custom);
        } else if line.starts_with(br#"{"type":"ai-title""#) {
            generated = string_field(&line, "aiTitle").or(generated);
        } else if line.starts_with(br#"{"type":"summary""#) {
            generated = generated.or_else(|| string_field(&line, "summary"));
        } else if first.is_none() && contains(&line, br#""type":"user""#) {
            first = serde_json::from_slice::<Value>(&line).ok().and_then(|v| user_text(&v));
        }
    }
    let first = first?;
    let title = custom.or(generated).unwrap_or(first);
    let line = title.lines().next().unwrap_or("").trim();
    Some(if line.chars().count() > 80 {
        format!("{}…", line.chars().take(80).collect::<String>())
    } else {
        line.to_string()
    })
}

/// What the user typed, or None for tool results, slash commands and the
/// messages Claude Code adds itself.
fn user_text(v: &Value) -> Option<String> {
    if v.get("type")?.as_str()? != "user"
        || v.get("isSidechain").and_then(Value::as_bool) == Some(true)
        || v.get("isMeta").and_then(Value::as_bool) == Some(true)
    {
        return None;
    }
    let text = match v.pointer("/message/content")? {
        Value::String(s) => s.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => return None,
    };
    let text = strip_context(&text).trim();
    (!text.is_empty() && !text.starts_with('<')).then(|| text.to_string())
}

fn strip_context(text: &str) -> &str {
    let trimmed = text.trim_start();
    if trimmed.starts_with("<mochi-context>") {
        if let Some(end) = trimmed.find("</mochi-context>") {
            return &trimmed[end + "</mochi-context>".len()..];
        }
    }
    text
}

fn assistant_text(v: &Value) -> Option<String> {
    if v.get("isSidechain").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    let text = v
        .pointer("/message/content")?
        .as_array()?
        .iter()
        .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|b| b.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n");
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_string())
}

fn valid_session_id(id: &str) -> bool {
    id.len() == 36 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

/// The conversation as Mochi shows it: each question, then the last thing
/// Claude said before the next one (what `claude -p` returned at the time).
fn load_history(project: &Path, id: &str) -> Result<Vec<HistoryMessage>, String> {
    let file = sessions_dir(project).join(format!("{id}.jsonl"));
    let reader = BufReader::new(
        std::fs::File::open(&file).map_err(|_| "This conversation can't be found any more.".to_string())?,
    );
    let mut out = Vec::new();
    let mut reply: Option<String> = None;
    for line in reader.split(b'\n') {
        let Ok(line) = line else { break };
        let is_user = contains(&line, br#""type":"user""#);
        if !is_user && !contains(&line, br#""type":"assistant""#) {
            continue;
        }
        let Ok(v) = serde_json::from_slice::<Value>(&line) else { continue };
        match v.get("type").and_then(Value::as_str) {
            Some("user") => {
                if let Some(text) = user_text(&v) {
                    if let Some(r) = reply.take() {
                        out.push(HistoryMessage { role: "assistant", content: r });
                    }
                    out.push(HistoryMessage { role: "user", content: text });
                }
            }
            Some("assistant") => {
                if let Some(text) = assistant_text(&v) {
                    reply = Some(text);
                }
            }
            _ => {}
        }
    }
    if let Some(r) = reply {
        out.push(HistoryMessage { role: "assistant", content: r });
    }
    if out.len() > MAX_HISTORY {
        out.drain(..out.len() - MAX_HISTORY);
    }
    Ok(out)
}

/// Points the chat at a project, and at one of its conversations or a new one.
pub fn open(chat: &CliChat, project: &str, session_id: Option<&str>) -> Result<Vec<HistoryMessage>, String> {
    let path = PathBuf::from(project);
    let is_default = path_key(&path) == path_key(&discussion_dir());
    if is_default {
        let _ = std::fs::create_dir_all(&path);
    }
    if !path.is_dir() {
        return Err(format!("{project} no longer exists."));
    }
    if chat.running.lock().unwrap().is_some() {
        return Err("Mochi is still answering.".into());
    }
    let history = match session_id {
        Some(id) if valid_session_id(id) => load_history(&path, id)?,
        Some(_) => return Err("Unknown conversation.".into()),
        None => Vec::new(),
    };
    let mut current = chat.current.lock().unwrap();
    current.project = if is_default { None } else { Some(path) };
    current.session_id = session_id.map(str::to_string);
    Ok(history)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn project_folders_match_claude_code() {
        assert_eq!(
            encode_project(Path::new(r"C:\Users\sevan\Documents\Mes Documents\Code\coucou")),
            "C--Users-sevan-Documents-Mes-Documents-Code-coucou"
        );
        assert_eq!(
            encode_project(Path::new(r"C:\a\Gestion-MobileK\.claude\worktrees\x")),
            "C--a-Gestion-MobileK--claude-worktrees-x"
        );
    }

    #[test]
    fn user_text_skips_tool_results_and_commands() {
        let typed = json!({ "type": "user", "message": { "content": "Salut Mochi" } });
        assert_eq!(user_text(&typed).as_deref(), Some("Salut Mochi"));

        let tool = json!({ "type": "user", "message": { "content": [
            { "type": "tool_result", "content": "…" }
        ] } });
        assert!(user_text(&tool).is_none());

        let command = json!({ "type": "user", "message": { "content": "<command-name>/clear</command-name>" } });
        assert!(user_text(&command).is_none());

        let meta = json!({ "type": "user", "isMeta": true, "message": { "content": "Caveat" } });
        assert!(user_text(&meta).is_none());
    }

    #[test]
    fn mochi_context_is_hidden_from_the_history() {
        let msg = json!({ "type": "user", "message": {
            "content": "<mochi-context>\nThe user dropped a file\n</mochi-context>\n\nRésume-le"
        } });
        assert_eq!(user_text(&msg).as_deref(), Some("Résume-le"));
    }

    #[test]
    fn expired_logins_are_recognised() {
        assert!(looks_logged_out("Failed to authenticate: OAuth session expired and could not be refreshed"));
        assert!(looks_logged_out("Not logged in · Please run /login"));
        assert!(!looks_logged_out("Bonjour, ça va ?"));
    }

    #[test]
    fn session_ids_cannot_escape_the_folder() {
        assert!(valid_session_id("96186b66-a867-4efa-824d-c3ef28c6369d"));
        assert!(!valid_session_id(r"..\..\..\secrets"));
        assert!(!valid_session_id("96186b66-a867-4efa-824d-c3ef28c6369d.."));
    }
}
