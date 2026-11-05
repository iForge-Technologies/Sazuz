ALTER TABLE runs ADD COLUMN workflow_node jsonb;
--> statement-breakpoint
CREATE TABLE workflows (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  active_revision integer,
  enabled boolean NOT NULL DEFAULT false,
  trigger_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE workflow_versions (
  workflow_id text NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision > 0),
  definition jsonb NOT NULL,
  sha256 text NOT NULL,
  reviewed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workflow_id, revision)
);
CREATE FUNCTION workflow_revision_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.definition IS DISTINCT FROM OLD.definition OR NEW.sha256 IS DISTINCT FROM OLD.sha256
    OR NEW.workflow_id <> OLD.workflow_id OR NEW.revision <> OLD.revision
    OR NEW.created_at <> OLD.created_at OR (OLD.reviewed AND NOT NEW.reviewed) THEN
    RAISE EXCEPTION 'Workflow revisions are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER workflow_revision_immutable BEFORE UPDATE ON workflow_versions FOR EACH ROW EXECUTE FUNCTION workflow_revision_immutable();
--> statement-breakpoint
CREATE TABLE workflow_runs (
  run_id text PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  workflow_id text NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  revision integer NOT NULL,
  snapshot jsonb NOT NULL,
  input_hash text NOT NULL,
  input jsonb NOT NULL,
  output jsonb,
  parent_node_id text,
  item_index integer NOT NULL DEFAULT 0 CHECK (item_index BETWEEN 0 AND 49),
  test boolean NOT NULL DEFAULT false,
  model_free boolean NOT NULL,
  tainted boolean NOT NULL DEFAULT true,
  private_only boolean NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workflow_id, revision) REFERENCES workflow_versions(workflow_id, revision)
);
CREATE UNIQUE INDEX workflow_run_item_idx ON workflow_runs(parent_node_id,item_index);
CREATE TABLE workflow_node_runs (
  id text PRIMARY KEY,
  workflow_run_id text NOT NULL REFERENCES workflow_runs(run_id) ON DELETE CASCADE,
  node_key text NOT NULL,
  attempt integer NOT NULL DEFAULT 1 CHECK (attempt BETWEEN 1 AND 3),
  run_id text UNIQUE REFERENCES runs(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending',
  input jsonb,
  output jsonb,
  branch text,
  reason text,
  tainted boolean NOT NULL DEFAULT false,
  private_only boolean NOT NULL DEFAULT false,
  pinned boolean NOT NULL DEFAULT false,
  started_at timestamptz,
  ready_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX workflow_node_attempt_idx ON workflow_node_runs(workflow_run_id,node_key,attempt);
CREATE TABLE workflow_events (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES workflow_runs(run_id) ON DELETE CASCADE,
  request_id text NOT NULL,
  name text NOT NULL,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX workflow_event_request_idx ON workflow_events(run_id,request_id);
--> statement-breakpoint
ALTER TABLE triggers ADD COLUMN workflow_id text REFERENCES workflows(id) ON DELETE CASCADE;
ALTER TABLE triggers ADD COLUMN workflow_revision integer;
ALTER TABLE recipe_installations ADD COLUMN workflow_id text REFERENCES workflows(id) ON DELETE SET NULL;
