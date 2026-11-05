--
-- PostgreSQL database dump
--

\restrict SKo26c3t7LqbAw2vPOh0gKvNHQ35w9TopMjtTCWNV5nXnEYHbqnxOdR8K56hwhE

-- Dumped from database version 16.15
-- Dumped by pg_dump version 16.15

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: haejumi_dev; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA haejumi_dev;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: creator_approval_idempotency; Type: TABLE; Schema: haejumi_dev; Owner: -
--

CREATE TABLE haejumi_dev.creator_approval_idempotency (
    request_key text NOT NULL,
    owner_id text NOT NULL,
    fingerprint text NOT NULL,
    approval_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: creator_approvals; Type: TABLE; Schema: haejumi_dev; Owner: -
--

CREATE TABLE haejumi_dev.creator_approvals (
    approval_id uuid NOT NULL,
    task_id uuid NOT NULL,
    checkpoint_id uuid NOT NULL,
    content_version integer NOT NULL,
    content_hash text NOT NULL,
    approval_scope text NOT NULL,
    status text NOT NULL,
    approval_hash text NOT NULL,
    approved_at timestamp with time zone NOT NULL,
    approval_data jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: creator_checkpoints; Type: TABLE; Schema: haejumi_dev; Owner: -
--

CREATE TABLE haejumi_dev.creator_checkpoints (
    checkpoint_id uuid NOT NULL,
    task_id uuid NOT NULL,
    owner_id text NOT NULL,
    kind text NOT NULL,
    status text NOT NULL,
    content_version integer NOT NULL,
    content_hash text,
    checkpoint_data jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: creator_idempotency; Type: TABLE; Schema: haejumi_dev; Owner: -
--

CREATE TABLE haejumi_dev.creator_idempotency (
    request_key text NOT NULL,
    owner_id text NOT NULL,
    fingerprint text NOT NULL,
    project_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: creator_projects; Type: TABLE; Schema: haejumi_dev; Owner: -
--

CREATE TABLE haejumi_dev.creator_projects (
    project_id uuid NOT NULL,
    owner_id text NOT NULL,
    task_id uuid NOT NULL,
    status text DEFAULT 'created'::text NOT NULL,
    current_version integer DEFAULT 1 NOT NULL,
    content_hash text,
    project_data jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: creator_publication_approvals; Type: TABLE; Schema: haejumi_dev; Owner: -
--

CREATE TABLE haejumi_dev.creator_publication_approvals (
    approval_id uuid NOT NULL,
    publication_id uuid NOT NULL,
    task_id uuid NOT NULL,
    owner_id text NOT NULL,
    content_version integer NOT NULL,
    content_hash text NOT NULL,
    artifact_sha256 text NOT NULL,
    publication_revision integer NOT NULL,
    publication_hash text NOT NULL,
    approval_hash text NOT NULL,
    status text NOT NULL,
    approval_data jsonb DEFAULT '{}'::jsonb NOT NULL,
    approved_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT creator_publication_approvals_status_check CHECK ((status = ANY (ARRAY['active'::text, 'invalidated'::text])))
);


--
-- Name: creator_publication_idempotency; Type: TABLE; Schema: haejumi_dev; Owner: -
--

CREATE TABLE haejumi_dev.creator_publication_idempotency (
    request_key text NOT NULL,
    owner_id text NOT NULL,
    fingerprint text NOT NULL,
    resource_type text NOT NULL,
    resource_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: creator_publications; Type: TABLE; Schema: haejumi_dev; Owner: -
--

CREATE TABLE haejumi_dev.creator_publications (
    publication_id uuid NOT NULL,
    task_id uuid NOT NULL,
    owner_id text NOT NULL,
    platform text NOT NULL,
    revision integer DEFAULT 1 NOT NULL,
    metadata_hash text NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    publication_data jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT creator_publications_platform_check CHECK ((platform = ANY (ARRAY['youtube'::text, 'instagram'::text, 'tiktok'::text]))),
    CONSTRAINT creator_publications_revision_check CHECK ((revision >= 1)),
    CONSTRAINT creator_publications_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'publish_ready'::text])))
);


--
-- Name: creator_render_idempotency; Type: TABLE; Schema: haejumi_dev; Owner: -
--

CREATE TABLE haejumi_dev.creator_render_idempotency (
    request_key text NOT NULL,
    owner_id text NOT NULL,
    fingerprint text NOT NULL,
    job_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: creator_render_jobs; Type: TABLE; Schema: haejumi_dev; Owner: -
--

CREATE TABLE haejumi_dev.creator_render_jobs (
    job_id uuid NOT NULL,
    task_id uuid NOT NULL,
    owner_id text NOT NULL,
    status text NOT NULL,
    content_version integer NOT NULL,
    content_hash text NOT NULL,
    job_data jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT creator_render_jobs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'succeeded'::text, 'simulated'::text, 'failed'::text, 'cancelled'::text])))
);


