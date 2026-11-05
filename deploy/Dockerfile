# syntax=docker/dockerfile:1
FROM pgvector/pgvector:0.8.6-pg16-bookworm@sha256:ccc6e83d6e35e931dc7c5def2022729d5a6c370318d099181995567ff1fb4d6b AS postgres-client
RUN mkdir -p /out/bin /out/lib \
    && cp /usr/lib/postgresql/16/bin/pg_dump /usr/lib/postgresql/16/bin/pg_restore /usr/lib/postgresql/16/bin/psql /out/bin/ \
    && ldd /out/bin/* | awk '/=> \// { print $3 }' | sort -u | xargs -r cp --target-directory=/out/lib

FROM node:26.13.0-bookworm-slim@sha256:bc0a2afd3b74ce12222fc8bab99271e66257f021078f5f4a5d687a77d280c1d9 AS build

WORKDIR /workspace
ENV CI=true NEXT_TELEMETRY_DISABLED=1

RUN npm install --global pnpm@11.25.0

COPY . .
RUN --mount=type=cache,id=sazuz-pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir=/pnpm/store
RUN pnpm build
RUN pnpm --filter @sazuz/server deploy --prod --legacy /out/server
RUN mkdir -p /workspace/apps/web/public

FROM node:26.13.0-bookworm-slim@sha256:bc0a2afd3b74ce12222fc8bab99271e66257f021078f5f4a5d687a77d280c1d9 AS runtime

WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY --from=postgres-client /out /opt/sazuz-postgres

# Workspace imports are bundled. This production dependency tree provides
# external packages and their native/dynamic loading behavior without dev tools.
COPY --from=build /out/server/node_modules ./node_modules
COPY --from=build /workspace/package.json ./package.json
COPY --from=build /workspace/apps/server/dist ./apps/server/dist
COPY --from=build /workspace/apps/worker/dist ./apps/worker/dist
COPY --from=build /workspace/dist ./dist
COPY --from=build /workspace/packages/db/migrations ./packages/db/migrations
COPY --from=build /workspace/skills ./skills
COPY --from=build /workspace/recipes ./recipes
COPY --from=build /workspace/agents ./agents

# Next's standalone tree carries its own traced production dependencies.
COPY --from=build /workspace/apps/web/.next/standalone ./web
COPY --from=build /workspace/apps/web/.next/static ./web/apps/web/.next/static
COPY --from=build /workspace/apps/web/public ./web/apps/web/public
COPY deploy/entrypoint.mjs deploy/healthcheck.mjs ./deploy/

# A fresh named volume copies this ownership before bootstrap runs as node.
RUN mkdir -p /data/secrets /data/workspace /run/sazuz-egress \
    && chown 1000:1000 /data /data/secrets /data/workspace /run/sazuz-egress \
    && chmod 0700 /data /data/secrets /data/workspace /run/sazuz-egress

USER 1000:1000
EXPOSE 7777
ENTRYPOINT ["node", "/app/deploy/entrypoint.mjs"]
CMD ["web"]
