CREATE TABLE IF NOT EXISTS ai_provider_connections (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name text NOT NULL,
    vendor text NOT NULL DEFAULT 'custom',
    provider text NOT NULL CHECK (provider IN ('nvidia_nim', 'openai_compatible')),
    base_url text NOT NULL DEFAULT '',
    api_key_encrypted text,
    active boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT NOW(),
    updated_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS ai_provider_connections_one_active
    ON ai_provider_connections(user_id) WHERE active;
-- Preserve existing credentials and the selected provider when upgrading.
INSERT INTO ai_provider_connections (user_id, name, vendor, provider, base_url, api_key_encrypted, active)
SELECT user_id, 'NVIDIA NIM', 'nvidia', 'nvidia_nim', 'https://integrate.api.nvidia.com/v1', nvidia_api_key, provider = 'nvidia_nim'
FROM ai_preferences WHERE NULLIF(nvidia_api_key, '') IS NOT NULL
AND NOT EXISTS (SELECT 1 FROM ai_provider_connections c WHERE c.user_id = ai_preferences.user_id AND c.provider = 'nvidia_nim');
INSERT INTO ai_provider_connections (user_id, name, vendor, provider, base_url, api_key_encrypted, active)
SELECT user_id, 'Compatible API', 'custom', 'openai_compatible', COALESCE(openai_compatible_base_url, 'https://api.openai.com/v1'), openai_compatible_api_key, provider = 'openai_compatible'
FROM ai_preferences WHERE NULLIF(openai_compatible_api_key, '') IS NOT NULL
AND NOT EXISTS (SELECT 1 FROM ai_provider_connections c WHERE c.user_id = ai_preferences.user_id AND c.provider = 'openai_compatible');
