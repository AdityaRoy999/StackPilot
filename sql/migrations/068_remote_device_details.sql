-- Optional labels are supplied by the device owner, never inferred coordinates.
ALTER TABLE remote_devices ADD COLUMN IF NOT EXISTS location_label VARCHAR(160) NOT NULL DEFAULT '';
ALTER TABLE remote_devices ADD COLUMN IF NOT EXISTS timezone VARCHAR(80) NOT NULL DEFAULT '';
ALTER TABLE remote_devices ADD COLUMN IF NOT EXISTS user_agent VARCHAR(512) NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS remote_runs_device ON remote_runs(device_id);
