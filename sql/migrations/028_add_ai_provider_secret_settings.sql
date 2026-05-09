ALTER TABLE ai_preferences
    ADD COLUMN IF NOT EXISTS openai_compatible_api_key TEXT;
