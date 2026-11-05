CREATE TABLE "bridge_devices" (
  "id" text PRIMARY KEY, "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "name" text NOT NULL, "secret_ref" text NOT NULL, "token_hash" text NOT NULL UNIQUE,
  "version" integer NOT NULL DEFAULT 1, "enabled" boolean NOT NULL DEFAULT true,
  "offered_pin" text, "offered" jsonb, "connection_id" uuid, "last_seen_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "bridge_device_versions" (
  "id" text PRIMARY KEY, "device_id" text NOT NULL REFERENCES "bridge_devices"("id") ON DELETE CASCADE,
  "version" integer NOT NULL, "grant" jsonb, "enabled" boolean NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(), UNIQUE ("device_id", "version")
);
--> statement-breakpoint
CREATE TABLE "run_bridge_selections" (
  "run_id" text PRIMARY KEY REFERENCES "runs"("id") ON DELETE CASCADE, "revision_ids" jsonb NOT NULL DEFAULT '[]'
);
--> statement-breakpoint
CREATE TABLE "bridge_calls" (
  "idempotency_key" text PRIMARY KEY, "run_id" text NOT NULL REFERENCES "runs"("id") ON DELETE CASCADE,
  "revision_id" text NOT NULL REFERENCES "bridge_device_versions"("id") ON DELETE CASCADE,
  "args_hash" text NOT NULL, "status" text NOT NULL DEFAULT 'started' CHECK ("status" IN ('started','done')),
  "result" jsonb, "created_at" timestamptz NOT NULL DEFAULT now()
);
