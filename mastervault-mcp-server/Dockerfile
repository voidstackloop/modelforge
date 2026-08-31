# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim AS dependencies
WORKDIR /workspace/mastervault-mcp-server
COPY mastervault-mcp-server/package.json mastervault-mcp-server/package-lock.json ./
# `prepare` runs the TypeScript build, but source and tsconfig are copied in
# the target stage so dependency caching is not invalidated by source edits.
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts

FROM dependencies AS development
ENV NODE_ENV=development
COPY mastervault-mcp-server/ ./
USER node
CMD ["npm", "run", "dev"]

FROM dependencies AS build
COPY mastervault-mcp-server/ ./
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:22-bookworm-slim AS production
ENV NODE_ENV=production
WORKDIR /workspace/mastervault-mcp-server
COPY --from=build --chown=node:node /workspace/mastervault-mcp-server/package.json ./package.json
COPY --from=build --chown=node:node /workspace/mastervault-mcp-server/node_modules ./node_modules
COPY --from=build --chown=node:node /workspace/mastervault-mcp-server/dist ./dist
USER node
ENTRYPOINT ["node", "dist/index.js"]
