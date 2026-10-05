use std::{collections::HashMap, time::Duration};

use redis::{aio::ConnectionManager, AsyncCommands, RedisResult};

/// A station profile as published to Redis by the admin service
/// (`station:{slug}` hash).
#[derive(Clone, Debug, PartialEq)]
pub struct Station {
    pub slug: String,
    pub name: String,
    pub primary: String,
    pub backup: Option<String>,
    pub metadata_url: Option<String>,
    pub artwork_url: Option<String>,
    /// Shown when neither the stream nor the metadata URL names what is playing.
    pub default_title: Option<String>,
    pub default_artist: Option<String>,
    /// The station's uploaded image, used when there is no other artwork or the artwork URL does not work.
    pub default_artwork: Option<String>,
    /// 0 means unlimited.
    pub max_listeners: usize,
    pub active: bool,
    /// How long a source may deliver no audio before the station moves on,
    /// and how long a source must be healthy before it is returned to.
    pub failover_delay: Duration,
    /// Treat a source that sends digital silence as having no audio.
    pub silence_detection: bool,
    /// Treat a source that sends nothing but steady noise (hiss) as having no audio, however loud.
    pub noise_detection: bool,
    /// How quiet counts as silent for this station, in dB; `None` for the server's setting.
    pub silence_threshold_db: Option<f32>,
    /// Played once when switching away from a failed source.
    pub ident: Option<Media>,
    /// Looped when neither stream has audio.
    pub fallback: Option<Media>,
}

/// An uploaded audio file, fetched from the master when it is needed.
#[derive(Clone, Debug, PartialEq)]
pub struct Media {
    pub id: String,
    /// Changes when the file's content does.
    pub version: String,
    pub name: String,
}

impl Station {
    pub async fn load(redis: &mut ConnectionManager, slug: &str) -> RedisResult<Option<Self>> {
        let fields: HashMap<String, String> = redis.hgetall(format!("station:{slug}")).await?;
        Ok(Self::from_fields(slug, fields))
    }

    fn from_fields(slug: &str, mut fields: HashMap<String, String>) -> Option<Self> {
        let mut take = |key: &str| fields.remove(key).map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
        let primary = take("primary")?;
        let mut media = |prefix: &str| {
            let id = take(&format!("{prefix}_id"))?;
            Some(Media {
                version: take(&format!("{prefix}_ver")).unwrap_or_default(),
                name: take(&format!("{prefix}_name")).unwrap_or_else(|| id.clone()),
                id,
            })
        };
        let ident = media("ident");
        let fallback = media("fallback");
        Some(Self {
            slug: slug.to_string(),
            name: take("name").unwrap_or_else(|| slug.to_string()),
            primary,
            backup: take("backup"),
            metadata_url: take("metadata_url"),
            artwork_url: take("artwork_url"),
            default_title: take("default_title"),
            default_artist: take("default_artist"),
            default_artwork: take("default_artwork"),
            max_listeners: take("max_listeners").and_then(|v| v.parse().ok()).unwrap_or(0),
            active: take("active").is_none_or(|v| v != "0"),
            failover_delay: Duration::from_secs(take("failover_delay").and_then(|v| v.parse().ok()).unwrap_or(6).clamp(1, 300)),
            silence_detection: take("silence").is_none_or(|v| v != "0"),
            noise_detection: take("noise").is_none_or(|v| v != "0"),
            silence_threshold_db: take("silence_db").and_then(|v| v.parse::<f32>().ok()).map(|db| db.clamp(-90.0, -10.0)),
            ident,
            fallback,
        })
    }
}

/// Slugs are lower-case letters, digits, `-` and `_`.
pub fn valid_slug(slug: &str) -> bool {
    (1..=50).contains(&slug.len())
        && slug.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fields(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn missing_profile_is_none() {
        assert_eq!(Station::from_fields("x", HashMap::new()), None);
    }

    #[test]
    fn optional_fields_default_sensibly() {
        let s = Station::from_fields("jazz", fields(&[("primary", "http://a/b"), ("backup", "")])).unwrap();
        assert_eq!(s.name, "jazz");
        assert_eq!(s.backup, None);
        assert_eq!(s.max_listeners, 0);
        assert!(s.active);
    }

    #[test]
    fn suspended_flag_is_read() {
        let s = Station::from_fields("jazz", fields(&[("primary", "http://a/b"), ("active", "0")])).unwrap();
        assert!(!s.active);
    }

    #[test]
    fn failover_settings_and_media() {
        let s = Station::from_fields("jazz", fields(&[("primary", "http://a/b")])).unwrap();
        assert_eq!(s.failover_delay, Duration::from_secs(6));
        assert!(s.silence_detection && s.noise_detection);
        assert_eq!(s.silence_threshold_db, None);
        assert_eq!((s.ident, s.fallback), (None, None));

        let s = Station::from_fields(
            "jazz",
            fields(&[("primary", "http://a/b"), ("failover_delay", "12"), ("silence", "0"), ("fallback_id", "7"), ("fallback_ver", "abc"), ("fallback_name", "Night mix")]),
        )
        .unwrap();
        assert_eq!(s.failover_delay, Duration::from_secs(12));
        assert!(!s.silence_detection);
        assert_eq!(s.fallback, Some(Media { id: "7".into(), version: "abc".into(), name: "Night mix".into() }));
    }

    #[test]
    fn defaults_for_what_is_shown() {
        let s = Station::from_fields("jazz", fields(&[("primary", "http://a/b"), ("default_title", " Jazz FM "), ("default_artist", ""), ("default_artwork", "/api/v1/public/stations/jazz/artwork?v=ab")])).unwrap();
        assert_eq!(s.default_title.as_deref(), Some("Jazz FM"));
        assert_eq!(s.default_artist, None);
        assert_eq!(s.default_artwork.as_deref(), Some("/api/v1/public/stations/jazz/artwork?v=ab"));
    }

    #[test]
    fn slug_rules() {
        assert!(valid_slug("power-beats_96"));
        assert!(!valid_slug("Power"));
        assert!(!valid_slug("a/b"));
        assert!(!valid_slug(""));
    }
}
