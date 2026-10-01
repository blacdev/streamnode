-- Streaming servers HAProxy spreads listeners across. The engine that ships
-- in the main compose file is the built-in row; more can be added at runtime.
CREATE TABLE engine_nodes (
    id         SERIAL PRIMARY KEY,
    name       VARCHAR(50) UNIQUE NOT NULL,
    host       VARCHAR(255) NOT NULL,
    port       INT NOT NULL DEFAULT 3000 CHECK (port BETWEEN 1 AND 65535),
    -- Relative share of new listeners (1-256).
    weight     INT NOT NULL DEFAULT 100 CHECK (weight BETWEEN 1 AND 256),
    -- false drains the server: current listeners stay, no new ones arrive.
    enabled    BOOLEAN NOT NULL DEFAULT true,
    is_builtin BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (host, port)
);

INSERT INTO engine_nodes (name, host, port, is_builtin) VALUES ('local', 'audio_engine', 3000, true);
