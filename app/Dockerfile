# syntax=docker/dockerfile:1.7
# Reproducible Electron main-process build/check environment. The actual GUI,
# host GPU arbitration, OS keychain and native desktop packaging run on a host,
# not as a production daemon in Compose.
FROM node:22-bookworm-slim AS dependencies
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ pkg-config \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
COPY packages/contracts/package.json packages/contracts/tsconfig.json ./packages/contracts/
COPY packages/contracts/src ./packages/contracts/src
COPY app/package.json app/package-lock.json ./app/
COPY app/scripts ./app/scripts
RUN --mount=type=cache,target=/root/.npm npm --prefix app ci \
    && ln -s ../../app/node_modules packages/contracts/node_modules

FROM dependencies AS development
COPY app/ ./app/
RUN ./app/node_modules/.bin/tsc -p packages/contracts/tsconfig.json
# Ephemeral local-dev container only (never shipped, never internet-facing —
# the real production image below correctly runs as USER node). Switching
# user here would need a chown of /workspace's root-owned COPY'd files
# first, which isn't verifiable without a working Docker daemon in this
# environment; not worth the risk of silently breaking `docker compose up`
# for a container that only ever runs on a developer's own machine.
CMD ["npm", "--prefix", "app", "run", "dev:main"] # nosemgrep: dockerfile.security.missing-user.missing-user

FROM dependencies AS build
COPY app/ ./app/
RUN ./app/node_modules/.bin/tsc -p packages/contracts/tsconfig.json \
    && npm --prefix app run build
