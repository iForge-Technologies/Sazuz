CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE "worker_heartbeats" (
	"id" text PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "worker_heartbeats_id_format" CHECK ("worker_heartbeats"."id" ~ '^wrk_[0-9A-HJKMNP-TV-Z]{26}$')
);
--> statement-breakpoint
CREATE INDEX "worker_heartbeats_last_seen_idx" ON "worker_heartbeats" USING btree ("last_seen_at");
