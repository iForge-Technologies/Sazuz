ALTER TABLE notifications ADD COLUMN source_run_id text REFERENCES runs(id) ON DELETE SET NULL,
  ADD COLUMN signals jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN critical boolean NOT NULL DEFAULT false,
  ADD COLUMN priority_evidence jsonb,
  ADD COLUMN feedback text CHECK (feedback IN ('not_important','sooner')),
  ADD COLUMN classification_status text NOT NULL DEFAULT 'pending' CHECK (classification_status IN ('pending','running','done')),
  ADD COLUMN classification_claim uuid,
  ADD COLUMN classification_worker text,
  ADD COLUMN classification_at timestamptz,
  ADD COLUMN private_only boolean NOT NULL DEFAULT false;
ALTER TABLE digests ADD COLUMN notification_ids jsonb NOT NULL DEFAULT '[]';
--> statement-breakpoint
CREATE TABLE notification_interruptions (
  delivery_id text NOT NULL,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day text NOT NULL CHECK (day ~ '^\d{4}-\d{2}-\d{2}$'),
  slot integer NOT NULL CHECK (slot BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(delivery_id,day),
  UNIQUE(user_id,day,slot)
);
CREATE TABLE notification_feedback (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  notification_id text NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('not_important','sooner')),
  bias integer NOT NULL CHECK (bias BETWEEN -40 AND 40),
  settings_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,request_id)
);
