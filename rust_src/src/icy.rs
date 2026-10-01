//! SHOUTcast/Icecast in-stream metadata ("ICY").
//!
//! A source that honours `Icy-MetaData: 1` interleaves a metadata block every
//! `icy-metaint` audio bytes: one length byte (in units of 16 bytes) followed
//! by that much `StreamTitle='...';` text. The relay strips those blocks so the
//! shared buffer is pure audio, then re-inserts them per listener for the
//! players that ask.

use bytes::{BufMut, Bytes, BytesMut};

/// Metadata interval advertised to listeners.
pub const METAINT: usize = 16_000;

enum State {
    Audio,
    Length,
    Meta,
}

/// Splits an upstream body into audio and metadata.
pub struct IcyDemux {
    metaint: usize,
    audio_left: usize,
    meta_left: usize,
    meta: Vec<u8>,
    state: State,
}

impl IcyDemux {
    pub fn new(metaint: usize) -> Self {
        Self { metaint, audio_left: metaint, meta_left: 0, meta: Vec::new(), state: State::Audio }
    }

    /// Pushes audio slices onto `out` and returns the title if a metadata
    /// block completed inside this chunk.
    pub fn feed(&mut self, mut data: Bytes, out: &mut Vec<Bytes>) -> Option<String> {
        let mut title = None;
        while !data.is_empty() {
            match self.state {
                State::Audio => {
                    let n = self.audio_left.min(data.len());
                    out.push(data.split_to(n));
                    self.audio_left -= n;
                    if self.audio_left == 0 {
                        self.state = State::Length;
                    }
                }
                State::Length => {
                    self.meta_left = data.split_to(1)[0] as usize * 16;
                    self.meta.clear();
                    if self.meta_left == 0 {
                        self.audio_left = self.metaint;
                        self.state = State::Audio;
                    } else {
                        self.state = State::Meta;
                    }
                }
                State::Meta => {
                    let n = self.meta_left.min(data.len());
                    self.meta.extend_from_slice(&data.split_to(n));
                    self.meta_left -= n;
                    if self.meta_left == 0 {
                        if let Some(t) = parse_stream_title(&self.meta) {
                            title = Some(t);
                        }
                        self.audio_left = self.metaint;
                        self.state = State::Audio;
                    }
                }
            }
        }
        title
    }
}

/// Extracts the value of `StreamTitle='...';` from a metadata block.
pub fn parse_stream_title(block: &[u8]) -> Option<String> {
    let end = block.iter().rposition(|b| *b != 0).map_or(0, |p| p + 1);
    let text = decode_text(&block[..end]);
    let rest = &text[text.find("StreamTitle='")? + "StreamTitle='".len()..];
    // Titles may contain apostrophes, so prefer the terminator that precedes
    // the next field and fall back to the last one in the block.
    let end = rest.find("';Stream").or_else(|| rest.rfind("';")).or_else(|| rest.rfind('\''))?;
    Some(rest[..end].trim().to_string())
}

/// Sources send UTF-8 or, on older encoders, Latin-1.
fn decode_text(raw: &[u8]) -> String {
    match std::str::from_utf8(raw) {
        Ok(s) => s.to_string(),
        Err(_) => raw.iter().map(|b| *b as char).collect(),
    }
}

fn clean(value: &str, max_bytes: usize) -> String {
    let mut out = String::new();
    for c in value.chars().filter(|c| !c.is_control()) {
        if out.len() + c.len_utf8() > max_bytes {
            break;
        }
        out.push(c);
    }
    out.replace("';", "' ;")
}

/// Builds one metadata block: length byte, text, NUL padding to 16 bytes.
pub fn encode_meta(title: &str, url: &str) -> Bytes {
    let mut text = format!("StreamTitle='{}';", clean(title, 1024));
    if !url.is_empty() && url.len() <= 1024 {
        text.push_str(&format!("StreamUrl='{}';", clean(url, 1024)));
    }
    let blocks = text.len().div_ceil(16);
    let mut out = BytesMut::with_capacity(1 + blocks * 16);
    out.put_u8(blocks as u8);
    out.put_slice(text.as_bytes());
    out.resize(1 + blocks * 16, 0);
    out.freeze()
}

/// Re-inserts metadata into one listener's copy of the stream.
pub struct IcyMux {
    until_meta: usize,
    last_sent: Option<(String, String)>,
}

impl IcyMux {
    pub fn new() -> Self {
        Self { until_meta: METAINT, last_sent: None }
    }

