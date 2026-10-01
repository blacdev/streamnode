-- Accounts. An 'admin' operates the gateway; a 'tenant' owns stations.
CREATE TABLE users (
    id            SERIAL PRIMARY KEY,
    username      VARCHAR(50) UNIQUE NOT NULL,
    -- NULL for accounts that only ever authenticate with API keys.
    password_hash VARCHAR(255),
    role          VARCHAR(10) NOT NULL DEFAULT 'tenant' CHECK (role IN ('admin', 'tenant')),
    -- Identifier of this account in an external system (e.g. a WHMCS client id).
    external_id   VARCHAR(100) UNIQUE,
    -- Stations a tenant may create on their own; 0 means provisioning is admin-only.
    max_stations  INT NOT NULL DEFAULT 0 CHECK (max_stations >= 0),
    is_active     BOOLEAN NOT NULL DEFAULT true,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE stations (
    id            SERIAL PRIMARY KEY,
    user_id       INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name          VARCHAR(100) NOT NULL,
    slug          VARCHAR(50) UNIQUE NOT NULL,
    primary_url   VARCHAR(500) NOT NULL,
    backup_url    VARCHAR(500),
    -- Optional endpoint polled for the current title/artist/artwork.
    metadata_url  VARCHAR(500),
    -- Optional station artwork, used when the metadata URL supplies none.
    artwork_url   VARCHAR(500),
    -- Concurrent listener cap; 0 means unlimited.
    max_listeners INT NOT NULL DEFAULT 0 CHECK (max_listeners >= 0),
    -- Identifier of this station in an external system (e.g. a WHMCS service id).
    external_id   VARCHAR(100),
    is_active     BOOLEAN NOT NULL DEFAULT true,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_stations_user ON stations(user_id);
CREATE INDEX idx_stations_external ON stations(external_id) WHERE external_id IS NOT NULL;

-- Only the SHA-256 of a key is stored; the key itself is shown once at creation.
CREATE TABLE api_keys (
    id           SERIAL PRIMARY KEY,
    user_id      INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name         VARCHAR(50) NOT NULL,
    key_prefix   VARCHAR(12) NOT NULL,
    key_hash     CHAR(64) UNIQUE NOT NULL,
    last_used_at TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_api_keys_user ON api_keys(user_id);

-- One row per station per flush (about once a minute) while it has activity.
CREATE TABLE station_stats_minute (
    station_id       INT NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
    recorded_at      TIMESTAMPTZ NOT NULL,
    bytes            BIGINT NOT NULL DEFAULT 0,
    peak_listeners   INT NOT NULL DEFAULT 0,
    listener_seconds BIGINT NOT NULL DEFAULT 0,
    sessions         INT NOT NULL DEFAULT 0,
    PRIMARY KEY (station_id, recorded_at)
);

CREATE INDEX idx_stats_minute_time ON station_stats_minute(recorded_at);

-- Permanent daily rollup (UTC days); the source for billing and long-range charts.
CREATE TABLE station_stats_daily (
    station_id       INT NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
    day              DATE NOT NULL,
    bytes            BIGINT NOT NULL DEFAULT 0,
    peak_listeners   INT NOT NULL DEFAULT 0,
    listener_seconds BIGINT NOT NULL DEFAULT 0,
    sessions         INT NOT NULL DEFAULT 0,
    PRIMARY KEY (station_id, day)
);

CREATE TABLE audit_log (
    id         BIGSERIAL PRIMARY KEY,
    at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    user_id    INT,
    username   VARCHAR(50),
    action     VARCHAR(50) NOT NULL,
    target     VARCHAR(120),
    detail     JSONB,
    ip         VARCHAR(64)
);

CREATE INDEX idx_audit_at ON audit_log(at DESC);
