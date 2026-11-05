ALTER TABLE secrets DROP CONSTRAINT secrets_purpose;
ALTER TABLE secrets ADD CONSTRAINT secrets_purpose CHECK (purpose IN ('user','authentication','browser-profiles','web-push'));
--> statement-breakpoint
CREATE TABLE speech_receipts (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('transcribe','speak')),
  input_hash text NOT NULL,
  provider_id text NOT NULL,
  model_id text NOT NULL,
  settings_version integer NOT NULL,
  private_only boolean NOT NULL,
  ledger_id text NOT NULL REFERENCES cost_ledger(id) ON DELETE CASCADE,
  cost_usd double precision NOT NULL CHECK (cost_usd >= 0),
  status text NOT NULL DEFAULT 'intent' CHECK (status IN ('intent','done','uncertain')),
  transcript text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE(user_id, request_id)
);
--> statement-breakpoint
CREATE TABLE push_devices (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  endpoint_hash text NOT NULL UNIQUE,
  secret_ref text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
--> statement-breakpoint
CREATE TABLE push_deliveries (
  id text PRIMARY KEY,
  device_id text NOT NULL REFERENCES push_devices(id) ON DELETE CASCADE,
  event_key text NOT NULL,
  status text NOT NULL DEFAULT 'intent' CHECK (status IN ('intent','done','uncertain','skipped')),
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE(device_id, event_key)
);
