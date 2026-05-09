CREATE TABLE IF NOT EXISTS github_app_installations (
    installation_id TEXT PRIMARY KEY,
    account_login TEXT NOT NULL,
    account_type TEXT NOT NULL DEFAULT '',
    account_id TEXT NOT NULL DEFAULT '',
    repository_selection TEXT NOT NULL DEFAULT '',
    app_slug TEXT NOT NULL DEFAULT '',
    app_id TEXT NOT NULL DEFAULT '',
    raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    installed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    suspended_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS github_app_repositories (
    installation_id TEXT NOT NULL REFERENCES github_app_installations(installation_id) ON DELETE CASCADE,
    repository_id TEXT NOT NULL,
    full_name TEXT NOT NULL,
    owner_login TEXT NOT NULL DEFAULT '',
    repo_name TEXT NOT NULL DEFAULT '',
    private BOOLEAN NOT NULL DEFAULT FALSE,
    selected BOOLEAN NOT NULL DEFAULT TRUE,
    raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (installation_id, repository_id)
);

CREATE INDEX IF NOT EXISTS idx_github_app_repositories_full_name
    ON github_app_repositories (LOWER(full_name));

CREATE INDEX IF NOT EXISTS idx_github_app_repositories_installation
    ON github_app_repositories (installation_id);
