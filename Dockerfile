FROM oven/bun:1.3 AS base
WORKDIR /app

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
