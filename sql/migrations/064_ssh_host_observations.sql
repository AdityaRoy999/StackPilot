ALTER TABLE ssh_connections ADD COLUMN IF NOT EXISTS host_capabilities jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE ssh_connections ADD COLUMN IF NOT EXISTS last_probed_at timestamptz;
ALTER TABLE ssh_connections ADD COLUMN IF NOT EXISTS last_probe_error text NOT NULL DEFAULT '';
