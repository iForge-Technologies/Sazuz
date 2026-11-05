CREATE TABLE "embedding_generations" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"provider_id" text NOT NULL,
	"model_id" text NOT NULL,
	"provider_url" text NOT NULL,
	"status" text DEFAULT 'building' NOT NULL,
	"dimensions" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kb_chunks" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"document_id" text NOT NULL,
	"project_id" text NOT NULL,
	"text" text NOT NULL,
	"locator" text NOT NULL,
	"ordinal" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kb_documents" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"locator" text NOT NULL,
	"text" text NOT NULL,
	"ordinal" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kb_embeddings" (
	"chunk_id" text NOT NULL,
	"generation_id" text NOT NULL,
	"embedding_model" text NOT NULL,
	"vector" vector NOT NULL,
	CONSTRAINT "kb_embeddings_generation_id_chunk_id_pk" PRIMARY KEY("generation_id","chunk_id")
);
--> statement-breakpoint
CREATE TABLE "kb_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"project_id" text NOT NULL,
	"request_id" text NOT NULL,
	"content_hash" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"url" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_embeddings" (
	"memory_id" text NOT NULL,
	"generation_id" text NOT NULL,
	"memory_version" integer NOT NULL,
	"embedding_model" text NOT NULL,
	"vector" vector NOT NULL,
	CONSTRAINT "memory_embeddings_generation_id_memory_id_pk" PRIMARY KEY("generation_id","memory_id")
);
--> statement-breakpoint
ALTER TABLE "knowledge_jobs" ADD COLUMN "source_id" text;--> statement-breakpoint
ALTER TABLE "embedding_generations" ADD CONSTRAINT "embedding_generations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_chunks" ADD CONSTRAINT "kb_chunks_source_id_kb_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."kb_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_chunks" ADD CONSTRAINT "kb_chunks_document_id_kb_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."kb_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_chunks" ADD CONSTRAINT "kb_chunks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_documents" ADD CONSTRAINT "kb_documents_source_id_kb_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."kb_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_embeddings" ADD CONSTRAINT "kb_embeddings_chunk_id_kb_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."kb_chunks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_embeddings" ADD CONSTRAINT "kb_embeddings_generation_id_embedding_generations_id_fk" FOREIGN KEY ("generation_id") REFERENCES "public"."embedding_generations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_sources" ADD CONSTRAINT "kb_sources_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_sources" ADD CONSTRAINT "kb_sources_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_embeddings" ADD CONSTRAINT "memory_embeddings_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_embeddings" ADD CONSTRAINT "memory_embeddings_generation_id_embedding_generations_id_fk" FOREIGN KEY ("generation_id") REFERENCES "public"."embedding_generations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "embedding_generation_fingerprint_idx" ON "embedding_generations" USING btree ("project_id","fingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX "embedding_generation_active_idx" ON "embedding_generations" USING btree ("project_id") WHERE "embedding_generations"."status"='active';--> statement-breakpoint
CREATE UNIQUE INDEX "kb_chunks_source_idx" ON "kb_chunks" USING btree ("source_id","ordinal");--> statement-breakpoint
CREATE INDEX "kb_chunks_fts_idx" ON "kb_chunks" USING gin (to_tsvector('simple', "text"));--> statement-breakpoint
CREATE UNIQUE INDEX "kb_documents_source_idx" ON "kb_documents" USING btree ("source_id","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "kb_sources_request_idx" ON "kb_sources" USING btree ("user_id","request_id");--> statement-breakpoint
ALTER TABLE "knowledge_jobs" ADD CONSTRAINT "knowledge_jobs_source_id_kb_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."kb_sources"("id") ON DELETE cascade ON UPDATE no action;