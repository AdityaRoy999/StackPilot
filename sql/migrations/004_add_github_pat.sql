-- ============================================================
-- Migration 004: Add GitHub PAT to Projects
-- Purpose: Store Personal Access Token for private repo access
-- ============================================================

ALTER TABLE projects ADD COLUMN IF NOT EXISTS github_pat TEXT DEFAULT '';
