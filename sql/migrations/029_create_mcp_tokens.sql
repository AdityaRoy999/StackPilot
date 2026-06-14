-- MCP (Model Context Protocol) API tokens
-- These tokens allow external AI tools (VS Code, Cursor, Gemini CLI, etc.)
-- to interact with the StackPilot platform on behalf of a user.
CREATE TABLE IF NOT EXISTS mcp_tokens (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name            VARCHAR(128) NOT NULL,
    token_hash      VARCHAR(128) NOT NULL UNIQUE,
    token_prefix    VARCHAR(12)  NOT NULL,           -- first 8 chars for display
    permissions     JSONB        NOT NULL DEFAULT '["read"]'::jsonb,
    last_used_at    TIMESTAMPTZ,
    expires_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mcp_tokens_user_id ON mcp_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_mcp_tokens_token_hash ON mcp_tokens(token_hash);
