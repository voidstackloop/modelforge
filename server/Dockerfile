# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim AS dependencies
WORKDIR /workspace
COPY packages/contracts/package.json packages/contracts/tsconfig.json ./packages/contracts/
COPY packages/contracts/src ./packages/contracts/src
COPY server/package.json server/package-lock.json ./server/
COPY server/vendor ./server/vendor
RUN --mount=type=cache,target=/root/.npm \
    npm --prefix server ci \
    && ln -s ../../server/node_modules packages/contracts/node_modules

FROM dependencies AS development
ENV NODE_ENV=development
COPY server/tsconfig.json ./server/tsconfig.json
COPY server/src ./server/src
COPY server/migrations ./server/migrations
RUN ./server/node_modules/.bin/tsc -p packages/contracts/tsconfig.json
EXPOSE 4000
CMD ["npm", "--prefix", "server", "run", "dev"]

FROM dependencies AS build
COPY server/tsconfig.json ./server/tsconfig.json
COPY server/src ./server/src
COPY server/migrations ./server/migrations
RUN ./server/node_modules/.bin/tsc -p packages/contracts/tsconfig.json \
    && ./server/node_modules/.bin/tsc -p server/tsconfig.json \
    && npm --prefix server prune --omit=dev \
    && rm server/node_modules/@modelforge/contracts \
    && cp -R packages/contracts server/node_modules/@modelforge/contracts \
    && rm server/node_modules/@modelforge/contracts/node_modules

FROM node:22-bookworm-slim AS production
ENV NODE_ENV=production
WORKDIR /workspace
COPY --from=build --chown=node:node /workspace/server/package.json ./server/package.json
COPY --from=build --chown=node:node /workspace/server/node_modules ./server/node_modules
COPY --from=build --chown=node:node /workspace/server/dist ./server/dist
COPY --from=build --chown=node:node /workspace/server/migrations ./server/migrations
RUN install -d -o node -g node /var/lib/modelforge/imaging
USER node
EXPOSE 4000
CMD ["node", "server/dist/index.js"]
