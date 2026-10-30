ARG REGISTRY=docker.io
FROM ${REGISTRY}/oven/bun:1.3.14-alpine AS base
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
COPY test ./test

ENV NODE_ENV=production
EXPOSE 3000
CMD ["bun", "run", "src/main.ts"]
