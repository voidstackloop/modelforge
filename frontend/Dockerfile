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
CMD ["npm", "--prefix", "frontend", "run", "dev", "--", "--host", "0.0.0.0"]

FROM dependencies AS build
COPY frontend/ ./frontend/
RUN ./frontend/node_modules/.bin/tsc -p packages/contracts/tsconfig.json \
    && npm --prefix frontend run build
