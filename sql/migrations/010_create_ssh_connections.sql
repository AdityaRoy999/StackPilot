-- Store encrypted SSH/VPS connections for remote source sync
CREATE TABLE IF NOT EXISTS ssh_connections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    host VARCHAR(255) NOT NULL,
    port INTEGER NOT NULL DEFAULT 22,
    username VARCHAR(255) NOT NULL,
    auth_type VARCHAR(20) NOT NULL DEFAULT 'password',
    password_encrypted TEXT DEFAULT '',
    private_key_encrypted TEXT DEFAULT '',
    known_hosts_entry TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_tested_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_ssh_connections_user_id
    ON ssh_connections(user_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ssh_connections_user_name
    ON ssh_connections(user_id, name);
