-- Migration 056: High-Performance Composite Indexes
-- Eliminates table scans on frequently filtered and sorted queries across deployments, ai_runs, and jobs.

-- 1. Accelerates project deployment history retrieval (sorted newest first)
CREATE INDEX IF NOT EXISTS idx_deployments_project_created
    ON deployments (project_id, created_at DESC);

-- 2. Accelerates active deployment polling and reaper worker status updates
CREATE INDEX IF NOT EXISTS idx_deployments_status_updated
    ON deployments (status, updated_at DESC);

-- 3. Accelerates AI runs filtering by user and run lifecycle status
CREATE INDEX IF NOT EXISTS idx_ai_runs_user_status_created
    ON ai_runs (user_id, status, created_at DESC);

-- 4. Accelerates fast message retrieval and keyset pagination by session
CREATE INDEX IF NOT EXISTS idx_ai_messages_session_id_id
    ON ai_messages (session_id, id);

-- 5. Accelerates user job queue lookup and dashboard status counters
CREATE INDEX IF NOT EXISTS idx_deployment_jobs_user_status
    ON deployment_jobs (user_id, status, created_at DESC);
