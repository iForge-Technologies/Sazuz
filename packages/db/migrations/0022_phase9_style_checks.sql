ALTER TABLE style_profiles
  ADD COLUMN project_id text REFERENCES projects(id) ON DELETE CASCADE,
  ADD COLUMN sources jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(sources) = 'array' AND jsonb_array_length(sources) <= 3);
--> statement-breakpoint
CREATE TABLE style_comparisons (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  input_hash text NOT NULL,
  task text NOT NULL CHECK (length(task) BETWEEN 20 AND 4000),
  skill_id text NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision > 0),
  sha256 text NOT NULL,
  private_only boolean NOT NULL,
  status text NOT NULL DEFAULT 'generating' CHECK (status IN ('generating','ready','voted','failed')),
  styled_label text NOT NULL CHECK (styled_label IN ('A','B')),
  generic_draft text CHECK (length(generic_draft) <= 6000),
  styled_draft text CHECK (length(styled_draft) <= 6000),
  vote text CHECK (vote IN ('A','B','tie')),
  error_code text,
  cost_usd double precision NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  voted_at timestamptz,
  UNIQUE(user_id,request_id),
  CHECK (status NOT IN ('ready','voted') OR (generic_draft IS NOT NULL AND styled_draft IS NOT NULL)),
  CHECK ((status = 'voted') = (vote IS NOT NULL AND voted_at IS NOT NULL)),
  FOREIGN KEY(skill_id,revision) REFERENCES skill_versions(skill_id,revision) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX style_comparison_project_idx ON style_comparisons(project_id,created_at);
