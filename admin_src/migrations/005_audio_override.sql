-- Set while an administrator forces a server out of rotation as having no
-- audio; holds the reason shown on the dashboard. NULL means the engine's own
-- detection decides.
ALTER TABLE engine_nodes ADD COLUMN audio_override VARCHAR(200);
