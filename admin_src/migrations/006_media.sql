-- Uploaded audio: station idents and the files played when a station's
-- streams have no audio. A file belongs to one account and may be used by
-- any number of that account's stations.
CREATE TABLE media_files (
    id               SERIAL PRIMARY KEY,
    user_id          INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name             VARCHAR(100) NOT NULL,
    original_name    VARCHAR(255),
    size_bytes       BIGINT NOT NULL,
    codec            VARCHAR(8) NOT NULL,
    sample_rate      INT NOT NULL,
    channels         SMALLINT NOT NULL,
    bitrate_kbps     INT NOT NULL,
    constant_bitrate BOOLEAN NOT NULL,
    duration_seconds NUMERIC(12, 2) NOT NULL,
    -- Where the audio itself starts and how long it is; tags are left out when it is played.
    audio_offset     BIGINT NOT NULL,
    audio_bytes      BIGINT NOT NULL,
    sha256           CHAR(64) NOT NULL,
    -- 'local': only on this server. 'dropbox': kept in Dropbox, with a local copy that may be dropped to save space.
    storage          VARCHAR(10) NOT NULL DEFAULT 'local' CHECK (storage IN ('local', 'dropbox')),
    storage_path     VARCHAR(400),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_media_files_user ON media_files(user_id);

-- Megabytes of uploads an account may hold; NULL means the gateway's default.
ALTER TABLE users ADD COLUMN storage_quota_mb INT CHECK (storage_quota_mb >= 0);

ALTER TABLE stations
    -- Seconds a source may deliver no audio before the station moves on, and
    -- that a source must be healthy before the station returns to it.
    ADD COLUMN failover_delay_secs INT NOT NULL DEFAULT 6 CHECK (failover_delay_secs BETWEEN 1 AND 300),
    -- Treat a source that sends silence as having no audio.
    ADD COLUMN silence_detection BOOLEAN NOT NULL DEFAULT true,
    -- Played once when the station switches away from a failed source.
    ADD COLUMN ident_file_id INT REFERENCES media_files(id) ON DELETE SET NULL,
    -- Looped while neither stream has audio.
    ADD COLUMN fallback_file_id INT REFERENCES media_files(id) ON DELETE SET NULL;

-- Gateway-wide settings changed from the dashboard or API.
CREATE TABLE settings (
    key        VARCHAR(50) PRIMARY KEY,
    value      JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
