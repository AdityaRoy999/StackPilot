-- Acceptance is frozen outside the executable repository and bound to a run.
CREATE TABLE IF NOT EXISTS agent_completion_plans (
    run_id TEXT PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
    contract TEXT NOT NULL,
    contract_digest TEXT NOT NULL,
    source_revision TEXT NOT NULL,
    intent_source TEXT NOT NULL,
    created_at DOUBLE PRECISION NOT NULL
);
