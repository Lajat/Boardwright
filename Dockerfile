FROM node:22-alpine AS builder

RUN npm install -g pnpm@11.17.0

WORKDIR /repo

# Copy manifests first for Docker layer caching
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared-types/package.json ./packages/shared-types/package.json
COPY apps/api/package.json ./apps/api/package.json

RUN pnpm install --frozen-lockfile

# Copy source. .dockerignore prevents local node_modules from being copied.
COPY packages/shared-types ./packages/shared-types
COPY apps/api ./apps/api

RUN pnpm --filter @boardwright/shared-types build
RUN pnpm --filter @boardwright/api build

# Create a standalone production deployment
RUN pnpm --filter @boardwright/api deploy --prod --legacy /out/api


# Runtime image
FROM node:22-alpine

ENV NODE_ENV=production
ENV PORT=80

WORKDIR /app

COPY --from=builder /out/api ./
COPY --from=builder /repo/apps/api/dist ./dist

EXPOSE 80

CMD ["node", "dist/index.js"]
