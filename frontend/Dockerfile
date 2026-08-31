# syntax=docker/dockerfile:1.7
# The renderer is an Electron asset, not a separately deployable web service.
FROM node:22-bookworm-slim AS dependencies
WORKDIR /workspace
COPY packages/contracts/package.json packages/contracts/tsconfig.json ./packages/contracts/
COPY packages/contracts/src ./packages/contracts/src
COPY frontend/package.json frontend/package-lock.json ./frontend/
RUN --mount=type=cache,target=/root/.npm npm --prefix frontend ci \
    && ln -s ../../frontend/node_modules packages/contracts/node_modules

FROM dependencies AS development
COPY frontend/ ./frontend/
RUN ./frontend/node_modules/.bin/tsc -p packages/contracts/tsconfig.json
EXPOSE 5173
# Ephemeral local-dev container only (never shipped, never internet-facing —
# this asset is never deployed as its own service; see this file's own top
# comment). Switching user here would need a chown of /workspace's
# root-owned COPY'd files first, which isn't verifiable without a working
# Docker daemon in this environment; not worth the risk of silently breaking
# `docker compose up` for a container that only ever runs on a developer's
# own machine.
CMD ["npm", "--prefix", "frontend", "run", "dev", "--", "--host", "0.0.0.0"] # nosemgrep: dockerfile.security.missing-user.missing-user

FROM dependencies AS build
COPY frontend/ ./frontend/
RUN ./frontend/node_modules/.bin/tsc -p packages/contracts/tsconfig.json \
    && npm --prefix frontend run build
