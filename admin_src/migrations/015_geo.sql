-- Which countries a station may be heard in (used only with GEO_ENABLED):
-- 'off', 'block' (geo_countries are refused) or 'allow' (only geo_countries).
ALTER TABLE stations ADD COLUMN geo_mode TEXT NOT NULL DEFAULT 'off' CHECK (geo_mode IN ('off', 'block', 'allow'));
ALTER TABLE stations ADD COLUMN geo_countries TEXT[] NOT NULL DEFAULT '{}';

-- Listening sessions per station and UTC day, by country and by device,
-- counted from HAProxy's log of finished sessions.
CREATE TABLE station_audience_daily (
  station_id INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  dimension TEXT NOT NULL CHECK (dimension IN ('country', 'device')),
  key TEXT NOT NULL,
  sessions BIGINT NOT NULL DEFAULT 0,
  listener_seconds BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (station_id, day, dimension, key)
);
