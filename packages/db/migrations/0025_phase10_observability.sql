CREATE TABLE cost_alerts (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id text REFERENCES projects(id) ON DELETE CASCADE,
  event_key text NOT NULL UNIQUE,
  period text NOT NULL CHECK (period IN ('day','month','project')),
  period_start timestamptz NOT NULL,
  cap_usd double precision NOT NULL CHECK (cap_usd >= 0),
  threshold integer NOT NULL CHECK (threshold BETWEEN 1 AND 100),
  spent_usd double precision NOT NULL CHECK (spent_usd >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE telemetry_exports (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ledger_id text NOT NULL UNIQUE REFERENCES cost_ledger(id) ON DELETE CASCADE,
  settings_version integer NOT NULL CHECK (settings_version > 0),
  status text NOT NULL CHECK (status IN ('intent','done','failed','uncertain','blocked')),
  code text CHECK (code IN ('collector_rejected','delivery_unknown','configuration_changed','policy_blocked','credential_unavailable')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX telemetry_exports_owner_time_idx ON telemetry_exports(user_id,created_at);
