CREATE TABLE "blackboard_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"mission_id" text NOT NULL,
	"run_id" text,
	"agent_id" text NOT NULL,
	"event_key" text NOT NULL,
	"text" text NOT NULL,
	"artifacts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tainted" boolean DEFAULT true NOT NULL,
	"private_only" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "graph_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"mission_id" text NOT NULL,
	"revision" integer NOT NULL,
	"definition" jsonb NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mission_graphs" (
	"mission_id" text PRIMARY KEY NOT NULL,
	"root_run_id" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"definition" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mission_graphs_root_run_id_unique" UNIQUE("root_run_id")
);
--> statement-breakpoint
CREATE TABLE "mission_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"mission_id" text NOT NULL,
	"task_key" text NOT NULL,
	"definition" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"run_id" text,
	"feedback" text,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_buckets" (
	"provider_id" text PRIMARY KEY NOT NULL,
	"tokens" double precision NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"run_id" text NOT NULL,
	"attempt" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_attempts_run_id_unique" UNIQUE("run_id")
);
--> statement-breakpoint
ALTER TABLE "runs" DROP CONSTRAINT "runs_mission_id_unique";--> statement-breakpoint
ALTER TABLE "agent_messages" ADD COLUMN "task_id" text;--> statement-breakpoint
ALTER TABLE "agent_messages" ADD COLUMN "payload" jsonb;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "parent_run_id" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "assignment" jsonb;--> statement-breakpoint
ALTER TABLE "blackboard_entries" ADD CONSTRAINT "blackboard_entries_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blackboard_entries" ADD CONSTRAINT "blackboard_entries_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_revisions" ADD CONSTRAINT "graph_revisions_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_graphs" ADD CONSTRAINT "mission_graphs_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_graphs" ADD CONSTRAINT "mission_graphs_root_run_id_runs_id_fk" FOREIGN KEY ("root_run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_tasks" ADD CONSTRAINT "mission_tasks_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_tasks" ADD CONSTRAINT "mission_tasks_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_attempts" ADD CONSTRAINT "task_attempts_task_id_mission_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."mission_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_attempts" ADD CONSTRAINT "task_attempts_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "blackboard_event_idx" ON "blackboard_entries" USING btree ("mission_id","event_key");--> statement-breakpoint
CREATE UNIQUE INDEX "graph_revisions_version_idx" ON "graph_revisions" USING btree ("mission_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "mission_tasks_key_idx" ON "mission_tasks" USING btree ("mission_id","task_key");--> statement-breakpoint
CREATE UNIQUE INDEX "task_attempts_number_idx" ON "task_attempts" USING btree ("task_id","attempt");--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_parent_run_id_runs_id_fk" FOREIGN KEY ("parent_run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "runs_root_mission_idx" ON "runs" USING btree ("mission_id") WHERE "runs"."parent_run_id" IS NULL;--> statement-breakpoint
CREATE INDEX "runs_parent_idx" ON "runs" USING btree ("parent_run_id");