CREATE TABLE eval_runs (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  request_hash text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('fixture','configured')),
  judge boolean NOT NULL,
  suites jsonb NOT NULL CHECK (jsonb_typeof(suites) = 'array' AND octet_length(suites::text) <= 1200000),
  presets jsonb NOT NULL CHECK (jsonb_typeof(presets) = 'array'),
  limits jsonb NOT NULL,
  private_only boolean NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed','uncertain')),
  total_cases integer NOT NULL CHECK (total_cases BETWEEN 1 AND 128),
  completed_cases integer NOT NULL DEFAULT 0,
  passed_cases integer NOT NULL DEFAULT 0,
  cost_usd double precision NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  judge_cost_usd double precision NOT NULL DEFAULT 0 CHECK (judge_cost_usd >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  UNIQUE(user_id,request_id)
);
--> statement-breakpoint
CREATE INDEX eval_runs_owner_time_idx ON eval_runs(user_id,created_at);
--> statement-breakpoint
CREATE TABLE eval_results (
  id text PRIMARY KEY,
  eval_run_id text NOT NULL REFERENCES eval_runs(id) ON DELETE CASCADE,
  ordinal integer NOT NULL,
  suite text NOT NULL,
  preset text NOT NULL,
  case_id text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','uncertain')),
  checkpoint jsonb CHECK (octet_length(checkpoint::text) <= 600000),
  journal jsonb CHECK (octet_length(journal::text) <= 4000000),
  result jsonb CHECK (octet_length(result::text) <= 4000000),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(eval_run_id,ordinal),
  UNIQUE(eval_run_id,suite,preset,case_id)
);
