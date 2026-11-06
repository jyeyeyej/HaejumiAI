-- Creator relational integrity constraints
-- Apply through the approved migration workflow.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM haejumi_dev.creator_tasks t
    JOIN haejumi_dev.creator_projects p ON p.project_id = t.project_id
    WHERE t.owner_id <> p.owner_id
  ) OR EXISTS (
    SELECT 1
    FROM haejumi_dev.creator_approvals a
    JOIN haejumi_dev.creator_checkpoints c
      ON c.checkpoint_id = a.checkpoint_id
    WHERE a.task_id <> c.task_id
  ) OR EXISTS (
    SELECT 1
    FROM haejumi_dev.creator_render_jobs r
    JOIN haejumi_dev.creator_tasks t ON t.task_id = r.task_id
    WHERE r.owner_id <> t.owner_id
  ) OR EXISTS (
    SELECT 1
    FROM haejumi_dev.creator_publications p
    JOIN haejumi_dev.creator_tasks t ON t.task_id = p.task_id
    WHERE p.owner_id <> t.owner_id
  ) OR EXISTS (
    SELECT 1
    FROM haejumi_dev.creator_publication_approvals a
    JOIN haejumi_dev.creator_publications p
      ON p.publication_id = a.publication_id
    WHERE a.task_id <> p.task_id OR a.owner_id <> p.owner_id
  ) THEN
    RAISE EXCEPTION 'Existing Creator relationships violate integrity rules';
  END IF;
END $$;

ALTER TABLE haejumi_dev.creator_tasks
ADD CONSTRAINT creator_tasks_project_owner_fkey
FOREIGN KEY (project_id, owner_id)
REFERENCES haejumi_dev.creator_projects(project_id, owner_id);

ALTER TABLE haejumi_dev.creator_checkpoints
ADD CONSTRAINT creator_checkpoints_id_task_key
UNIQUE (checkpoint_id, task_id);

ALTER TABLE haejumi_dev.creator_approvals
ADD CONSTRAINT creator_approvals_checkpoint_task_fkey
FOREIGN KEY (checkpoint_id, task_id)
REFERENCES haejumi_dev.creator_checkpoints(checkpoint_id, task_id);

ALTER TABLE haejumi_dev.creator_tasks
ADD CONSTRAINT creator_tasks_id_owner_key
UNIQUE (task_id, owner_id);

ALTER TABLE haejumi_dev.creator_render_jobs
ADD CONSTRAINT creator_render_jobs_task_owner_fkey
FOREIGN KEY (task_id, owner_id)
REFERENCES haejumi_dev.creator_tasks(task_id, owner_id);

ALTER TABLE haejumi_dev.creator_publications
ADD CONSTRAINT creator_publications_task_owner_fkey
FOREIGN KEY (task_id, owner_id)
REFERENCES haejumi_dev.creator_tasks(task_id, owner_id);

ALTER TABLE haejumi_dev.creator_publications
ADD CONSTRAINT creator_publications_id_task_owner_key
UNIQUE (publication_id, task_id, owner_id);

ALTER TABLE haejumi_dev.creator_publication_approvals
ADD CONSTRAINT creator_publication_approvals_relation_fkey
FOREIGN KEY (publication_id, task_id, owner_id)
REFERENCES haejumi_dev.creator_publications(publication_id, task_id, owner_id);
