# ModelForge containers

The container boundary follows the architecture instead of pretending every
package is a daemon:

| Component | Development | Production |
| --- | --- | --- |
| `server/` API | Hot reload in `compose.dev.yml` | Immutable, non-root service in `compose.prod.yml` |
| `admin-console/` | Vite hot reload with `/api` proxy | Static Nginx image with same-origin `/api` proxy |
| Postgres | Persistent local dependency | Persistent bundled dependency; replace with managed Postgres when required |
| Redis | Persistent local dependency | Authenticated internal dependency; replace with managed Redis when required |
| Keycloak | Real imported development realm | Not bundled; production must use the organization's external IdP |
| `mastervault-mcp-server/` | Dockerfile `development` target | Non-root stdio image (run interactively from an MCP client) |
| `frontend/` Electron renderer | Dockerfile dev/build targets | Build artifact only; it is not a standalone website |
| `app/` Electron main process | Dockerfile watch/build targets | Host-native packaging/runtime; it needs GPU, keychain, filesystem and desktop APIs |

## Development stack

From the repository root:

```bash
docker compose -f compose.dev.yml up --build
```

Docker Desktop must have **Settings → Resources → WSL Integration → Ubuntu**
enabled before that command works inside WSL. If integration is disabled,
run the same stack from PowerShell without moving the repository:

```powershell
docker compose -f "\\wsl.localhost\Ubuntu\home\saldev\projects\modelforge\compose.dev.yml" up --build
```

Open:

- Admin console: `http://localhost:5174`
- Keycloak: `http://localhost:8080` (`admin` / `admin` by default)
- API health: `http://localhost:4000/health`

The imported realm has a development-only user: `developer` / `developer`.
After signing in, bootstrap the first ModelForge organization through the
normal product flow. These credentials and the deterministic imaging key are
intentionally limited to the development Compose file.

Source changes under `server/src` and `admin-console/src` reload automatically.
A dependency, lockfile, TypeScript config, migration, or shared-contract change
requires rebuilding the affected image:

```bash
docker compose -f compose.dev.yml up --build server admin-console
```

Reset all local container data only when that data is disposable:

```bash
docker compose -f compose.dev.yml down --volumes
```

## Production-shaped stack

The included production stack is a reproducible single-host baseline, not a
claim of HIPAA compliance. TLS termination, backups, monitoring, secret
delivery, network policy, image signing/scanning, and the external IdP remain
deployment responsibilities.

```bash
cp .env.production.example .env.production
# Replace every placeholder and generate IMAGING_ENCRYPTION_KEY.
docker compose --env-file .env.production -f compose.prod.yml config
docker compose --env-file .env.production -f compose.prod.yml up -d --build
```

Only the admin gateway publishes a host port. It serves plain HTTP on the
configured local port; put a TLS ingress or reverse proxy in front of it.
Postgres, Redis, and the API remain on the private Compose network. Nginx sends
`/api/*` to the API, so browser requests are same-origin.

The database initializes two roles before the API starts:

- `modelforge_owner` applies migrations through `DATABASE_URL`.
- `modelforge_runtime` serves requests through `RUNTIME_DATABASE_URL`, with
  the grants and row-level-security constraints in migration 010.

Postgres initialization scripts run only for a new data volume. Changing a
password in `.env.production` does not rotate credentials inside an existing
database; rotate them in Postgres first, then update the secret source.

Passwords inserted into connection URLs must be URL-safe or percent-encoded.
For a managed database/Redis, override the service environment URLs in a small
deployment-specific Compose overlay and remove the bundled dependency.

Production imaging defaults to encrypted local storage on the `imaging-data`
volume. S3/KMS, CloudFront, and PACS remain explicit external integrations;
configure their documented `IMAGING_*` variables in an overlay. They are not
silently replaced with a fake S3 or PACS container.

## Component images outside the network stack

Build the stdio MCP server:

```bash
docker build -f mastervault-mcp-server/Dockerfile --target production -t modelforge-mastervault-mcp .
docker run --rm -i -v /absolute/path/to/vault:/vault modelforge-mastervault-mcp
```

The exact vault argument/environment is defined by the MCP server itself; keep
stdin open (`-i`) because MCP uses stdio.

Build/check the Electron pieces without claiming they are server containers:

```bash
docker build -f frontend/Dockerfile --target build -t modelforge-renderer-build .
docker build -f app/Dockerfile --target build -t modelforge-desktop-main-build .
```

Native Electron installers must still be produced on the target OS with the
repository's normal `npm run package` workflow. Containerizing the GUI runtime
would remove the host integrations the application exists to orchestrate.

## Inference profiles

llama.cpp and vLLM are opt-in overlays so ordinary API/admin development does
not download models or require a GPU. Use `compose.inference.dev.yml` for
loopback development and `compose.inference.prod.yml` for internal-network,
secret-mounted production services. See [Inference](INFERENCE.md) for model
verification, endpoint registration, profiles, and live evaluation.
