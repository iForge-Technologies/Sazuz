ALTER TABLE workflow_runs ADD COLUMN inherited_authority boolean NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE TABLE workflow_drafts (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  input_hash text NOT NULL,
  status text NOT NULL DEFAULT 'generating' CHECK (status IN ('generating','ready','failed')),
  definition jsonb,
  private_only boolean NOT NULL,
  cost_usd double precision NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX workflow_draft_request_idx ON workflow_drafts(user_id,request_id);
CREATE TABLE workflow_invocations (
  call_key text PRIMARY KEY,
  caller_run_id text NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  run_id text NOT NULL REFERENCES workflow_runs(run_id) ON DELETE CASCADE,
  input_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
