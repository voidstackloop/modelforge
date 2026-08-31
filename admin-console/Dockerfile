# syntax=docker/dockerfile:1.7
FROM node:22-alpine AS dependencies
WORKDIR /workspace/admin-console
COPY admin-console/package.json admin-console/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

FROM dependencies AS development
ENV NODE_ENV=development
COPY admin-console/ ./
EXPOSE 5174
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "5174"]

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

