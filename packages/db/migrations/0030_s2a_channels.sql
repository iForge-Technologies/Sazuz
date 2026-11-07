CREATE TABLE "channel_inbox" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"sender" text NOT NULL,
	"conversation" text NOT NULL,
	"mission_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_sessions" (
	"connection_id" text PRIMARY KEY NOT NULL,
	"secret_ref" text NOT NULL,
	"revision" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "s2a_executions" (
	"run_id" text PRIMARY KEY NOT NULL,
	"workflow_id" text NOT NULL,
	"revision" integer NOT NULL,
	"snapshot" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "s2a_revisions" (
	"workflow_id" text NOT NULL,
	"revision" integer NOT NULL,
	"graph" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "s2a_revisions_workflow_id_revision_pk" PRIMARY KEY("workflow_id","revision")
);
--> statement-breakpoint
CREATE TABLE "s2a_workflows" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"graph" jsonb NOT NULL,
	"revision" integer NOT NULL,
	"published_revision" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "channel_inbox" ADD CONSTRAINT "channel_inbox_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "s2a_executions" ADD CONSTRAINT "s2a_executions_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "s2a_executions" ADD CONSTRAINT "s2a_executions_workflow_id_s2a_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."s2a_workflows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "s2a_revisions" ADD CONSTRAINT "s2a_revisions_workflow_id_s2a_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."s2a_workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "s2a_workflows" ADD CONSTRAINT "s2a_workflows_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;