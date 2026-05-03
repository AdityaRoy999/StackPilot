ALTER TABLE deployments
ADD COLUMN IF NOT EXISTS source_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
ADD COLUMN IF NOT EXISTS env_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb,
ADD COLUMN IF NOT EXISTS runtime_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
ADD COLUMN IF NOT EXISTS artifact_available BOOLEAN NOT NULL DEFAULT TRUE,
ADD COLUMN IF NOT EXISTS artifact_digest TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS deployment_env_vars (
    deployment_id UUID NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
    key VARCHAR(255) NOT NULL,
    value_encrypted TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY (deployment_id, key)
);
