# LearnHarness — server image (Docker edition, 2026-10-27).
#
# Three stages:
#   deps     npm ci from the lockfile (cached while package*.json is unchanged)
#   build    next build (output: "standalone") + the payload curation and
#            smoke gates the desktop release used to run (build-server.mjs,
#            smoke-provider-runtime.mjs, smoke-server.mjs) — a broken
#            payload fails the image build, never a running container
#   runtime  node:26-bookworm-slim + Chromium (the demo-builder's render
#            engine) + fonts; runs .next/standalone/server.js as `node`
#
# Runtime contract (see docker-compose.yml / README):
#   PORT=3000 HOSTNAME=0.0.0.0        the server listens on 0.0.0.0:3000
#   LH_DATA_DIR=/data                 chats, graph, jobs, settings (a volume)
#   LH_AUTH_FILE=/data/auth.json      BYOK keys + OLLAMA_HOST, saved from the UI
#   OLLAMA_HOST=http://ollama:11434   optional — local models (compose sets it)
#   OLLAMA_CONTEXT_LENGTH=32768       optional — mirror the Ollama service's value
#   LH_ACCESS_PASSWORD / LH_ACCESS_USER  optional — HTTP Basic gate (proxy.ts)
#   CHROME_PATH=/usr/bin/chromium     set here; the demo verifier uses it

ARG NODE_IMAGE=node:26-bookworm-slim

# ─── deps ────────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# ─── build ───────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# The build must never see a developer's keys or data (next.config.ts also
# excludes them from the trace; build-server.mjs refuses a payload holding them).
RUN rm -rf data .fresh-data auth.json .env .env.local chatgpt-credentials.json* github-copilot-credentials.json* xai-credentials.json* \
	&& npm run build \
	&& node scripts/build-server.mjs \
	&& node scripts/smoke-provider-runtime.mjs \
	&& node scripts/smoke-server.mjs

# ─── runtime ─────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS runtime
# Chromium: the demo-builder sub-agent executes generated HTML in a real
# browser before delivering it (src/agent/subagents/headless.ts). Fonts:
# Skia (PDF pages) and Chromium need at least one Latin family installed.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		chromium fonts-liberation fonts-dejavu-core fontconfig ca-certificates tini \
	&& rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
	NEXT_TELEMETRY_DISABLED=1 \
	PORT=3000 \
	HOSTNAME=0.0.0.0 \
	LH_DATA_DIR=/data \
	LH_AUTH_FILE=/data/auth.json \
	CHROME_PATH=/usr/bin/chromium

WORKDIR /app
# The curated standalone payload only: server.js, the traced node_modules,
# .next/static, public/, the prompt assets. Nothing else from the checkout.
COPY --from=build --chown=node:node /app/.next/standalone ./
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
	CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/settings',{headers:process.env.LH_ACCESS_PASSWORD?{authorization:'Basic '+Buffer.from((process.env.LH_ACCESS_USER||'learnharness')+':'+process.env.LH_ACCESS_PASSWORD).toString('base64')}:{}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# tini reaps the Chromium children the demo verifier spawns.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
