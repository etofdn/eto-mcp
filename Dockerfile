FROM ghcr.io/foundry-rs/foundry:stable AS foundry

FROM oven/bun:1.3 AS base
WORKDIR /app

# Pull Foundry binaries (forge/cast/anvil) from the official GHCR image pinned
# to the `stable` tag. Binaries come with GitHub artifact attestations and are
# reproducible across builds. Both base images are Debian/glibc, so the copied
# binaries link against the host libc.
COPY --from=foundry /usr/local/bin/forge /usr/local/bin/forge
COPY --from=foundry /usr/local/bin/cast /usr/local/bin/cast
COPY --from=foundry /usr/local/bin/anvil /usr/local/bin/anvil
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/* \
    && forge --version \
    && cast --version

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
