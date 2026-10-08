// Chat with a model running on this computer: Ollama, LM Studio, or any server
// that speaks the OpenAI chat API. Upstream Coucou has the same feature
// (local_chat.rs); this is a smaller take on it for this fork.
//
// No account and no quota: the only place this talks to is the address in the
// settings. The answer is streamed as `chat-delta` events, exactly like Claude
// Code's, and the `<think>` blocks of reasoning models are kept out of it.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use reqwest::Url;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::claude::{ChatContext, ChatReply};
use crate::island::WINDOW_LABEL;

/// A text file is sent inline up to this many characters; the rest is cut.
const MAX_INLINE_CHARS: usize = 24_000;
/// Loading a big model can take a while before the first word.
const READ_TIMEOUT: Duration = Duration::from_secs(300);
/// Models that embed or rank rather than chat are left out of the list.
const NOT_CHAT: &[&str] = &["embed", "bge-", "all-minilm", "clip", "rerank"];

const SYSTEM_PROMPT: &str = "You are Mochi, a personal AI companion living at the top of the user's screen, \
talking to them through a small chat bubble. Help with anything. Respond in the user's language. \
No markdown formatting (no **, no ##, no bullet dashes). Use plain text with line breaks.";

#[derive(Default)]
pub struct LocalChat {
    /// The conversation so far, as the server expects it (system prompt excluded).
    messages: Mutex<Vec<Value>>,
    cancel: AtomicBool,
}

impl LocalChat {
    pub fn reset(&self) {
        self.messages.lock().unwrap().clear();
    }

    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::Relaxed);
    }
}

#[derive(Serialize, Clone)]
struct ChatDelta {
    text: String,
    reset: bool,
}

/// The server's root, whatever was typed: "localhost:11434", ".../v1/", etc.
fn base_url(typed: &str) -> Result<Url, String> {
    let typed = typed.trim();
    if typed.is_empty() {
        return Err("No model server set. Pick one in Settings → Mochi's chat.".into());
    }
    let with_scheme = if typed.contains("://") { typed.to_string() } else { format!("http://{typed}") };
    let mut url = Url::parse(&with_scheme).map_err(|_| format!("\"{typed}\" isn't a valid address."))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("The model server's address must start with http:// or https://.".into());
    }
    let path = url.path().trim_end_matches('/').trim_end_matches("/v1").to_string();
    url.set_path(&path);
    url.set_query(None);
    Ok(url)
}

fn endpoint(base: &Url, tail: &str) -> String {
    format!("{}/v1/{tail}", base.as_str().trim_end_matches('/'))
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .read_timeout(READ_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())
}

fn unreachable(base: &Url) -> String {
    format!("Nothing answers at {}. Is Ollama or LM Studio running?", base.as_str().trim_end_matches('/'))
}

/// The chat models the server has, for the picker in the settings.
pub async fn list_models(typed_url: &str) -> Result<Vec<String>, String> {
    let base = base_url(typed_url)?;
    let response = client()?
        .get(endpoint(&base, "models"))
        .timeout(Duration::from_secs(8))
        .send()
        .await
        .map_err(|_| unreachable(&base))?;
    if !response.status().is_success() {
        return Err(format!("The server answered {}.", response.status().as_u16()));
    }
    let root: Value = response.json().await.map_err(|_| "Not an OpenAI-compatible server.".to_string())?;
    let mut models: Vec<String> = root
        .get("data")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|m| m.get("id").and_then(Value::as_str))
                .filter(|id| {
                    let lower = id.to_lowercase();
                    !NOT_CHAT.iter().any(|n| lower.contains(n))
                })
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    models.sort();
    models.dedup();
    Ok(models)
}

/// What goes ahead of the first message: a text file inline, otherwise just its name.
fn context_text(context: &ChatContext) -> String {
    match context {
        ChatContext::File { name, path } => {
            let inline = std::fs::read(path)
                .ok()
                .and_then(|bytes| String::from_utf8(bytes).ok())
                .filter(|t| !t.contains('\0'));
            match inline {
                Some(text) => {
                    let cut: String = text.chars().take(MAX_INLINE_CHARS).collect();
                    let more = if cut.len() < text.len() { "\n[…the rest of the file was left out]" } else { "" };
                    format!("The user dropped a file: {name}\n---\n{cut}{more}\n---")
                }
                None => format!(
                    "The user dropped a file: {name}. It isn't plain text, so it couldn't be passed to you; say so if it matters."
                ),
            }
        }
        ChatContext::Window { app_name, title, url } => {
            let mut text = format!("Context — App: {app_name}, Window: {title}");
            if let Some(url) = url {
                text.push_str(&format!(", URL: {url}"));
            }
            text
        }
    }
}

/// The answer without reasoning: closed `<think>…</think>` blocks are dropped,
/// and an open one hides everything after it until it closes.
fn visible(raw: &str) -> String {
    let mut out = String::new();
    let mut rest = raw;
    loop {
        match rest.find("<think>") {
            Some(start) => {
                out.push_str(&rest[..start]);
                match rest[start..].find("</think>") {
                    Some(end) => rest = &rest[start + end + "</think>".len()..],
                    None => return out,
                }
            }
            None => {
                out.push_str(rest);
                return out;
            }
        }
    }
}

