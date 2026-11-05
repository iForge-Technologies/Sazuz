ALTER TABLE "oauth_states" ADD COLUMN "provider" text NOT NULL DEFAULT 'google';
--> statement-breakpoint
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_provider_known" CHECK ("provider" IN ('google', 'microsoft'));
--> statement-breakpoint
ALTER TABLE "run_agent_versions" ADD COLUMN "connector_bindings" jsonb NOT NULL DEFAULT '{}';
--> statement-breakpoint
UPDATE "run_agent_versions" SET "connector_bindings" = COALESCE((
  SELECT jsonb_object_agg(account->>'id', jsonb_build_object(
    'id', account->'id', 'provider', account->'provider', 'secretRef', account->'secretRef', 'options', COALESCE(account->'options', '{}'::jsonb)
  )) FROM jsonb_array_elements(COALESCE((SELECT "value"->'accounts' FROM "settings" WHERE "namespace" = 'connectors'), '[]'::jsonb)) account
), '{}'::jsonb);
