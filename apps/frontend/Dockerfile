# syntax=docker/dockerfile:1.7
# Build context: repository root (see docker-compose.yml).
FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
COPY packages/shared-types/package.json packages/shared-types/
COPY packages/governance/package.json packages/governance/
COPY packages/ui-kit/package.json packages/ui-kit/
COPY apps/backend/package.json apps/backend/
COPY apps/frontend/package.json apps/frontend/
RUN npm ci --no-audit --no-fund
COPY tsconfig.base.json ./
COPY packages packages
COPY apps/frontend apps/frontend
# BACKEND_URL is read when next.config.ts builds the /api rewrite, so it is fixed at build time.
ARG BACKEND_URL=http://backend:8000
ENV BACKEND_URL=$BACKEND_URL
RUN npm run build --workspace @agent-os/shared-types \
 && npm run build --workspace @agent-os/frontend

FROM node:22-bookworm-slim
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages packages
COPY --from=build /app/apps/frontend apps/frontend
WORKDIR /app/apps/frontend
USER node
EXPOSE 3000
CMD ["npx", "next", "start", "-p", "3000"]
