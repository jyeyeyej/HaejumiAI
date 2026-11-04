BEGIN;

CREATE TABLE IF NOT EXISTS haejumi_dev.creator_render_jobs (
    job_id UUID PRIMARY KEY,
    task_id UUID NOT NULL
        REFERENCES haejumi_dev.creator_tasks(task_id),
    owner_id TEXT NOT NULL,
    status TEXT NOT NULL
        CHECK (status IN (
            'queued',
            'running',
            'succeeded',
            'simulated',
            'failed',
            'cancelled'
        )),
    content_version INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    job_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_creator_render_jobs_task
ON haejumi_dev.creator_render_jobs(task_id);

CREATE TABLE IF NOT EXISTS haejumi_dev.creator_render_idempotency (
    request_key TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    job_id UUID NOT NULL
        REFERENCES haejumi_dev.creator_render_jobs(job_id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;