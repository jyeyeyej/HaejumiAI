BEGIN;

CREATE TABLE IF NOT EXISTS haejumi_dev.creator_publications (
    publication_id UUID PRIMARY KEY,
    task_id UUID NOT NULL
        REFERENCES haejumi_dev.creator_tasks(task_id),
    owner_id TEXT NOT NULL,
    platform TEXT NOT NULL
        CHECK (platform IN ('youtube', 'instagram', 'tiktok')),
    revision INTEGER NOT NULL DEFAULT 1
        CHECK (revision >= 1),
    metadata_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'publish_ready')),
    publication_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (task_id, platform)
);

CREATE TABLE IF NOT EXISTS haejumi_dev.creator_publication_approvals (
    approval_id UUID PRIMARY KEY,
    publication_id UUID NOT NULL
        REFERENCES haejumi_dev.creator_publications(publication_id),
    task_id UUID NOT NULL
        REFERENCES haejumi_dev.creator_tasks(task_id),
    owner_id TEXT NOT NULL,
    content_version INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    artifact_sha256 TEXT NOT NULL,
    publication_revision INTEGER NOT NULL,
    publication_hash TEXT NOT NULL,
    approval_hash TEXT NOT NULL,
    status TEXT NOT NULL
        CHECK (status IN ('active', 'invalidated')),
    approval_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    approved_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS
    idx_creator_publication_active_approval
ON haejumi_dev.creator_publication_approvals(publication_id)
WHERE status = 'active';

CREATE TABLE IF NOT EXISTS haejumi_dev.creator_publication_idempotency (
    request_key TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;