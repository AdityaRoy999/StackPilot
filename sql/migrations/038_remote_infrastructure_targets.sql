-- ============================================================
-- Migration 038: Remote infrastructure target claims
-- Purpose: Scope claimed Docker/Kubernetes resources to local or saved SSH targets.
-- ============================================================

ALTER TABLE infrastructure_resources
    ADD COLUMN IF NOT EXISTS target_type VARCHAR(24) NOT NULL DEFAULT 'local',
    ADD COLUMN IF NOT EXISTS target_connection_id UUID REFERENCES ssh_connections(id) ON DELETE SET NULL;

UPDATE infrastructure_resources
SET target_type = 'local'
WHERE target_type IS NULL OR target_type = '';

DO $$
DECLARE
    constraint_name TEXT;
BEGIN
    SELECT conname INTO constraint_name
    FROM pg_constraint
    WHERE conrelid = 'infrastructure_resources'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%resource_type%'
    LIMIT 1;

    IF constraint_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE infrastructure_resources DROP CONSTRAINT %I', constraint_name);
    END IF;
END $$;

ALTER TABLE infrastructure_resources
    ADD CONSTRAINT infrastructure_resources_resource_type_check
    CHECK (resource_type IN ('container', 'image', 'namespace', 'node', 'pod', 'deployment', 'service'));

DO $$
DECLARE
    constraint_name TEXT;
BEGIN
    SELECT conname INTO constraint_name
    FROM pg_constraint
    WHERE conrelid = 'infrastructure_resources'::regclass
      AND contype = 'u'
      AND pg_get_constraintdef(oid) = 'UNIQUE (user_id, provider_type, resource_type, resource_key)'
    LIMIT 1;

    IF constraint_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE infrastructure_resources DROP CONSTRAINT %I', constraint_name);
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_infrastructure_resources_user_target_resource
    ON infrastructure_resources (
        user_id,
        COALESCE(target_type, 'local'),
        COALESCE(target_connection_id, '00000000-0000-0000-0000-000000000000'::uuid),
        provider_type,
        resource_type,
        resource_key
    );

DROP INDEX IF EXISTS idx_infrastructure_resources_lookup;
CREATE INDEX IF NOT EXISTS idx_infrastructure_resources_lookup
    ON infrastructure_resources (
        COALESCE(target_type, 'local'),
        target_connection_id,
        provider_type,
        resource_type,
        resource_key
    );
