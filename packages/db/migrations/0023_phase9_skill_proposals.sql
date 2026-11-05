CREATE TABLE skill_proposals (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  family_key text NOT NULL,
  plan_signature text NOT NULL,
  fingerprint jsonb NOT NULL CHECK (octet_length(fingerprint::text) <= 100000),
  sources jsonb NOT NULL CHECK (jsonb_typeof(sources) = 'array' AND jsonb_array_length(sources) = 3),
  markdown text NOT NULL CHECK (length(markdown) BETWEEN 1 AND 24000),
  private_only boolean NOT NULL,
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','accepted','rejected')),
  decision_hash text,
  skill_id text REFERENCES skills(id) ON DELETE SET NULL,
  revision integer CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,project_id,family_key),
  CHECK ((status = 'proposed') = (decision_hash IS NULL))
);
--> statement-breakpoint
CREATE INDEX skill_proposal_project_idx ON skill_proposals(project_id,created_at);
--> statement-breakpoint
CREATE INDEX skill_proposal_skill_idx ON skill_proposals(skill_id);
