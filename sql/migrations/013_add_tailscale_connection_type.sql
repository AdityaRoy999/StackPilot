-- Add explicit remote connection mode. Existing saved connections remain normal SSH.
ALTER TABLE ssh_connections
    ADD COLUMN IF NOT EXISTS connection_type VARCHAR(20) NOT NULL DEFAULT 'ssh';

UPDATE ssh_connections
SET connection_type = 'ssh'
WHERE COALESCE(connection_type, '') = '';

UPDATE ssh_connections
SET auth_type = 'tailscale',
    password_encrypted = NULL,
    private_key_encrypted = NULL
WHERE connection_type = 'tailscale';

CREATE INDEX IF NOT EXISTS idx_ssh_connections_user_connection_type
    ON ssh_connections(user_id, connection_type);
