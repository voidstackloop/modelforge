#!/bin/sh
set -eu

: "${MODELFORGE_RUNTIME_DB_PASSWORD:?MODELFORGE_RUNTIME_DB_PASSWORD is required}"

psql --set=ON_ERROR_STOP=1 \
    --username "$POSTGRES_USER" \
    --dbname "$POSTGRES_DB" \
    --set=runtime_password="$MODELFORGE_RUNTIME_DB_PASSWORD" <<'EOSQL'
SELECT format('CREATE ROLE modelforge_runtime LOGIN PASSWORD %L', :'runtime_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'modelforge_runtime') \gexec
SELECT format('ALTER ROLE modelforge_runtime LOGIN PASSWORD %L', :'runtime_password') \gexec
ALTER ROLE modelforge_runtime NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
EOSQL