--
-- Name: creator_tasks; Type: TABLE; Schema: haejumi_dev; Owner: -
--

CREATE TABLE haejumi_dev.creator_tasks (
    task_id uuid NOT NULL,
    project_id uuid NOT NULL,
    owner_id text NOT NULL,
    status text NOT NULL,
    current_version integer DEFAULT 1 NOT NULL,
    content_hash text,
    task_data jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: creator_approval_idempotency creator_approval_idempotency_pkey; Type: CONSTRAINT; Schema: haejumi_dev; Owner: -
--

ALTER TABLE ONLY haejumi_dev.creator_approval_idempotency
    ADD CONSTRAINT creator_approval_idempotency_pkey PRIMARY KEY (request_key);


--
-- Name: creator_approvals creator_approvals_checkpoint_id_key; Type: CONSTRAINT; Schema: haejumi_dev; Owner: -
--

ALTER TABLE ONLY haejumi_dev.creator_approvals
    ADD CONSTRAINT creator_approvals_checkpoint_id_key UNIQUE (checkpoint_id);


--
-- Name: creator_approvals creator_approvals_pkey; Type: CONSTRAINT; Schema: haejumi_dev; Owner: -
--

ALTER TABLE ONLY haejumi_dev.creator_approvals
    ADD CONSTRAINT creator_approvals_pkey PRIMARY KEY (approval_id);


--
-- Name: creator_checkpoints creator_checkpoints_pkey; Type: CONSTRAINT; Schema: haejumi_dev; Owner: -
--

ALTER TABLE ONLY haejumi_dev.creator_checkpoints
    ADD CONSTRAINT creator_checkpoints_pkey PRIMARY KEY (checkpoint_id);


--
-- Name: creator_idempotency creator_idempotency_pkey; Type: CONSTRAINT; Schema: haejumi_dev; Owner: -
--

ALTER TABLE ONLY haejumi_dev.creator_idempotency
    ADD CONSTRAINT creator_idempotency_pkey PRIMARY KEY (request_key);


--
-- Name: creator_projects creator_projects_pkey; Type: CONSTRAINT; Schema: haejumi_dev; Owner: -
--

ALTER TABLE ONLY haejumi_dev.creator_projects
    ADD CONSTRAINT creator_projects_pkey PRIMARY KEY (project_id);


--
-- Name: creator_projects creator_projects_task_id_key; Type: CONSTRAINT; Schema: haejumi_dev; Owner: -
--

ALTER TABLE ONLY haejumi_dev.creator_projects
    ADD CONSTRAINT creator_projects_task_id_key UNIQUE (task_id);


--
-- Name: creator_publication_approvals creator_publication_approvals_pkey; Type: CONSTRAINT; Schema: haejumi_dev; Owner: -
--

ALTER TABLE ONLY haejumi_dev.creator_publication_approvals
    ADD CONSTRAINT creator_publication_approvals_pkey PRIMARY KEY (approval_id);


--
-- Name: creator_publication_idempotency creator_publication_idempotency_pkey; Type: CONSTRAINT; Schema: haejumi_dev; Owner: -
--

ALTER TABLE ONLY haejumi_dev.creator_publication_idempotency
    ADD CONSTRAINT creator_publication_idempotency_pkey PRIMARY KEY (request_key);


--
-- Name: creator_publications creator_publications_pkey; Type: CONSTRAINT; Schema: haejumi_dev; Owner: -
--

ALTER TABLE ONLY haejumi_dev.creator_publications
    ADD CONSTRAINT creator_publications_pkey PRIMARY KEY (publication_id);


--
-- Name: creator_publications creator_publications_task_id_platform_key; Type: CONSTRAINT; Schema: haejumi_dev; Owner: -
--

ALTER TABLE ONLY haejumi_dev.creator_publications
    ADD CONSTRAINT creator_publications_task_id_platform_key UNIQUE (task_id, platform);


--
-- Name: creator_render_idempotency creator_render_idempotency_pkey; Type: CONSTRAINT; Schema: haejumi_dev; Owner: -
--

ALTER TABLE ONLY haejumi_dev.creator_render_idempotency
    ADD CONSTRAINT creator_render_idempotency_pkey PRIMARY KEY (request_key);


--
-- Name: creator_render_jobs creator_render_jobs_pkey; Type: CONSTRAINT; Schema: haejumi_dev; Owner: -
--

ALTER TABLE ONLY haejumi_dev.creator_render_jobs
    ADD CONSTRAINT creator_render_jobs_pkey PRIMARY KEY (job_id);


--
-- Name: creator_tasks creator_tasks_pkey; Type: CONSTRAINT; Schema: haejumi_dev; Owner: -
--

ALTER TABLE ONLY haejumi_dev.creator_tasks
    ADD CONSTRAINT creator_tasks_pkey PRIMARY KEY (task_id);


--
-- Name: creator_tasks creator_tasks_project_id_key; Type: CONSTRAINT; Schema: haejumi_dev; Owner: -
--

ALTER TABLE ONLY haejumi_dev.creator_tasks
    ADD CONSTRAINT creator_tasks_project_id_key UNIQUE (project_id);


--
-- Name: idx_creator_checkpoints_task; Type: INDEX; Schema: haejumi_dev; Owner: -
--

CREATE INDEX idx_creator_checkpoints_task ON haejumi_dev.creator_checkpoints USING btree (task_id);


--
-- Name: idx_creator_projects_owner; Type: INDEX; Schema: haejumi_dev; Owner: -
--

CREATE INDEX idx_creator_projects_owner ON haejumi_dev.creator_projects USING btree (owner_id);


--
-- Name: idx_creator_publication_active_approval; Type: INDEX; Schema: haejumi_dev; Owner: -
--

CREATE UNIQUE INDEX idx_creator_publication_active_approval ON haejumi_dev.creator_publication_approvals USING btree (publication_id) WHERE (status = 'active'::text);


--
-- Name: idx_creator_render_jobs_task; Type: INDEX; Schema: haejumi_dev; Owner: -
--

CREATE INDEX idx_creator_render_jobs_task ON haejumi_dev.creator_render_jobs USING btree (task_id);


--
-- Name: idx_creator_tasks_owner; Type: INDEX; Schema: haejumi_dev; Owner: -
--

CREATE INDEX idx_creator_tasks_owner ON haejumi_dev.creator_tasks USING btree (owner_id);


--
-- Name: uq_creator_projects_owner_id; Type: INDEX; Schema: haejumi_dev; Owner: -
--

CREATE UNIQUE INDEX uq_creator_projects_owner_id ON haejumi_dev.creator_projects USING btree (project_id, owner_id);


--
-- Name: creator_approval_idempotency creator_approval_idempotency_approval_id_fkey; Type: FK CONSTRAINT; Schema: haejumi_dev; Owner: -
--

ALTER TABLE ONLY haejumi_dev.creator_approval_idempotency
    ADD CONSTRAINT creator_approval_idempotency_approval_id_fkey FOREIGN KEY (approval_id) REFERENCES haejumi_dev.creator_approvals(approval_id);


--
-- Name: creator_approvals creator_approvals_checkpoint_id_fkey; Type: FK CONSTRAINT; Schema: haejumi_dev; Owner: -
--

ALTER TABLE ONLY haejumi_dev.creator_approvals
    ADD CONSTRAINT creator_approvals_checkpoint_id_fkey FOREIGN KEY (checkpoint_id) REFERENCES haejumi_dev.creator_checkpoints(checkpoint_id);


--
-- Name: creator_approvals creator_approvals_task_id_fkey; Type: FK CONSTRAINT; Schema: haejumi_dev; Owner: -
--

ALTER TABLE ONLY haejumi_dev.creator_approvals
    ADD CONSTRAINT creator_approvals_task_id_fkey FOREIGN KEY (task_id) REFERENCES haejumi_dev.creator_tasks(task_id);


--
-- Name: creator_checkpoints creator_checkpoints_task_id_fkey; Type: FK CONSTRAINT; Schema: haejumi_dev; Owner: -
--

ALTER TABLE ONLY haejumi_dev.creator_checkpoints
    ADD CONSTRAINT creator_checkpoints_task_id_fkey FOREIGN KEY (task_id) REFERENCES haejumi_dev.creator_tasks(task_id);


--
-- Name: creator_idempotency creator_idempotency_owner_fk; Type: FK CONSTRAINT; Schema: haejumi_dev; Owner: -
--

ALTER TABLE ONLY haejumi_dev.creator_idempotency
    ADD CONSTRAINT creator_idempotency_owner_fk FOREIGN KEY (project_id, owner_id) REFERENCES haejumi_dev.creator_projects(project_id, owner_id);


--
-- Name: creator_idempotency creator_idempotency_project_id_fkey; Type: FK CONSTRAINT; Schema: haejumi_dev; Owner: -
--

ALTER TABLE ONLY haejumi_dev.creator_idempotency
    ADD CONSTRAINT creator_idempotency_project_id_fkey FOREIGN KEY (project_id) REFERENCES haejumi_dev.creator_projects(project_id);


--
-- Name: creator_publication_approvals creator_publication_approvals_publication_id_fkey; Type: FK CONSTRAINT; Schema: haejumi_dev; Owner: -
--

ALTER TABLE ONLY haejumi_dev.creator_publication_approvals
    ADD CONSTRAINT creator_publication_approvals_publication_id_fkey FOREIGN KEY (publication_id) REFERENCES haejumi_dev.creator_publications(publication_id);


--
-- Name: creator_publication_approvals creator_publication_approvals_task_id_fkey; Type: FK CONSTRAINT; Schema: haejumi_dev; Owner: -
--

ALTER TABLE ONLY haejumi_dev.creator_publication_approvals
    ADD CONSTRAINT creator_publication_approvals_task_id_fkey FOREIGN KEY (task_id) REFERENCES haejumi_dev.creator_tasks(task_id);


--
-- Name: creator_publications creator_publications_task_id_fkey; Type: FK CONSTRAINT; Schema: haejumi_dev; Owner: -
--

ALTER TABLE ONLY haejumi_dev.creator_publications
    ADD CONSTRAINT creator_publications_task_id_fkey FOREIGN KEY (task_id) REFERENCES haejumi_dev.creator_tasks(task_id);


--
-- Name: creator_render_idempotency creator_render_idempotency_job_id_fkey; Type: FK CONSTRAINT; Schema: haejumi_dev; Owner: -
--

ALTER TABLE ONLY haejumi_dev.creator_render_idempotency
    ADD CONSTRAINT creator_render_idempotency_job_id_fkey FOREIGN KEY (job_id) REFERENCES haejumi_dev.creator_render_jobs(job_id);


--
-- Name: creator_render_jobs creator_render_jobs_task_id_fkey; Type: FK CONSTRAINT; Schema: haejumi_dev; Owner: -
--

ALTER TABLE ONLY haejumi_dev.creator_render_jobs
    ADD CONSTRAINT creator_render_jobs_task_id_fkey FOREIGN KEY (task_id) REFERENCES haejumi_dev.creator_tasks(task_id);


--
-- Name: creator_tasks creator_tasks_project_id_fkey; Type: FK CONSTRAINT; Schema: haejumi_dev; Owner: -
--

ALTER TABLE ONLY haejumi_dev.creator_tasks
    ADD CONSTRAINT creator_tasks_project_id_fkey FOREIGN KEY (project_id) REFERENCES haejumi_dev.creator_projects(project_id);


--
-- PostgreSQL database dump complete
--

\unrestrict SKo26c3t7LqbAw2vPOh0gKvNHQ35w9TopMjtTCWNV5nXnEYHbqnxOdR8K56hwhE

