-- What a server's network port can carry, for working out how many listeners
-- it has room for. Entered by the administrator; servers cannot tell.
ALTER TABLE engine_nodes ADD COLUMN port_mbps INT NOT NULL DEFAULT 1000 CHECK (port_mbps > 0);

ALTER TABLE users
    -- Where notices about limits and subscriptions are sent. Optional.
    ADD COLUMN email VARCHAR(254),
    -- Taken off the account's total, in percent.
    ADD COLUMN discount_percent NUMERIC(5, 2) NOT NULL DEFAULT 0 CHECK (discount_percent BETWEEN 0 AND 100);

ALTER TABLE stations
    -- The bitrate the station is priced at; NULL means the bitrate detected on its stream.
    ADD COLUMN billing_bitrate_kbps INT CHECK (billing_bitrate_kbps BETWEEN 8 AND 2000),
    ADD COLUMN discount_percent NUMERIC(5, 2) NOT NULL DEFAULT 0 CHECK (discount_percent BETWEEN 0 AND 100),
    -- A fixed monthly price that replaces the calculated one.
    ADD COLUMN price_override NUMERIC(12, 2) CHECK (price_override >= 0),
    -- The last day the station is paid for; NULL means no end.
    ADD COLUMN subscription_ends_on DATE;

-- One row per notice sent, so that the same notice is not sent twice in its
-- period (a month, a week or a day, depending on how close the limit is).
CREATE TABLE notifications (
    id         BIGSERIAL PRIMARY KEY,
    user_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- 0 for a notice about the account rather than one station.
    station_id INT NOT NULL DEFAULT 0,
    kind       VARCHAR(20) NOT NULL,
    threshold  INT NOT NULL,
    period     VARCHAR(24) NOT NULL,
    recipient  VARCHAR(254) NOT NULL,
    subject    VARCHAR(200) NOT NULL,
    sent_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, station_id, kind, threshold, period)
);
CREATE INDEX idx_notifications_sent ON notifications(sent_at DESC);
