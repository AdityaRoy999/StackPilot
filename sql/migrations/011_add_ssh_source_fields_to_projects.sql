-- Support multiple project source modes, including SSH/VPS folders
ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS source_type VARCHAR(20) DEFAULT 'github',
    ADD COLUMN IF NOT EXISTS ssh_connection_id UUID REFERENCES ssh_connections(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS source_path TEXT DEFAULT '';

UPDATE projects
SET source_type = CASE
    WHEN COALESCE(source_type, '') = '' THEN 'github'
    ELSE source_type
END
WHERE COALESCE(source_type, '') = '';
