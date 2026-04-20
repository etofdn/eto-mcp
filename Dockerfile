FROM oven/bun:1.3 AS base
WORKDIR /app

# Install Foundry (cast / forge / anvil) so the cast_*/forge_* MCP tools work
# without "Executable not found in $PATH". ~50 MB extra image weight.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates git \
    && rm -rf /var/lib/apt/lists/* \
    && curl -L https://foundry.paradigm.xyz | bash \
    && /root/.foundry/bin/foundryup
ENV PATH="/root/.foundry/bin:${PATH}"

# Install dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Copy source
COPY src/ src/
COPY public/ public/
COPY tsconfig.json ./

# Build check
RUN bun run build

EXPOSE 8080

ENV NODE_ENV=production
ENV PORT=8080

CMD ["bun", "run", "src/sse-server.ts"]
