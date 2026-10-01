use std::collections::HashMap;

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
    /// 0 means unlimited.
    pub max_listeners: usize,
    pub active: bool,
}

impl Station {
    pub async fn load(redis: &mut ConnectionManager, slug: &str) -> RedisResult<Option<Self>> {
        let fields: HashMap<String, String> = redis.hgetall(format!("station:{slug}")).await?;
        Ok(Self::from_fields(slug, fields))
    }

    fn from_fields(slug: &str, mut fields: HashMap<String, String>) -> Option<Self> {
        let mut take = |key: &str| fields.remove(key).map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
        let primary = take("primary")?;
        Some(Self {
            slug: slug.to_string(),
            name: take("name").unwrap_or_else(|| slug.to_string()),
            primary,
            backup: take("backup"),
            metadata_url: take("metadata_url"),
            artwork_url: take("artwork_url"),
            max_listeners: take("max_listeners").and_then(|v| v.parse().ok()).unwrap_or(0),
            active: take("active").is_none_or(|v| v != "0"),
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
    fn slug_rules() {
        assert!(valid_slug("power-beats_96"));
        assert!(!valid_slug("Power"));
        assert!(!valid_slug("a/b"));
        assert!(!valid_slug(""));
    }
}
