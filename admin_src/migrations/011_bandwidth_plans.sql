-- A station is on one of two kinds of plan. By listeners: it pays for a number
-- of listeners at once (max_listeners). By bandwidth: it pays for an amount of
-- data a month and may have any number of listeners; what counts is how fast
-- the data is used. The allowance starts again each calendar month (UTC); the
-- daily statistics keep every month's record.
ALTER TABLE stations
    ADD COLUMN plan_type VARCHAR(12) NOT NULL DEFAULT 'listeners' CHECK (plan_type IN ('listeners', 'bandwidth')),
    -- The month's allowance on a bandwidth plan, in gigabytes (1,000,000,000 bytes).
    ADD COLUMN bandwidth_gb NUMERIC(12, 2) CHECK (bandwidth_gb > 0),
    -- Set while a capped bandwidth plan has used its month's allowance: the
    -- station is off the air until the month turns or the allowance is raised.
    ADD COLUMN blocked VARCHAR(20);
