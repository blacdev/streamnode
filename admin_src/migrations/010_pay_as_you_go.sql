-- A subscription covers a station's listener limit and an account's storage
-- quota. What happens beyond that is chosen per station and per account:
-- capped (more is refused), or pay as you go (more is allowed and charged).
ALTER TABLE stations
    ADD COLUMN overage_mode VARCHAR(16) NOT NULL DEFAULT 'capped' CHECK (overage_mode IN ('capped', 'pay_as_you_go')),
    -- With pay as you go: the most listeners the station may ever have. NULL means no ceiling.
    ADD COLUMN listener_ceiling INT CHECK (listener_ceiling > 0);

ALTER TABLE users
    -- Uploads beyond the storage quota are allowed and charged, rather than refused.
    ADD COLUMN storage_overage BOOLEAN NOT NULL DEFAULT false,
    -- With that: the most storage the account may ever use, in megabytes. NULL means no ceiling.
    ADD COLUMN storage_ceiling_mb INT CHECK (storage_ceiling_mb > 0);
