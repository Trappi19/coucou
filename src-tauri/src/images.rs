// Pictures in the chat. When Mochi answers with an image link, the island asks
// for it here: Rust downloads it and hands back the bytes, which the page shows
// from a blob: URL. The island itself never loads anything from the internet
// (its CSP has no remote img-src), and only real image files come through.

use std::net::IpAddr;
use std::time::Duration;

/// Large photos are fine; anything bigger isn't a picture for a chat bubble.
const MAX_BYTES: usize = 8 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(20);

/// Some hosts (Wikimedia among them) turn away requests with no user agent.
const USER_AGENT: &str = concat!("Coucou/", env!("CARGO_PKG_VERSION"), " (Windows desktop app; chat image preview)");

/// Only public web addresses: a link in an answer — which may come from a web
/// page Mochi read — must not make the app reach into the local network.
fn allowed(url: &reqwest::Url) -> Result<(), String> {
    if url.scheme() != "https" {
        return Err("Only https images are shown.".into());
    }
    let host = url.host_str().unwrap_or("").trim_start_matches('[').trim_end_matches(']').to_lowercase();
    if host.is_empty() || host == "localhost" || host.ends_with(".localhost") || host.ends_with(".local") {
        return Err("That address isn't on the internet.".into());
    }
    if let Ok(ip) = host.parse::<IpAddr>() {
        let private = match ip {
            IpAddr::V4(v4) => v4.is_private() || v4.is_loopback() || v4.is_link_local() || v4.is_unspecified(),
            IpAddr::V6(v6) => v6.is_loopback() || v6.is_unspecified() || (v6.segments()[0] & 0xfe00) == 0xfc00,
        };
        if private {
            return Err("That address isn't on the internet.".into());
        }
    }
    Ok(())
}

/// What the first bytes say: one of the formats a webview shows. SVG is left
/// out on purpose (it is a document, not a picture).
fn is_image(bytes: &[u8]) -> bool {
    bytes.starts_with(&[0xFF, 0xD8, 0xFF])
        || bytes.starts_with(b"\x89PNG\r\n\x1a\n")
        || bytes.starts_with(b"GIF87a")
        || bytes.starts_with(b"GIF89a")
        || (bytes.len() > 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP")
        || (bytes.len() > 12 && &bytes[4..8] == b"ftyp" && (&bytes[8..12] == b"avif" || &bytes[8..12] == b"avis"))
}

pub async fn fetch(url: &str) -> Result<Vec<u8>, String> {
    let parsed = reqwest::Url::parse(url).map_err(|_| "That isn't a web address.".to_string())?;
    allowed(&parsed)?;
    let client = reqwest::Client::builder()
        .timeout(TIMEOUT)
        .user_agent(USER_AGENT)
        // Each hop is checked like the first one.
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 {
                attempt.error("too many redirects")
            } else if allowed(attempt.url()).is_err() {
                attempt.stop()
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(|e| e.to_string())?;

    let mut response = client
        .get(parsed)
        .header("Accept", "image/avif,image/webp,image/png,image/jpeg,image/gif,*/*;q=0.5")
        .send()
        .await
        .map_err(|e| format!("Couldn't load the image: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("The image couldn't be loaded ({}).", response.status()));
    }
    if response.content_length().is_some_and(|n| n as usize > MAX_BYTES) {
        return Err("The image is too large to show.".into());
    }

    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        bytes.extend_from_slice(&chunk);
        if bytes.len() > MAX_BYTES {
            return Err("The image is too large to show.".into());
        }
    }
    if !is_image(&bytes) {
        return Err("That link isn't a picture.".into());
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn check(url: &str) -> bool {
        allowed(&reqwest::Url::parse(url).unwrap()).is_ok()
    }

    #[test]
    fn only_public_https() {
        assert!(check("https://upload.wikimedia.org/a.jpg"));
        assert!(!check("http://upload.wikimedia.org/a.jpg"));
        assert!(!check("https://localhost/a.png"));
        assert!(!check("https://127.0.0.1/a.png"));
        assert!(!check("https://192.168.1.10/a.png"));
        assert!(!check("https://10.0.0.2/a.png"));
        assert!(!check("https://[::1]/a.png"));
        assert!(!check("https://printer.local/a.png"));
    }

    #[test]
    fn recognises_pictures() {
        assert!(is_image(&[0xFF, 0xD8, 0xFF, 0xE0]));
        assert!(is_image(b"\x89PNG\r\n\x1a\nrest"));
        assert!(is_image(b"RIFF\0\0\0\0WEBPVP8 "));
        assert!(!is_image(b"<!DOCTYPE html><html>"));
        assert!(!is_image(b"<svg xmlns="));
    }
}
