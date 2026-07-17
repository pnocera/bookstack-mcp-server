# syntax=docker/dockerfile:1

# Bun-native image for the BookStack MCP server.
# Bun executes the TypeScript source directly, so there is no compile step.

# Pinned to the exact Bun release CI validates (BUN_VERSION in
# .github/workflows/ci.yml). The floating `1-alpine` tag this used to track would
# let a future Bun minor ship in the image without ever having run the
# typecheck/test/lint job - the opposite of the lockfile-and-runtime
# reproducibility the Bun migration bought. The digest names the multi-arch
# manifest list for 1.3.14-alpine (amd64 + arm64), so the tag cannot be re-pointed
# underneath us; both stages below share this one ARG, so they cannot drift apart.
#
# To bump Bun, change this line and BUN_VERSION in the workflow together. The
# docker job's smoke suite compares the built image's `bun --version` against the
# Bun running the tests, so a half-done bump fails CI rather than shipping quietly.
# Refresh the digest with:
#   docker buildx imagetools inspect oven/bun:<version>-alpine
ARG BUN_IMAGE=oven/bun:1.3.14-alpine@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0

# --- Dependencies stage: install production node_modules only ---
FROM ${BUN_IMAGE} AS deps
WORKDIR /app

# Copy manifest + lockfile first so this layer is cached unless deps change.
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile

# --- Runtime stage: production deps + TypeScript source ---
FROM ${BUN_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Bring in the resolved production dependencies.
COPY --from=deps /app/node_modules ./node_modules

# Application manifest and source. No build: Bun runs the TS source directly.
COPY package.json bun.lock tsconfig.json ./
COPY .env.example ./.env.example
COPY src ./src

EXPOSE 3000

# Run as the non-root `bun` user provided by the oven/bun base image.
USER bun

# GET /health returns 200 when healthy, 503 otherwise. The image ships `bun`
# but NOT `node`, so the probe is implemented with `bun -e`.
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD bun -e "const r=await fetch('http://localhost:3000/health').catch(()=>null); process.exit(r&&r.status===200?0:1)"

CMD ["bun", "run", "src/server.ts"]
