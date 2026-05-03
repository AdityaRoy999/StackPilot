ALTER TABLE users
    ADD COLUMN IF NOT EXISTS token_invalid_before TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT TO_TIMESTAMP(0);

CREATE TABLE IF NOT EXISTS password_reset_otps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    otp_hash VARCHAR(255) NOT NULL,
    delivery_email VARCHAR(255) NOT NULL,
    request_ip TEXT NOT NULL DEFAULT '',
    attempts_used INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 5,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    consumed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_password_reset_otps_user_created
    ON password_reset_otps(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_password_reset_otps_expires_at
    ON password_reset_otps(expires_at);
