CREATE TABLE "agent_identities" (
	"agent_id" text PRIMARY KEY NOT NULL,
	"display" text NOT NULL,
	"connector_accounts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"version" integer NOT NULL,
	"definition" jsonb NOT NULL,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"current_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_agent_versions" (
	"run_id" text NOT NULL,
	"role" text NOT NULL,
	"revision_id" text NOT NULL,
	CONSTRAINT "run_agent_versions_run_id_role_pk" PRIMARY KEY("run_id","role")
);
--> statement-breakpoint
ALTER TABLE "agent_identities" ADD CONSTRAINT "agent_identities_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_versions" ADD CONSTRAINT "agent_versions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_agent_versions" ADD CONSTRAINT "run_agent_versions_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_agent_versions" ADD CONSTRAINT "run_agent_versions_revision_id_agent_versions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."agent_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_versions_revision_idx" ON "agent_versions" USING btree ("agent_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "agents_owner_role_idx" ON "agents" USING btree ("user_id","role");
