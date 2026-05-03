-- ============================================================
-- Migration 002: Create Projects Table
-- Purpose: Store user projects (apps they want to deploy)
-- ============================================================
-- CONCEPT: Foreign Keys create relationships between tables.
-- project.user_id REFERENCES users(id) means every project
-- must belong to a valid user. ON DELETE CASCADE means if a
-- user is deleted, their projects are automatically deleted too.
-- ============================================================

CREATE TABLE IF NOT EXISTS projects (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Foreign key: links this project to a user
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    name        VARCHAR(100) NOT NULL,
    description TEXT DEFAULT '',

    -- Git repository URL for the project source code
    repo_url    VARCHAR(500) DEFAULT '',

    -- Status tracks project lifecycle
    -- 'active', 'archived', 'deleted'
    status      VARCHAR(20) DEFAULT 'active',

    created_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index on user_id for fast "get my projects" queries
CREATE INDEX IF NOT EXISTS idx_projects_user_id ON projects(user_id);
