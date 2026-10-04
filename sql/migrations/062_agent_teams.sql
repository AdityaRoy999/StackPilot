-- Real agent sessions. Deployment jobs remain the authority for release success.
CREATE TABLE IF NOT EXISTS agent_runs (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, session_id TEXT NOT NULL,
    project_id TEXT NOT NULL, deployment_id TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL DEFAULT 'working', source_root TEXT NOT NULL,
    original_revision TEXT NOT NULL DEFAULT '', effective_revision TEXT NOT NULL DEFAULT '',
    settings TEXT NOT NULL DEFAULT '{}', max_parallel INTEGER NOT NULL,
    max_tasks INTEGER NOT NULL, max_turns INTEGER NOT NULL,
    deadline DOUBLE PRECISION NOT NULL, created_at DOUBLE PRECISION NOT NULL,
    updated_at DOUBLE PRECISION NOT NULL
);
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS lead_owner TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS lead_until DOUBLE PRECISION NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS agent_runs_owner ON agent_runs(user_id,session_id,updated_at);
CREATE TABLE IF NOT EXISTS agent_approvals (
    nonce TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires DOUBLE PRECISION NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_tasks (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    parent_id TEXT NOT NULL, role TEXT NOT NULL, goal TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'queued', spec TEXT NOT NULL DEFAULT '{}',
    checkpoint TEXT NOT NULL DEFAULT '{}', result TEXT NOT NULL DEFAULT '{}',
    attempt INTEGER NOT NULL DEFAULT 0, lease_owner TEXT NOT NULL DEFAULT '',
    lease_until DOUBLE PRECISION NOT NULL DEFAULT 0,
    turns INTEGER NOT NULL DEFAULT 0, created_at DOUBLE PRECISION NOT NULL,
    updated_at DOUBLE PRECISION NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_tasks_due ON agent_tasks(state,lease_until,created_at);
CREATE INDEX IF NOT EXISTS agent_tasks_run ON agent_tasks(run_id,state);
CREATE TABLE IF NOT EXISTS agent_events (
    run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    sequence BIGINT NOT NULL, agent_id TEXT NOT NULL,
    event TEXT NOT NULL, created_at DOUBLE PRECISION NOT NULL,
    PRIMARY KEY(run_id,sequence)
);
CREATE TABLE IF NOT EXISTS agent_messages (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    sender TEXT NOT NULL, recipient TEXT NOT NULL, content TEXT NOT NULL,
    created_at DOUBLE PRECISION NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_messages_inbox ON agent_messages(run_id,recipient,created_at);
CREATE TABLE IF NOT EXISTS agent_patches (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
    base_revision TEXT NOT NULL, revision TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'submitted', details TEXT NOT NULL,
    created_at DOUBLE PRECISION NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_requirements (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    task_id TEXT NOT NULL, kind TEXT NOT NULL, description TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'open', resolution TEXT NOT NULL DEFAULT '{}',
    created_at DOUBLE PRECISION NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_verifications (
    run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    revision TEXT NOT NULL, task_id TEXT NOT NULL, status TEXT NOT NULL,
    evidence TEXT NOT NULL, created_at DOUBLE PRECISION NOT NULL,
    PRIMARY KEY(run_id,revision)
);
