# syntax=docker/dockerfile:1

# ---- dependencies ----------------------------------------------------------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
# `npm ci` needs the lockfile; omit dev deps so the runtime image stays small.
RUN npm ci --omit=dev

# ---- runtime ---------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

# wget is used by HEALTHCHECK; node:alpine does not ship curl.
RUN apk add --no-cache wget

COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY src ./src
COPY migrations ./migrations
COPY seeders ./seeders

# Run unprivileged. The `node` user ships with the base image.
USER node

EXPOSE 4010

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:4010/health || exit 1

CMD ["node", "src/server.js"]
