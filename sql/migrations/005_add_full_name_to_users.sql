-- Add full_name column to users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS full_name VARCHAR(255);
