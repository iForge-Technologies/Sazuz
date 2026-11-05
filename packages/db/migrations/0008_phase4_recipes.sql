CREATE TABLE "recipe_installations" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"project_id" text NOT NULL,
	"request_id" text NOT NULL,
	"input_hash" text NOT NULL,
	"preview" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"installed_at" timestamp with time zone,
	"mission_id" text,
	"trigger_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "recipe_policy" text;--> statement-breakpoint
ALTER TABLE "triggers" ADD COLUMN "recipe_policy" text;--> statement-breakpoint
ALTER TABLE "recipe_installations" ADD CONSTRAINT "recipe_installations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_installations" ADD CONSTRAINT "recipe_installations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_installations" ADD CONSTRAINT "recipe_installations_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipe_installations" ADD CONSTRAINT "recipe_installations_trigger_id_triggers_id_fk" FOREIGN KEY ("trigger_id") REFERENCES "public"."triggers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "recipe_installation_request_idx" ON "recipe_installations" USING btree ("user_id","request_id");