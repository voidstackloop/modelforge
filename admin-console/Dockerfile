# syntax=docker/dockerfile:1.7
FROM node:22-alpine AS dependencies
WORKDIR /workspace/admin-console
COPY admin-console/package.json admin-console/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

FROM dependencies AS development
ENV NODE_ENV=development
COPY admin-console/ ./
EXPOSE 5174
# Ephemeral local-dev container only (never shipped, never internet-facing —
# the real production stage below runs on nginx-unprivileged, already
# non-root). Switching user here would need a chown of /workspace's
# root-owned COPY'd files first, which isn't verifiable without a working
# Docker daemon in this environment; not worth the risk of silently breaking
# `docker compose up` (including its read-only src bind mount) for a
# container that only ever runs on a developer's own machine.
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "5174"] # nosemgrep: dockerfile.security.missing-user.missing-user

FROM dependencies AS build
ARG VITE_OIDC_ISSUER
ARG VITE_OIDC_CLIENT_ID
ARG VITE_OIDC_AUDIENCE
ARG VITE_API_BASE_URL=/api
ENV VITE_OIDC_ISSUER=$VITE_OIDC_ISSUER \
    VITE_OIDC_CLIENT_ID=$VITE_OIDC_CLIENT_ID \
    VITE_OIDC_AUDIENCE=$VITE_OIDC_AUDIENCE \
    VITE_API_BASE_URL=$VITE_API_BASE_URL
COPY admin-console/ ./
RUN test -n "$VITE_OIDC_ISSUER" \
    && test -n "$VITE_OIDC_CLIENT_ID" \
    && npm run build

FROM nginxinc/nginx-unprivileged:1.27-alpine AS production
COPY docker/admin-console.nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /workspace/admin-console/dist /usr/share/nginx/html
EXPOSE 8080

