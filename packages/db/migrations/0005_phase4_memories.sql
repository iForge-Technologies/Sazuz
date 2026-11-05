CREATE TABLE "knowledge_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"event_key" text NOT NULL,
	"user_id" text NOT NULL,
	"project_id" text,
	"run_id" text,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"checkpoint" jsonb,
	"status" text DEFAULT 'queued' NOT NULL,
	"worker_id" text,
	"claim_key" text,
	"provider_id" text,
	"model_id" text,
	"step" integer DEFAULT 0 NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"max_cost_usd" double precision NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_jobs_event_key_unique" UNIQUE("event_key")
);
--> statement-breakpoint
CREATE TABLE "memories" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"project_id" text,
	"agent_id" text,
	"scope" text NOT NULL,
	"kind" text NOT NULL,
	"content" text NOT NULL,
	"importance" double precision DEFAULT 0.5 NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"sensitivity" text DEFAULT 'private' NOT NULL,
	"source_run_id" text,
	"source_message_id" text,
	"source_quote" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memories_scope_check" CHECK (("memories"."scope"='global' AND "memories"."project_id" IS NULL AND "memories"."agent_id" IS NULL) OR ("memories"."scope"='project' AND "memories"."project_id" IS NOT NULL AND "memories"."agent_id" IS NULL) OR ("memories"."scope"='agent' AND "memories"."project_id" IS NOT NULL AND "memories"."agent_id" IS NOT NULL)),
	CONSTRAINT "memories_status_check" CHECK ("memories"."status" IN ('proposed','accepted','rejected')),
	CONSTRAINT "memories_importance_check" CHECK ("memories"."importance" BETWEEN 0 AND 1)
);
--> statement-breakpoint
CREATE TABLE "memory_receipts" (
	"key" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"memory_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "run_steps" ADD COLUMN "prompt" text;--> statement-breakpoint
ALTER TABLE "knowledge_jobs" ADD CONSTRAINT "knowledge_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_jobs" ADD CONSTRAINT "knowledge_jobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_jobs" ADD CONSTRAINT "knowledge_jobs_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_source_run_id_runs_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_source_message_id_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_receipts" ADD CONSTRAINT "memory_receipts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "knowledge_jobs_status_idx" ON "knowledge_jobs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "memories_scope_idx" ON "memories" USING btree ("user_id","project_id","agent_id","status");