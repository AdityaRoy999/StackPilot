-- ============================================================
-- Migration 003: Create Deployments Table
-- Purpose: Track each deployment attempt for a project
-- ============================================================
-- CONCEPT: This table records every deployment. A project can
-- have many deployments (one-to-many relationship).
-- Later phases will populate this when Docker builds run and
-- containers get deployed to Kubernetes.
-- ============================================================

CREATE TABLE IF NOT EXISTS deployments (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Which project this deployment belongs to
    project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

    -- Deployment status lifecycle:
    -- 'pending' → 'building' → 'deploying' → 'running' → 'failed' → 'stopped'
    status      VARCHAR(20) DEFAULT 'pending',

    -- Version tag (e.g., "v1.0.0", "v1.0.1")
    version     VARCHAR(50) DEFAULT '',

    -- Git commit hash for traceability
    commit_hash VARCHAR(40) DEFAULT '',

    -- Build/deploy logs (will be large in production, consider separate table later)
    logs        TEXT DEFAULT '',

    -- Container image name once built (e.g., "stackpilot-platform/myapp:v1")
    image_name  VARCHAR(255) DEFAULT '',

    created_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for fast lookups by project
CREATE INDEX IF NOT EXISTS idx_deployments_project_id ON deployments(project_id);

-- Index for filtering by status (e.g., "show all running deployments")
CREATE INDEX IF NOT EXISTS idx_deployments_status ON deployments(status);
