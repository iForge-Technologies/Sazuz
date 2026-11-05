CREATE TABLE browser_recordings (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_id text NOT NULL REFERENCES browser_sessions(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  input_hash text NOT NULL,
  name text NOT NULL,
  site text NOT NULL,
  status text NOT NULL DEFAULT 'recording' CHECK (status IN ('recording','stopped','interrupted')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  events jsonb NOT NULL DEFAULT '[]',
  omitted integer NOT NULL DEFAULT 0 CHECK (omitted >= 0),
  private_only boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, request_id),
  CHECK (jsonb_typeof(events) = 'array' AND jsonb_array_length(events) <= 100)
);
CREATE UNIQUE INDEX browser_recording_active_idx ON browser_recordings(session_id) WHERE status = 'recording';
--> statement-breakpoint
CREATE TABLE learning_drafts (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  recording_id text NOT NULL REFERENCES browser_recordings(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  input_hash text NOT NULL,
  status text NOT NULL DEFAULT 'generating' CHECK (status IN ('generating','ready','failed','saved')),
  name text NOT NULL,
  description text,
  program jsonb,
  markdown text,
  script text,
  private_only boolean NOT NULL,
  cost_usd double precision NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  error_code text,
  saved_hash text,
  skill_id text REFERENCES skills(id) ON DELETE SET NULL,
  revision integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, request_id)
);
--> statement-breakpoint
CREATE TABLE learned_skill_versions (
  skill_id text NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  revision integer NOT NULL,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  recording_id text REFERENCES browser_recordings(id) ON DELETE SET NULL,
  program jsonb NOT NULL,
  program_hash text NOT NULL,
  script text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(skill_id, revision),
  FOREIGN KEY(skill_id, revision) REFERENCES skill_versions(skill_id, revision) ON DELETE CASCADE
);
