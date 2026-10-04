CREATE TABLE IF NOT EXISTS deployment_monitor_leases (
    deployment_id UUID PRIMARY KEY REFERENCES deployments(id) ON DELETE CASCADE,
    next_probe_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    locked_by TEXT,
    locked_until TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS deployment_monitors_due ON deployment_monitor_leases(next_probe_at,locked_until);
