ALTER TABLE "secrets" DROP CONSTRAINT "secrets_purpose";
--> statement-breakpoint
ALTER TABLE "secrets" ADD CONSTRAINT "secrets_purpose" CHECK ("secrets"."purpose" IN ('user', 'authentication', 'browser-profiles'));
--> statement-breakpoint
CREATE TABLE "browser_actions" (
	"idempotency_key" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"args_hash" text NOT NULL,
	"operation" text NOT NULL,
	"status" text DEFAULT 'started' NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "browser_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"project_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"name" text NOT NULL,
	"site" text NOT NULL,
	"secret_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"vault_ref" text,
	"version" integer DEFAULT 1 NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"retired" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "browser_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"profile_id" text NOT NULL,
	"run_id" text NOT NULL,
	"project_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"profile_generation" integer NOT NULL,
	"service_id" text NOT NULL,
	"status" text DEFAULT 'opening' NOT NULL,
	"control" text DEFAULT 'agent' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"sensitive" boolean DEFAULT false NOT NULL,
	"challenge" text,
	"origin" text DEFAULT '' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "browser_actions" ADD CONSTRAINT "browser_actions_session_id_browser_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."browser_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_profiles" ADD CONSTRAINT "browser_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_profiles" ADD CONSTRAINT "browser_profiles_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_sessions" ADD CONSTRAINT "browser_sessions_profile_id_browser_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."browser_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_sessions" ADD CONSTRAINT "browser_sessions_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_sessions" ADD CONSTRAINT "browser_sessions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "browser_profile_active_idx" ON "browser_sessions" USING btree ("profile_id") WHERE "browser_sessions"."status" IN ('opening','active');
