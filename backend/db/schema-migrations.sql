
-- Haejumi PostgreSQL migration history
-- Existing Creator tables are preserved.

CREATE TABLE IF NOT EXISTS haejumi_dev.schema_migrations (
    version TEXT PRIMARY KEY,
    description TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT schema_migrations_checksum_check
        CHECK (checksum ~ '^[a-f0-9]{64}$')
);
