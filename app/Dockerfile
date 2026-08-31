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
CMD ["npm", "--prefix", "app", "run", "dev:main"]

FROM dependencies AS build
COPY app/ ./app/
RUN ./app/node_modules/.bin/tsc -p packages/contracts/tsconfig.json \
    && npm --prefix app run build
