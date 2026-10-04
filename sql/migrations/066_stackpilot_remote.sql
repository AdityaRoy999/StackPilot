-- Phone credentials are opaque, revocable capabilities; only hashes are stored.
CREATE TABLE IF NOT EXISTS remote_pairings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    secret_hash TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '5 minutes',
    claimed BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS remote_devices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pairing_id UUID NOT NULL UNIQUE REFERENCES remote_pairings(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    confirmation_code TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied','revoked')),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '30 days',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS remote_devices_owner ON remote_devices(user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS remote_runs (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id UUID REFERENCES remote_devices(id) ON DELETE SET NULL,
    session_id UUID NOT NULL REFERENCES ai_sessions(id) ON DELETE CASCADE,
    request_hash TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'working',
    last_sequence BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS remote_runs_owner ON remote_runs(user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS remote_runs_single_session ON remote_runs(session_id) WHERE state='working';
CREATE TABLE IF NOT EXISTS remote_run_events (
    run_id UUID NOT NULL REFERENCES remote_runs(id) ON DELETE CASCADE,
    sequence BIGINT NOT NULL,
    event JSONB NOT NULL,
    PRIMARY KEY(run_id, sequence)
);
