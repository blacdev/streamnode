-- The service log: what happened to stations, streaming servers and the
-- gateway itself, shown under Logs in the dashboard. Pruned after the number
-- of days set there (log_retention_days, at least 7).
CREATE TABLE service_events (
  id BIGSERIAL PRIMARY KEY,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  level TEXT NOT NULL CHECK (level IN ('info', 'warning', 'error')),
  -- switch, source, station, file, server, certificate, update, admin, system
  category TEXT NOT NULL,
  station TEXT,
  -- The streaming server it happened on; empty for the gateway itself.
  node TEXT,
  message TEXT NOT NULL
);
CREATE INDEX service_events_at ON service_events (at);
CREATE INDEX service_events_station_at ON service_events (station, at);
