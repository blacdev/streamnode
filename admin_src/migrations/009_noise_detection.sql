ALTER TABLE stations
    -- Treat a stream that carries nothing but steady noise (hiss), however loud, as having no audio.
    ADD COLUMN noise_detection BOOLEAN NOT NULL DEFAULT true,
    -- How quiet counts as silent for this station, in dB below full level; NULL uses the server's setting.
    ADD COLUMN silence_threshold_db INT CHECK (silence_threshold_db BETWEEN -90 AND -10);
