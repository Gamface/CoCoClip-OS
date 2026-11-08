# syntax=docker/dockerfile:1.7
# Build context: repository root (see docker-compose.yml).
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared-types/package.json packages/shared-types/
COPY packages/governance/package.json packages/governance/
COPY packages/ui-kit/package.json packages/ui-kit/
COPY apps/backend/package.json apps/backend/
COPY apps/frontend/package.json apps/frontend/
RUN npm ci --no-audit --no-fund
COPY tsconfig.base.json ./
COPY packages packages
COPY apps/backend apps/backend
RUN npm run build --workspace @agent-os/shared-types \
 && npm run build --workspace @agent-os/governance \
 && npm run build --workspace @agent-os/backend \
 && npm prune --omit=dev --workspace @agent-os/backend --include-workspace-root=false

FROM node:22-bookworm-slim
ENV NODE_ENV=production PORT=8000
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/shared-types/package.json packages/shared-types/
COPY --from=build /app/packages/shared-types/dist packages/shared-types/dist
COPY --from=build /app/packages/governance/package.json packages/governance/
COPY --from=build /app/packages/governance/dist packages/governance/dist
COPY --from=build /app/apps/backend/package.json apps/backend/
COPY --from=build /app/apps/backend/dist apps/backend/dist
COPY config config
RUN mkdir -p /data && chown node:node /data
WORKDIR /app/apps/backend
ENV POLICY_FILE=/app/config/org-policy.json AUDIT_FILE=/data/audit.jsonl
USER node
EXPOSE 8000
CMD ["node", "dist/server.js"]
