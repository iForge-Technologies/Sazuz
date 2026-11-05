CREATE TABLE "mcp_servers" (
  "id" text PRIMARY KEY, "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "current_version" integer NOT NULL DEFAULT 1, "enabled" boolean NOT NULL DEFAULT true,
  "warning" text, "created_at" timestamptz NOT NULL DEFAULT now(), "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "mcp_server_versions" (
  "id" text PRIMARY KEY, "server_id" text NOT NULL REFERENCES "mcp_servers"("id") ON DELETE CASCADE,
  "version" integer NOT NULL, "configuration" jsonb NOT NULL, "sha256" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(), UNIQUE ("server_id", "version")
);
--> statement-breakpoint
CREATE TABLE "run_mcp_selections" (
  "run_id" text PRIMARY KEY REFERENCES "runs"("id") ON DELETE CASCADE,
  "revision_ids" jsonb NOT NULL DEFAULT '[]'
);
--> statement-breakpoint
CREATE TABLE "mcp_calls" (
  "idempotency_key" text PRIMARY KEY, "run_id" text NOT NULL REFERENCES "runs"("id") ON DELETE CASCADE,
  "revision_id" text NOT NULL REFERENCES "mcp_server_versions"("id") ON DELETE CASCADE, "args_hash" text NOT NULL,
  "status" text NOT NULL DEFAULT 'started' CHECK ("status" IN ('started','done')),
  "result" jsonb, "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "mcp_clients" (
  "id" text PRIMARY KEY, "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "name" text NOT NULL, "secret_ref" text NOT NULL, "token_hash" text NOT NULL UNIQUE,
  "tools" jsonb NOT NULL, "allow_private" boolean NOT NULL DEFAULT false,
  "enabled" boolean NOT NULL DEFAULT true, "version" integer NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
