-- Files in another format than their station's stream can be converted to it,
-- with their owner's consent. Conversion happens in the background; the row
-- exists from the moment of upload and says how far along it is.
ALTER TABLE media_files
    -- 'converting' until the converted audio is in place; 'failed' if it could not be made.
    ADD COLUMN status VARCHAR(12) NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'converting', 'failed')),
    ADD COLUMN status_detail VARCHAR(300),
    -- The stored audio is the gateway's conversion, not what was uploaded.
    ADD COLUMN converted BOOLEAN NOT NULL DEFAULT false,
    -- How much the audio was turned up or down to sit at the stream's level, in dB.
    ADD COLUMN gain_db NUMERIC(5, 1),
    -- The stream's level the file is being brought to, while it is converted.
    ADD COLUMN target_level_db NUMERIC(5, 1),
    -- A conversion of a file already in the library: which file, and for which
    -- station. When it is ready it takes that file's place on the station, and
    -- the original is removed if nothing else uses it.
    ADD COLUMN replaces_id INT REFERENCES media_files(id) ON DELETE SET NULL,
    ADD COLUMN for_station_id INT REFERENCES stations(id) ON DELETE SET NULL;
