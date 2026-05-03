-- Add provider metadata to users
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS sign_in_type VARCHAR(20) DEFAULT 'local',
    ADD COLUMN IF NOT EXISTS google_sub VARCHAR(255);

UPDATE users
SET sign_in_type = 'local'
WHERE sign_in_type IS NULL OR sign_in_type = '';

ALTER TABLE users
    ALTER COLUMN sign_in_type SET DEFAULT 'local',
    ALTER COLUMN sign_in_type SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_sub
    ON users(google_sub)
    WHERE google_sub IS NOT NULL;
