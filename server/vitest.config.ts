import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        environment: "node",
        include: ["src/**/*.test.ts"],
        // The postgres-*.test.ts suites (see e.g. postgres-rls.test.ts's own
        // disclosure comment) all run against ONE real shared Postgres
        // instance (CI's DATABASE_URL service container; a developer's own
        // local instance otherwise) — vitest's default file-level
        // parallelism runs these files concurrently across worker
        // processes, and real, unrelated-looking Postgres deadlocks
        // (AccessExclusiveLock/RowShareLock contention) and foreign-key
        // violations (one file's teardown removing a row another file's
        // in-flight test still references) are the direct result, first
        // surfaced when this package's Postgres suites started actually
        // running in CI (see the "server" job's own comment in
        // .github/workflows/ci.yml). Serializing files here trades some
        // wall-clock time for correctness against genuinely shared,
        // unpartitioned state — the correct trade for integration tests,
        // not a workaround for a test bug.
        fileParallelism: false,
    },
});
