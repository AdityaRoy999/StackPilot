-- Store the desired runtime URL scheme at project level and snapshot it per deployment.
ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS runtime_scheme VARCHAR(10) NOT NULL DEFAULT 'http',
    ADD COLUMN IF NOT EXISTS local_https_enabled BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE projects
SET runtime_scheme = CASE
    WHEN local_https_enabled THEN 'https'
    WHEN runtime_scheme IN ('http', 'https') THEN runtime_scheme
    ELSE 'http'
END;

ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_runtime_scheme_check;
ALTER TABLE projects
    ADD CONSTRAINT projects_runtime_scheme_check CHECK (runtime_scheme IN ('http', 'https'));
