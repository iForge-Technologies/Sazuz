CREATE TABLE "skill_selections" (
	"key" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"skill_id" text NOT NULL,
	"revision" integer NOT NULL,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_versions" (
	"skill_id" text NOT NULL,
	"revision" integer NOT NULL,
	"manifest" jsonb NOT NULL,
	"markdown" text NOT NULL,
	"sha256" text NOT NULL,
	"private_only" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_versions_skill_id_revision_pk" PRIMARY KEY("skill_id","revision")
);
--> statement-breakpoint
CREATE TABLE "skills" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"source" text NOT NULL,
	"revision" integer NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"private_only" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "style_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"request_id" text NOT NULL,
	"input_hash" text NOT NULL,
	"status" text DEFAULT 'generating' NOT NULL,
	"private_only" boolean NOT NULL,
	"markdown" text,
	"sample_draft" text,
	"error_code" text,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"skill_id" text,
	"revision" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "skill_selections" ADD CONSTRAINT "skill_selections_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_selections" ADD CONSTRAINT "skill_selections_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_versions" ADD CONSTRAINT "skill_versions_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "style_profiles" ADD CONSTRAINT "style_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "style_profiles" ADD CONSTRAINT "style_profiles_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "skills_owner_name_idx" ON "skills" USING btree ("user_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "skills_builtin_name_idx" ON "skills" USING btree ("name") WHERE "skills"."user_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "style_profile_request_idx" ON "style_profiles" USING btree ("user_id","request_id");