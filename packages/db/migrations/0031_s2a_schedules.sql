CREATE TABLE "s2a_schedules" (
	"workflow_id" text PRIMARY KEY NOT NULL,
	"version" integer NOT NULL,
	"expression" text NOT NULL,
	"timezone" text NOT NULL,
	"enabled" boolean NOT NULL,
	"input" jsonb NOT NULL,
	"next_run_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "s2a_executions" DROP CONSTRAINT "s2a_executions_workflow_id_s2a_workflows_id_fk";
--> statement-breakpoint
ALTER TABLE "s2a_schedules" ADD CONSTRAINT "s2a_schedules_workflow_id_s2a_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."s2a_workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "s2a_executions" ADD CONSTRAINT "s2a_executions_workflow_id_s2a_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."s2a_workflows"("id") ON DELETE cascade ON UPDATE no action;