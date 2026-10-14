CREATE TABLE IF NOT EXISTS rdp_connections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    host VARCHAR(253) NOT NULL,
    port INTEGER NOT NULL DEFAULT 3389 CHECK (port BETWEEN 1 AND 65535),
    username VARCHAR(256) NOT NULL,
    domain VARCHAR(256) NOT NULL DEFAULT '',
    password_encrypted TEXT NOT NULL,
    security VARCHAR(10) NOT NULL DEFAULT 'nla' CHECK (security IN ('nla', 'tls', 'any')),
    ignore_certificate BOOLEAN NOT NULL DEFAULT false,
    keyboard_layout VARCHAR(30) NOT NULL DEFAULT 'en-us-qwerty',
    revision INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rdp_connections_owner ON rdp_connections(user_id, created_at DESC);
