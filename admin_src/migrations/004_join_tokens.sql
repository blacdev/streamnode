-- One-time tokens a new slave node presents to enrol with this master.
-- Only the SHA-256 of a token is stored.
CREATE TABLE join_tokens (
    id            SERIAL PRIMARY KEY,
    token_hash    CHAR(64) UNIQUE NOT NULL,
    token_prefix  VARCHAR(12) NOT NULL,
    note          VARCHAR(100),
    -- When set, the token is honoured only from this address.
    bound_address VARCHAR(255),
    max_uses      INT NOT NULL DEFAULT 1 CHECK (max_uses >= 1),
    uses          INT NOT NULL DEFAULT 0,
    expires_at    TIMESTAMPTZ NOT NULL,
    created_by    INT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
