//! Now-playing information from a station's optional metadata URL.
//!
//! The endpoint may answer with JSON in any common shape (flat
//! `{"title","artist","artwork"}`, AzuraCast, Icecast `status-json.xsl`, ...)
//! or with plain text, in which case the first line is the title.

use std::collections::VecDeque;

use reqwest::Url;
use serde_json::Value;

const TITLE_KEYS: &[&str] = &["title", "song", "track", "streamtitle", "now_playing", "nowplaying", "text"];
const ARTIST_KEYS: &[&str] = &["artist", "artist_name", "performer"];
const ARTWORK_KEYS: &[&str] = &[
    "artwork", "artwork_url", "art", "cover", "cover_url", "coverart", "image", "image_url", "thumb",
];

#[derive(Clone, Debug, Default, PartialEq)]
pub struct NowPlaying {
    pub title: String,
    pub artist: String,
    pub artwork: String,
    /// Where the title and artist came from: `metadata_url`, `stream`,
    /// `station` (the station's own) or `file`; empty when there is none.
    pub from: &'static str,
}

/// A stream carries one line, usually `Artist - Title`. Splits it at the first
/// ` - ` so that it has the same two parts a metadata URL gives; a line without
/// one is all title.
pub fn split_stream_title(line: &str) -> (String, String) {
    match line.split_once(" - ") {
        Some((artist, title)) if !artist.trim().is_empty() && !title.trim().is_empty() => (artist.trim().to_string(), title.trim().to_string()),
        _ => (String::new(), line.trim().to_string()),
    }
}

impl NowPlaying {
    /// The single-line form players show: `Artist - Title`.
    pub fn stream_title(&self) -> String {
        if self.artist.is_empty() || self.title.is_empty() {
            format!("{}{}", self.artist, self.title)
        } else {
            format!("{} - {}", self.artist, self.title)
        }
    }
}

/// Breadth-first search for the first non-empty string under any of `keys`,
/// so shallow fields win over nested history entries.
fn find_string(root: &Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        let mut queue = VecDeque::from([root]);
        while let Some(node) = queue.pop_front() {
            match node {
                Value::Object(map) => {
                    for (name, value) in map {
                        if name.eq_ignore_ascii_case(key) {
                            if let Some(text) = value.as_str().map(str::trim).filter(|t| !t.is_empty()) {
                                return Some(text.to_string());
                            }
                        }
                    }
                    queue.extend(map.values());
                }
                Value::Array(items) => queue.extend(items.iter()),
                _ => {}
            }
        }
    }
    None
}

fn limit(text: String, max_chars: usize) -> String {
    text.chars().filter(|c| !c.is_control()).take(max_chars).collect()
}

pub fn parse(body: &str, base_url: &str) -> Option<NowPlaying> {
    let body = body.trim().trim_start_matches('\u{feff}');
    if body.is_empty() {
        return None;
    }
    let Ok(json) = serde_json::from_str::<Value>(body) else {
        // A web page, or something that is not text at all (a picture, say), names nothing.
        let first = body.lines().next().unwrap_or_default();
        if body.starts_with('<') || first.chars().any(|c| c == '\u{fffd}' || (c.is_control() && c != '\t')) {
            return None;
        }
        let title = limit(body.lines().next().unwrap_or_default().trim().to_string(), 300);
        // One line of text is read the way a stream's title is.
        let (artist, title) = split_stream_title(&title);
        return (!title.is_empty()).then(|| NowPlaying { title, artist, artwork: String::new(), from: "metadata_url" });
    };

    let title = find_string(&json, TITLE_KEYS)?;
    let artist = find_string(&json, ARTIST_KEYS).unwrap_or_default();
    // Resolve relative artwork paths against the metadata URL.
    let artwork = find_string(&json, ARTWORK_KEYS)
        .and_then(|art| Url::parse(base_url).ok()?.join(&art).ok())
        .filter(|url| matches!(url.scheme(), "http" | "https"))
        .map(String::from)
        .unwrap_or_default();
    Some(NowPlaying { title: limit(title, 300), artist: limit(artist, 300), artwork, from: "metadata_url" })
}

#[cfg(test)]
mod tests {
    use super::*;

    const BASE: &str = "https://radio.example/api/nowplaying";

    #[test]
    fn flat_json() {
        let np = parse(r#"{"title":"Blue in Green","artist":"Miles Davis","artwork":"https://cdn.example/a.jpg"}"#, BASE).unwrap();
        assert_eq!(np.title, "Blue in Green");
        assert_eq!(np.artist, "Miles Davis");
        assert_eq!(np.artwork, "https://cdn.example/a.jpg");
        assert_eq!(np.stream_title(), "Miles Davis - Blue in Green");
    }

    #[test]
    fn azuracast_shape_prefers_current_song_over_history() {
        let body = r#"{"now_playing":{"song":{"title":"Now","artist":"A","art":"/static/now.jpg"}},
                       "song_history":[{"song":{"title":"Old","artist":"B","art":"/static/old.jpg"}}]}"#;
        let np = parse(body, BASE).unwrap();
        assert_eq!((np.title.as_str(), np.artist.as_str()), ("Now", "A"));
        assert_eq!(np.artwork, "https://radio.example/static/now.jpg");
    }

    #[test]
    fn icecast_status_json() {
        let body = r#"{"icestats":{"source":{"listeners":4,"title":"Artist - Track"}}}"#;
        let np = parse(body, BASE).unwrap();
        assert_eq!(np.stream_title(), "Artist - Track");
    }

    #[test]
    fn plain_text_uses_first_line() {
        let np = parse("Artist - Track\nsecond line\n", BASE).unwrap();
        // Read like a stream's title: split into its two parts, and shown to players as the same line.
        assert_eq!((np.artist.as_str(), np.title.as_str()), ("Artist", "Track"));
        assert_eq!(np.stream_title(), "Artist - Track");
    }

    #[test]
    fn html_and_empty_bodies_are_ignored() {
        assert_eq!(parse("<html><body>404</body></html>", BASE), None);
        assert_eq!(parse("   ", BASE), None);
        assert_eq!(parse(r#"{"listeners":3}"#, BASE), None);
    }

    #[test]
    fn something_that_is_not_text_names_nothing() {
        assert_eq!(parse("\u{fffd}PNG\r\n\u{1a}\n", BASE), None);
        assert_eq!(parse("<html><body>Not found</body></html>", BASE), None);
    }

    #[test]
    fn a_stream_title_is_split_into_artist_and_title() {
        let split = |line: &str| split_stream_title(line);
        assert_eq!(split("Miles Davis - So What"), ("Miles Davis".into(), "So What".into()));
        // Only the first separator divides: the rest belongs to the title.
        assert_eq!(split("AC/DC - Back in Black - Live"), ("AC/DC".into(), "Back in Black - Live".into()));
        assert_eq!(split("Morning show"), (String::new(), "Morning show".into()));
        assert_eq!(split("Jay-Z"), (String::new(), "Jay-Z".into()));
        assert_eq!(split(" - Untitled"), (String::new(), "- Untitled".into()));
        assert_eq!(split(""), (String::new(), String::new()));
    }
}
