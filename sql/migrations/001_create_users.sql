-- ============================================================
-- Migration 001: Create Users Table
-- Purpose: Store user accounts for the platform
-- ============================================================
-- CONCEPT: This is a "migration" — a version-controlled change
-- to your database schema. Each migration file runs in order.
-- This ensures every developer (and production) has the same
-- database structure.
-- ============================================================

-- Enable UUID generation (PostgreSQL extension)
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
    -- UUID is better than auto-increment for distributed systems
    -- gen_random_uuid() generates a unique ID automatically
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- UNIQUE constraint prevents duplicate usernames/emails
    username    VARCHAR(50)  UNIQUE NOT NULL,
    email       VARCHAR(255) UNIQUE NOT NULL,

    -- We store the HASH, never the plain password
    -- bcrypt produces ~60 char hashes
    password_hash VARCHAR(255) NOT NULL,

    -- Timestamps for auditing
    created_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index on email for fast login lookups
-- CONCEPT: An index is like a book's index — it lets the database
-- find rows quickly without scanning every row
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
