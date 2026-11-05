ALTER TABLE run_steps ADD COLUMN replay_state jsonb;
--> statement-breakpoint
CREATE TABLE run_replays (
  run_id text PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_run_id text NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  source_step_id text NOT NULL REFERENCES run_steps(id) ON DELETE CASCADE,
  source_ordinal integer NOT NULL CHECK (source_ordinal >= 0),
  request_id text NOT NULL,
  request_hash text NOT NULL,
  model jsonb,
  skill jsonb,
  fixtures jsonb NOT NULL CHECK (jsonb_typeof(fixtures) = 'array' AND octet_length(fixtures::text) <= 1200000),
  private_only boolean NOT NULL,
  reconstructed boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,request_id)
);
--> statement-breakpoint
CREATE INDEX run_replay_source_idx ON run_replays(source_run_id);
