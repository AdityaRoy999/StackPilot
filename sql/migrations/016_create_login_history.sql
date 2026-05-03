-- Audit successful sign-ins for account visibility.
CREATE TABLE IF NOT EXISTS login_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    login_method VARCHAR(30) NOT NULL,
    ip_address TEXT NOT NULL DEFAULT '',
    device TEXT NOT NULL DEFAULT '',
    user_agent TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_login_history_user_created
    ON login_history(user_id, created_at DESC);
