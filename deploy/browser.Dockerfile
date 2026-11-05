# syntax=docker/dockerfile:1
FROM node:26.13.0-bookworm-slim@sha256:bc0a2afd3b74ce12222fc8bab99271e66257f021078f5f4a5d687a77d280c1d9 AS build
WORKDIR /workspace
ENV CI=true
RUN npm install --global pnpm@11.25.0
COPY . .
RUN --mount=type=cache,id=sazuz-pnpm,target=/pnpm/store pnpm install --frozen-lockfile --store-dir=/pnpm/store
RUN pnpm --filter @sazuz/browser-service build
RUN pnpm --filter @sazuz/browser-service deploy --prod --legacy /out/browser

FROM node:26.13.0-bookworm-slim@sha256:bc0a2afd3b74ce12222fc8bab99271e66257f021078f5f4a5d687a77d280c1d9
WORKDIR /app
ENV NODE_ENV=production PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY --from=build /out/browser/node_modules ./node_modules
COPY --from=build /out/browser/package.json ./package.json
COPY --from=build /workspace/apps/browser/dist ./dist
RUN node node_modules/playwright/cli.js install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/* \
    && chmod -R a+rX /ms-playwright
USER 1000:1000
CMD ["node", "dist/index.js"]