/// Server-sent events: `data: {json}` lines, `data: [DONE]` at the end. Takes
/// the complete lines out of `pending` — bytes, since a network chunk can end in
/// the middle of a line, or of an "é" — adds their text to `raw`, and says
/// whether the answer is over.
fn take_events(pending: &mut Vec<u8>, raw: &mut String) -> bool {
    while let Some(end) = pending.iter().position(|&b| b == b'\n') {
        let bytes: Vec<u8> = pending.drain(..=end).collect();
        let line = String::from_utf8_lossy(&bytes);
        let Some(data) = line.trim().strip_prefix("data:") else { continue };
        let data = data.trim();
        if data == "[DONE]" {
            return true;
        }
        let Ok(event) = serde_json::from_str::<Value>(data) else { continue };
        if let Some(piece) = event.pointer("/choices/0/delta/content").and_then(Value::as_str) {
            raw.push_str(piece);
        }
    }
    false
}

/// One turn, streamed. The conversation is kept here, as with the API.
pub async fn send(
    app: AppHandle,
    chat: &LocalChat,
    typed_url: &str,
    model: &str,
    query: String,
    context: Option<ChatContext>,
) -> Result<ChatReply, String> {
    if model.trim().is_empty() {
        return Err("No local model picked yet. Choose one in Settings → Mochi's chat.".into());
    }
    let base = base_url(typed_url)?;
    chat.cancel.store(false, Ordering::Relaxed);

    let first = chat.messages.lock().unwrap().is_empty();
    let content = match (first, context.as_ref()) {
        (true, Some(ctx)) => format!("{}\n\n{query}", context_text(ctx)),
        _ => query,
    };
    let user = json!({ "role": "user", "content": content });
    let mut messages = vec![json!({ "role": "system", "content": SYSTEM_PROMPT })];
    messages.extend(chat.messages.lock().unwrap().iter().cloned());
    messages.push(user.clone());

    let mut response = client()?
        .post(endpoint(&base, "chat/completions"))
        .json(&json!({ "model": model, "messages": messages, "stream": true }))
        .send()
        .await
        .map_err(|_| unreachable(&base))?;
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let body: Value = response.json().await.unwrap_or(Value::Null);
        let detail = body
            .pointer("/error/message")
            .or_else(|| body.get("error"))
            .and_then(Value::as_str)
            .unwrap_or("");
        return Err(if detail.is_empty() {
            format!("The model server answered {status}.")
        } else {
            format!("{model}: {detail}")
        });
    }

    let mut pending: Vec<u8> = Vec::new();
    let mut raw = String::new();
    let mut shown = String::new();
    loop {
        if chat.cancel.load(Ordering::Relaxed) {
            return Err("Stopped.".into());
        }
        let chunk = match response.chunk().await {
            Ok(Some(chunk)) => chunk,
            Ok(None) => break,
            Err(e) => return Err(format!("The model server stopped answering: {e}")),
        };
        pending.extend_from_slice(&chunk);
        let done = take_events(&mut pending, &mut raw);
        let now = visible(&raw);
        if now.len() > shown.len() && now.starts_with(&shown) {
            let _ = app.emit_to(WINDOW_LABEL, "chat-delta", ChatDelta { text: now[shown.len()..].to_string(), reset: false });
            shown = now;
        }
        if done {
            break;
        }
    }

    let text = visible(&raw).trim().to_string();
    if text.is_empty() {
        return Err(format!("{model} sent back an empty answer."));
    }
    let mut history = chat.messages.lock().unwrap();
    history.push(user);
    history.push(json!({ "role": "assistant", "content": text }));
    Ok(ChatReply { text, session_id: None })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addresses_are_cleaned_up() {
        assert_eq!(base_url("localhost:11434").unwrap().as_str(), "http://localhost:11434/");
        assert_eq!(base_url("http://127.0.0.1:1234/v1/").unwrap().as_str(), "http://127.0.0.1:1234/");
        assert_eq!(endpoint(&base_url("http://127.0.0.1:1234/v1").unwrap(), "models"), "http://127.0.0.1:1234/v1/models");
        assert!(base_url("").is_err());
        assert!(base_url("file:///etc/passwd").is_err());
    }

    #[test]
    fn streamed_events_survive_any_chunking() {
        // What Ollama and LM Studio send, cut at awkward places.
        let stream = concat!(
            "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"Bon\"}}]}\n\n",
            ": keep-alive\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"jour é\"}}]}\n\n",
            "data: [DONE]\n\n",
        );
        // Every cut, including the ones that split the two bytes of "é".
        for cut in 1..=80 {
            let mut pending = Vec::new();
            let mut raw = String::new();
            let mut done = false;
            for piece in stream.as_bytes().chunks(cut) {
                pending.extend_from_slice(piece);
                done |= take_events(&mut pending, &mut raw);
            }
            assert_eq!(raw, "Bonjour é", "cut {cut}");
            assert!(done, "cut {cut}");
        }
    }

    #[test]
    fn reasoning_is_hidden() {
        assert_eq!(visible("Hello"), "Hello");
        assert_eq!(visible("<think>hmm</think>Hello"), "Hello");
        assert_eq!(visible("<think>still thinking"), "");
        assert_eq!(visible("A<think>x</think>B<think>y"), "AB");
    }
}
