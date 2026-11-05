CREATE TABLE learned_replays (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  skill_id text NOT NULL,
  revision integer NOT NULL,
  request_id uuid NOT NULL,
  input_hash text NOT NULL,
  inputs jsonb NOT NULL,
  mode text NOT NULL CHECK (mode IN ('rehearsal','live')),
  profile_id text REFERENCES browser_profiles(id) ON DELETE RESTRICT,
  run_id text UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
  evidence jsonb NOT NULL DEFAULT '[]',
  allow_repair boolean NOT NULL,
  private_only boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,request_id),
  FOREIGN KEY(skill_id,revision) REFERENCES learned_skill_versions(skill_id,revision) ON DELETE CASCADE,
  CHECK ((mode='live' AND profile_id IS NOT NULL AND run_id IS NOT NULL) OR (mode='rehearsal' AND run_id IS NULL))
);
--> statement-breakpoint
CREATE TABLE learned_repairs (
  id text PRIMARY KEY,
  replay_id text NOT NULL REFERENCES learned_replays(id) ON DELETE CASCADE,
  action_index integer NOT NULL CHECK (action_index BETWEEN 0 AND 199),
  step_id text NOT NULL,
  status text NOT NULL DEFAULT 'generating' CHECK (status IN ('generating','proposed','failed','accepted','rejected')),
  target jsonb,
  reason text,
  cost_usd double precision NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  accepted_revision integer,
  decision_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(replay_id,action_index)
);
