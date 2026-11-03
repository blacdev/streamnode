-- More fallback audio, by day of the week. The station's fallback_file_id
-- stays its everyday fallback; these entries add files for chosen days, which
-- play instead of it on those days (one after another, in position order).
CREATE TABLE station_fallbacks (
  id SERIAL PRIMARY KEY,
  station_id INT NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  file_id INT NOT NULL REFERENCES media_files(id) ON DELETE CASCADE,
  -- ISO days of the week: 1 is Monday, 7 is Sunday.
  days SMALLINT[] NOT NULL CHECK (cardinality(days) BETWEEN 1 AND 7 AND days <@ ARRAY[1, 2, 3, 4, 5, 6, 7]::SMALLINT[]),
  position INT NOT NULL DEFAULT 0
);
CREATE INDEX station_fallbacks_station ON station_fallbacks (station_id, position);
CREATE INDEX station_fallbacks_file ON station_fallbacks (file_id);

-- The time zone the station's days are counted in (an IANA name).
ALTER TABLE stations ADD COLUMN timezone TEXT NOT NULL DEFAULT 'UTC';
