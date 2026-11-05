CREATE TABLE "audit_reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"source_key" text NOT NULL,
	"kind" text NOT NULL,
	"subject_hash" text NOT NULL,
	"binding_hash" text NOT NULL,
	"request" jsonb NOT NULL,
	"evidence" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"verdict" jsonb,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "audit_reviews_attempts" CHECK ("audit_reviews"."attempts" BETWEEN 0 AND 2),
	CONSTRAINT "audit_reviews_status" CHECK ("audit_reviews"."status" IN ('pending','accepted','rejected'))
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "review_mode" text DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "review_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "review_steps" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_reviews" ADD CONSTRAINT "audit_reviews_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "audit_reviews_binding_idx" ON "audit_reviews" USING btree ("run_id","source_key","binding_hash","expires_at");
--> statement-breakpoint
CREATE FUNCTION sazuz_immutable_review() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'pending' OR
     (NEW.id, NEW.run_id, NEW.source_key, NEW.kind, NEW.subject_hash, NEW.binding_hash, NEW.request, NEW.evidence, NEW.created_at, NEW.expires_at)
       IS DISTINCT FROM
     (OLD.id, OLD.run_id, OLD.source_key, OLD.kind, OLD.subject_hash, OLD.binding_hash, OLD.request, OLD.evidence, OLD.created_at, OLD.expires_at) THEN
    RAISE EXCEPTION 'Review evidence and completed verdicts are immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_reviews_immutable BEFORE UPDATE ON audit_reviews FOR EACH ROW EXECUTE FUNCTION sazuz_immutable_review();
