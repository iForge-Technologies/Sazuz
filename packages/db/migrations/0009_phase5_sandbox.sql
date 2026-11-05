CREATE TABLE "sandbox_executions" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"project_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"args_hash" text NOT NULL,
	"container_name" text NOT NULL,
	"language" text NOT NULL,
	"network" text NOT NULL,
	"status" text DEFAULT 'creating' NOT NULL,
	"result" jsonb,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sandbox_executions_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "sandbox_executions_container_name_unique" UNIQUE("container_name")
);
--> statement-breakpoint
ALTER TABLE "sandbox_executions" ADD CONSTRAINT "sandbox_executions_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sandbox_executions" ADD CONSTRAINT "sandbox_executions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;