CREATE TABLE operations (
  id text PRIMARY KEY CHECK (id ~ '^op_[0-9A-HJKMNP-TV-Z]{26}$'),
  kind text NOT NULL CHECK (kind IN ('backup','restore','update')),
  request_key text NOT NULL CHECK (length(request_key) BETWEEN 1 AND 160),
  input_hash text NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  user_id text REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('queued','running','uploading','ready','done','failed','interrupted')),
  stage text NOT NULL DEFAULT 'reserved',
  code text,
  metadata jsonb NOT NULL DEFAULT '{}',
  bytes integer NOT NULL DEFAULT 0 CHECK (bytes BETWEEN 0 AND 134283264),
  received_bytes integer NOT NULL DEFAULT 0 CHECK (received_bytes BETWEEN 0 AND bytes),
  sha256 text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE(kind,request_key)
);
CREATE TABLE backups (
  id text PRIMARY KEY CHECK (id ~ '^bak_[0-9A-HJKMNP-TV-Z]{26}$'),
  operation_id text NOT NULL UNIQUE REFERENCES operations(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('manual','scheduled','pre-update')),
  status text NOT NULL CHECK (status IN ('ready','deleting','deleted','unavailable')),
  bytes integer NOT NULL CHECK (bytes BETWEEN 1 AND 134283264),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE operation_gate (
  id text PRIMARY KEY DEFAULT 'singleton' CHECK (id='singleton'),
  operation_id text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO operation_gate(id) VALUES ('singleton');
CREATE INDEX operations_created_idx ON operations(created_at DESC);
CREATE INDEX backups_created_idx ON backups(created_at DESC);
