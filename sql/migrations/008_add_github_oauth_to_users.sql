-- Add GitHub OAuth identity + encrypted access token storage
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS github_id VARCHAR(255),
    ADD COLUMN IF NOT EXISTS github_username VARCHAR(255) DEFAULT '',
    ADD COLUMN IF NOT EXISTS github_access_token TEXT DEFAULT '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_github_id
    ON users(github_id)
    WHERE github_id IS NOT NULL;
