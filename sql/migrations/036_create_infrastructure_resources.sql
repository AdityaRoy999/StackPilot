-- ============================================================
-- Migration 036: Infrastructure Resource Claims
-- Purpose: Track Docker and Kubernetes resources explicitly claimed by users.
-- ============================================================

CREATE TABLE IF NOT EXISTS infrastructure_resources (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider_type   VARCHAR(32) NOT NULL CHECK (provider_type IN ('docker', 'kubernetes')),
    resource_type   VARCHAR(32) NOT NULL CHECK (
        resource_type IN ('container', 'image', 'node', 'pod', 'deployment', 'service')
    ),
    resource_key    TEXT NOT NULL,
    namespace       TEXT,
    name            TEXT NOT NULL,
    external_id     TEXT,
    image           TEXT,
    status          TEXT,
    ownership_state VARCHAR(24) NOT NULL DEFAULT 'claimed'
                    CHECK (ownership_state IN ('claimed', 'managed', 'released')),
    metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
    claimed_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    released_at     TIMESTAMP WITH TIME ZONE,
    updated_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE (user_id, provider_type, resource_type, resource_key)
);

CREATE INDEX IF NOT EXISTS idx_infrastructure_resources_user
    ON infrastructure_resources(user_id, ownership_state);

CREATE INDEX IF NOT EXISTS idx_infrastructure_resources_lookup
    ON infrastructure_resources(provider_type, resource_type, resource_key);