    pub fn wrap(&mut self, chunk: &[u8], title: &str, url: &str) -> Bytes {
        let mut out = BytesMut::with_capacity(chunk.len() + 64);
        let mut data = chunk;
        while !data.is_empty() {
            let n = self.until_meta.min(data.len());
            out.put_slice(&data[..n]);
            data = &data[n..];
            self.until_meta -= n;
            if self.until_meta == 0 {
                let unchanged = matches!(&self.last_sent, Some((t, u)) if t == title && u == url);
                if unchanged {
                    out.put_u8(0);
                } else {
                    out.put_slice(&encode_meta(title, url));
                    self.last_sent = Some((title.to_string(), url.to_string()));
                }
                self.until_meta = METAINT;
            }
        }
        out.freeze()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn audio(len: usize, seed: u8) -> Vec<u8> {
        (0..len).map(|i| (i as u8).wrapping_add(seed)).collect()
    }

    #[test]
    fn parses_titles_with_apostrophes_and_trailing_fields() {
        let block = b"StreamTitle='Journey - Don't Stop Believin'';StreamUrl='http://x/a.jpg';\0\0\0";
        assert_eq!(parse_stream_title(block).as_deref(), Some("Journey - Don't Stop Believin'"));
        assert_eq!(parse_stream_title(b"StreamTitle='Solo';\0").as_deref(), Some("Solo"));
        assert_eq!(parse_stream_title(b"StreamTitle='';").as_deref(), Some(""));
        assert_eq!(parse_stream_title(b"garbage"), None);
    }

    #[test]
    fn decodes_latin1_titles() {
        let block = b"StreamTitle='Caf\xe9';";
        assert_eq!(parse_stream_title(block).as_deref(), Some("Café"));
    }

    #[test]
    fn meta_block_is_padded_to_sixteen_bytes() {
        let block = encode_meta("A - B", "");
        assert_eq!((block.len() - 1) % 16, 0);
        assert_eq!(block[0] as usize * 16, block.len() - 1);
        assert_eq!(parse_stream_title(&block[1..]).as_deref(), Some("A - B"));
    }

    #[test]
    fn oversized_titles_still_fit_the_length_byte() {
        let block = encode_meta(&"x".repeat(10_000), &"y".repeat(900));
        assert!(block.len() - 1 <= 255 * 16);
    }

    #[test]
    fn demux_strips_metadata_across_arbitrary_chunk_boundaries() {
        let metaint = 100;
        let a = audio(100, 1);
        let b = audio(100, 2);
        let c = audio(40, 3);
        let mut wire = Vec::new();
        wire.extend_from_slice(&a);
        wire.extend_from_slice(&encode_meta("First", ""));
        wire.extend_from_slice(&b);
        wire.push(0);
        wire.extend_from_slice(&c);

        for step in [1, 7, 16, 33, 1000] {
            let mut demux = IcyDemux::new(metaint);
            let mut got = Vec::new();
            let mut titles = Vec::new();
            for piece in wire.chunks(step) {
                let mut out = Vec::new();
                if let Some(t) = demux.feed(Bytes::copy_from_slice(piece), &mut out) {
                    titles.push(t);
                }
                for o in out {
                    got.extend_from_slice(&o);
                }
            }
            let expected: Vec<u8> = [a.clone(), b.clone(), c.clone()].concat();
            assert_eq!(got, expected, "chunk size {step}");
            assert_eq!(titles, vec!["First".to_string()], "chunk size {step}");
        }
    }

    #[test]
    fn mux_output_round_trips_through_demux() {
        let source = audio(METAINT * 3 + 500, 9);
        let mut mux = IcyMux::new();
        let mut wire = Vec::new();
        let mut titles_in = ["One", "One", "Two", "Two"].into_iter().cycle();
        for piece in source.chunks(4096) {
            wire.extend_from_slice(&mux.wrap(piece, titles_in.next().unwrap(), "http://art/x.png"));
        }

        let mut demux = IcyDemux::new(METAINT);
        let mut out = Vec::new();
        let mut titles = Vec::new();
        for piece in wire.chunks(999) {
            if let Some(t) = demux.feed(Bytes::copy_from_slice(piece), &mut out) {
                titles.push(t);
            }
        }
        let got: Vec<u8> = out.iter().flat_map(|b| b.to_vec()).collect();
        assert_eq!(got, source);
        assert!(!titles.is_empty());
        assert!(titles.iter().all(|t| t == "One" || t == "Two"));
    }
}
