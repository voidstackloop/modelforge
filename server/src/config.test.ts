import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./config.js";

function baseEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return {
        OIDC_ISSUER: "https://idp.example-hospital.test/realms/clinical",
        OIDC_AUDIENCE: "modelforge-iam-server",
        ...overrides,
    };
}

describe("loadConfig", () => {
    it("throws when OIDC_ISSUER is missing", () => {
        expect(() => loadConfig({ OIDC_AUDIENCE: "modelforge-iam-server" })).toThrow(ConfigError);
    });

    it("throws when OIDC_AUDIENCE is missing", () => {
        expect(() => loadConfig({ OIDC_ISSUER: "https://idp.example-hospital.test/realms/clinical" })).toThrow(ConfigError);
    });

    it("throws when both OIDC_ISSUER and OIDC_AUDIENCE are missing", () => {
        expect(() => loadConfig({})).toThrow(ConfigError);
    });

    describe("CACHE_TTL_MS", () => {
        it("defaults to 30000 when unset", () => {
            expect(loadConfig(baseEnv()).cache.ttlMs).toBe(30_000);
        });

        it("accepts a valid value within bounds", () => {
            expect(loadConfig(baseEnv({ CACHE_TTL_MS: "60000" })).cache.ttlMs).toBe(60_000);
        });

        it("accepts the minimum bound (1000)", () => {
            expect(loadConfig(baseEnv({ CACHE_TTL_MS: "1000" })).cache.ttlMs).toBe(1_000);
        });

        it("accepts the maximum bound (3600000)", () => {
            expect(loadConfig(baseEnv({ CACHE_TTL_MS: "3600000" })).cache.ttlMs).toBe(3_600_000);
        });

        it("rejects a non-numeric value", () => {
            expect(() => loadConfig(baseEnv({ CACHE_TTL_MS: "not-a-number" }))).toThrow(ConfigError);
        });

        it("rejects zero", () => {
            expect(() => loadConfig(baseEnv({ CACHE_TTL_MS: "0" }))).toThrow(ConfigError);
        });

        it("rejects a negative value", () => {
            expect(() => loadConfig(baseEnv({ CACHE_TTL_MS: "-1000" }))).toThrow(ConfigError);
        });

        it("rejects a non-integer value", () => {
            expect(() => loadConfig(baseEnv({ CACHE_TTL_MS: "1500.5" }))).toThrow(ConfigError);
        });

        it("rejects Infinity", () => {
            expect(() => loadConfig(baseEnv({ CACHE_TTL_MS: "Infinity" }))).toThrow(ConfigError);
        });

        it("rejects a value below the 1000ms floor", () => {
            expect(() => loadConfig(baseEnv({ CACHE_TTL_MS: "999" }))).toThrow(ConfigError);
        });

        it("rejects a value above the 1-hour ceiling", () => {
            expect(() => loadConfig(baseEnv({ CACHE_TTL_MS: "3600001" }))).toThrow(ConfigError);
        });

        it("error message names the offending variable and the valid range", () => {
            try {
                loadConfig(baseEnv({ CACHE_TTL_MS: "abc" }));
                expect.unreachable();
            } catch (err) {
                expect(err).toBeInstanceOf(ConfigError);
                expect((err as Error).message).toContain("CACHE_TTL_MS");
                expect((err as Error).message).toContain("1000");
                expect((err as Error).message).toContain("3600000");
            }
        });
    });

    describe("CACHE_NEGATIVE_TTL_MS", () => {
        it("defaults to 5000 when unset", () => {
            expect(loadConfig(baseEnv()).cache.negativeTtlMs).toBe(5_000);
        });

        it("defaults to no more than CACHE_TTL_MS when CACHE_TTL_MS is set below the usual 5000 default", () => {
            const config = loadConfig(baseEnv({ CACHE_TTL_MS: "2000" }));
            expect(config.cache.negativeTtlMs).toBe(2_000);
        });

        it("accepts an explicit value within bounds", () => {
            expect(loadConfig(baseEnv({ CACHE_NEGATIVE_TTL_MS: "1000" })).cache.negativeTtlMs).toBe(1_000);
        });

        it("rejects a value greater than CACHE_TTL_MS", () => {
            expect(() => loadConfig(baseEnv({ CACHE_TTL_MS: "10000", CACHE_NEGATIVE_TTL_MS: "20000" }))).toThrow(ConfigError);
        });

        it("rejects a non-numeric value", () => {
            expect(() => loadConfig(baseEnv({ CACHE_NEGATIVE_TTL_MS: "not-a-number" }))).toThrow(ConfigError);
        });

        it("rejects a value below the 100ms floor", () => {
            expect(() => loadConfig(baseEnv({ CACHE_NEGATIVE_TTL_MS: "50" }))).toThrow(ConfigError);
        });
    });

    describe("CACHE_DISABLE", () => {
        it("defaults to caching enabled", () => {
            expect(loadConfig(baseEnv()).cache.enabled).toBe(true);
        });

        it("disables caching when set to \"1\"", () => {
            expect(loadConfig(baseEnv({ CACHE_DISABLE: "1" })).cache.enabled).toBe(false);
        });

        it("any other value leaves caching enabled", () => {
            expect(loadConfig(baseEnv({ CACHE_DISABLE: "true" })).cache.enabled).toBe(true);
        });
    });

    describe("OIDC_ISSUER security (assertSecureUrl)", () => {
        it("accepts an HTTPS issuer", () => {
            expect(() => loadConfig(baseEnv())).not.toThrow();
        });

        it("rejects a plaintext HTTP issuer against a real host", () => {
            expect(() => loadConfig({ OIDC_ISSUER: "http://idp.example-hospital.test" })).toThrow(ConfigError);
        });

        it.each(["http://localhost:8080", "http://127.0.0.1:8080", "http://[::1]:8080"])(
            "allows an explicit HTTP loopback issuer for local development (%s)",
            (issuer) => {
                expect(() => loadConfig(baseEnv({ OIDC_ISSUER: issuer }))).not.toThrow();
            }
        );

        it("rejects a malformed issuer URL", () => {
            expect(() => loadConfig({ OIDC_ISSUER: "not a url" })).toThrow(ConfigError);
        });
    });

    describe("OIDC_ADDITIONAL_ISSUERS (P2 item 3: multiple-IdP compatibility)", () => {
        it("defaults to an empty array when unset", () => {
            expect(loadConfig(baseEnv()).oidc.additionalIssuers).toEqual([]);
        });

        it("parses a well-formed list of additional issuers", () => {
            const config = loadConfig(
                baseEnv({
                    OIDC_ADDITIONAL_ISSUERS: JSON.stringify([
                        { issuer: "https://idp-b.example-hospital.test", audience: "modelforge-iam-server-b" },
                        { issuer: "https://idp-c.example-hospital.test", audience: "modelforge-iam-server-c", jwksUri: "https://idp-c.example-hospital.test/jwks" },
                    ]),
                })
            );
            expect(config.oidc.additionalIssuers).toEqual([
                { issuer: "https://idp-b.example-hospital.test", audience: "modelforge-iam-server-b", jwksUri: undefined },
                { issuer: "https://idp-c.example-hospital.test", audience: "modelforge-iam-server-c", jwksUri: "https://idp-c.example-hospital.test/jwks" },
            ]);
        });

        it("throws on malformed JSON", () => {
            expect(() => loadConfig(baseEnv({ OIDC_ADDITIONAL_ISSUERS: "{not json" }))).toThrow(ConfigError);
        });

        it("throws when the value isn't a JSON array", () => {
            expect(() => loadConfig(baseEnv({ OIDC_ADDITIONAL_ISSUERS: JSON.stringify({ issuer: "https://idp-b.test", audience: "a" }) }))).toThrow(ConfigError);
        });

        it("throws when an entry is missing issuer or audience", () => {
            expect(() => loadConfig(baseEnv({ OIDC_ADDITIONAL_ISSUERS: JSON.stringify([{ audience: "a" }]) }))).toThrow(ConfigError);
            expect(() => loadConfig(baseEnv({ OIDC_ADDITIONAL_ISSUERS: JSON.stringify([{ issuer: "https://idp-b.test" }]) }))).toThrow(ConfigError);
        });

        it("rejects a plaintext HTTP additional issuer against a real host, the same bar as the primary", () => {
            expect(() =>
                loadConfig(baseEnv({ OIDC_ADDITIONAL_ISSUERS: JSON.stringify([{ issuer: "http://idp-b.example-hospital.test", audience: "a" }]) }))
            ).toThrow(ConfigError);
        });

        it("rejects an additional issuer that duplicates the primary OIDC_ISSUER", () => {
            expect(() =>
                loadConfig(
                    baseEnv({
                        OIDC_ADDITIONAL_ISSUERS: JSON.stringify([{ issuer: "https://idp.example-hospital.test/realms/clinical", audience: "a" }]),
                    })
                )
            ).toThrow(ConfigError);
        });

        it("rejects two additional issuers that duplicate each other", () => {
            expect(() =>
                loadConfig(
                    baseEnv({
                        OIDC_ADDITIONAL_ISSUERS: JSON.stringify([
                            { issuer: "https://idp-b.example-hospital.test", audience: "a" },
                            { issuer: "https://idp-b.example-hospital.test", audience: "b" },
                        ]),
                    })
                )
            ).toThrow(ConfigError);
        });
    });

    describe("DATABASE_URL security (assertSecureDatabaseUrl)", () => {
        it("is not validated at all when unset (in-memory store)", () => {
            expect(() => loadConfig(baseEnv())).not.toThrow();
        });

        it("accepts a DATABASE_URL with no sslmode specified", () => {
            expect(() => loadConfig(baseEnv({ DATABASE_URL: "postgres://user:pass@db.example-hospital.test:5432/modelforge" }))).not.toThrow();
        });

        it("rejects sslmode=disable against a non-loopback host", () => {
            expect(() =>
                loadConfig(baseEnv({ DATABASE_URL: "postgres://user:pass@db.example-hospital.test:5432/modelforge?sslmode=disable" }))
            ).toThrow(ConfigError);
        });

        it("rejects sslmode=allow against a non-loopback host (still permits an unencrypted connection if the server allows it)", () => {
            expect(() =>
                loadConfig(baseEnv({ DATABASE_URL: "postgres://user:pass@db.example-hospital.test:5432/modelforge?sslmode=allow" }))
            ).toThrow(ConfigError);
        });

        it("accepts sslmode=require against a non-loopback host", () => {
            expect(() =>
                loadConfig(baseEnv({ DATABASE_URL: "postgres://user:pass@db.example-hospital.test:5432/modelforge?sslmode=require" }))
            ).not.toThrow();
        });

        it("allows sslmode=disable against an explicit loopback host (local development)", () => {
            expect(() => loadConfig(baseEnv({ DATABASE_URL: "postgres://user:pass@localhost:5432/modelforge?sslmode=disable" }))).not.toThrow();
        });

        it("rejects a malformed DATABASE_URL", () => {
            expect(() => loadConfig(baseEnv({ DATABASE_URL: "not a url" }))).toThrow(ConfigError);
        });
    });

    describe("RUNTIME_DATABASE_URL (migration-owner vs. restricted runtime role)", () => {
        it("is undefined when unset — DATABASE_URL alone drives both migrations and the runtime pool", () => {
            const config = loadConfig(baseEnv({ DATABASE_URL: "postgres://user:pass@db.example-hospital.test:5432/modelforge" }));
            expect(config.runtimeDatabaseUrl).toBeUndefined();
        });

        it("is carried through when set alongside DATABASE_URL", () => {
            const config = loadConfig(
                baseEnv({
                    DATABASE_URL: "postgres://owner:pass@db.example-hospital.test:5432/modelforge",
                    RUNTIME_DATABASE_URL: "postgres://runtime:pass@db.example-hospital.test:5432/modelforge",
                })
            );
            expect(config.runtimeDatabaseUrl).toBe("postgres://runtime:pass@db.example-hospital.test:5432/modelforge");
        });

        it("rejects RUNTIME_DATABASE_URL set without DATABASE_URL — there would be nothing to run migrations as", () => {
            expect(() => loadConfig(baseEnv({ RUNTIME_DATABASE_URL: "postgres://runtime:pass@db.example-hospital.test:5432/modelforge" }))).toThrow(
                ConfigError
            );
        });

        it("applies the same secure-connection rules as DATABASE_URL (rejects sslmode=disable against a non-loopback host)", () => {
            expect(() =>
                loadConfig(
                    baseEnv({
                        DATABASE_URL: "postgres://owner:pass@db.example-hospital.test:5432/modelforge",
                        RUNTIME_DATABASE_URL: "postgres://runtime:pass@db.example-hospital.test:5432/modelforge?sslmode=disable",
                    })
                )
            ).toThrow(ConfigError);
        });

        it("rejects a malformed RUNTIME_DATABASE_URL", () => {
            expect(() =>
                loadConfig(baseEnv({ DATABASE_URL: "postgres://owner:pass@db.example-hospital.test:5432/modelforge", RUNTIME_DATABASE_URL: "not a url" }))
            ).toThrow(ConfigError);
        });
    });

    describe("ADMIN_CONSOLE_ORIGIN (CORS opt-in)", () => {
        it("is undefined when unset — CORS stays off", () => {
            expect(loadConfig(baseEnv()).adminConsoleOrigin).toBeUndefined();
        });

        it("is carried through when set to an HTTPS origin", () => {
            expect(loadConfig(baseEnv({ ADMIN_CONSOLE_ORIGIN: "https://admin.example-hospital.test" })).adminConsoleOrigin).toBe(
                "https://admin.example-hospital.test"
            );
        });

        it("rejects a plaintext HTTP origin against a real host", () => {
            expect(() => loadConfig(baseEnv({ ADMIN_CONSOLE_ORIGIN: "http://admin.example-hospital.test" }))).toThrow(ConfigError);
        });

        it("allows an explicit HTTP loopback origin for local development", () => {
            expect(() => loadConfig(baseEnv({ ADMIN_CONSOLE_ORIGIN: "http://localhost:5173" }))).not.toThrow();
        });

        it("rejects a malformed origin", () => {
            expect(() => loadConfig(baseEnv({ ADMIN_CONSOLE_ORIGIN: "not a url" }))).toThrow(ConfigError);
        });
    });

    describe("strict numeric env parsing (PORT/POOL_*/RATE_LIMIT_*, fails loudly rather than producing NaN)", () => {
        it("PORT defaults to 4000 when unset", () => {
            expect(loadConfig(baseEnv()).port).toBe(4000);
        });

        it("PORT rejects a non-numeric value instead of silently becoming NaN", () => {
            expect(() => loadConfig(baseEnv({ PORT: "not-a-port" }))).toThrow(ConfigError);
        });

        it("PORT rejects 0 and values above 65535", () => {
            expect(() => loadConfig(baseEnv({ PORT: "0" }))).toThrow(ConfigError);
            expect(() => loadConfig(baseEnv({ PORT: "70000" }))).toThrow(ConfigError);
        });

        it("POOL_MAX rejects a non-numeric value", () => {
            expect(() => loadConfig(baseEnv({ POOL_MAX: "lots" }))).toThrow(ConfigError);
        });

        it("RATE_LIMIT_WINDOW_MS rejects a negative value", () => {
            expect(() => loadConfig(baseEnv({ RATE_LIMIT_WINDOW_MS: "-1" }))).toThrow(ConfigError);
        });

        it("blank (empty-string) values fall back to defaults, matching every existing cache env var", () => {
            const config = loadConfig(baseEnv({ PORT: "", POOL_MAX: "" }));
            expect(config.port).toBe(4000);
            expect(config.dbPool.max).toBe(10);
        });
    });

    describe("TRUST_PROXY", () => {
        it("defaults to false when unset", () => {
            expect(loadConfig(baseEnv()).trustProxy).toBe(false);
        });

        it("is true only when set to exactly \"1\"", () => {
            expect(loadConfig(baseEnv({ TRUST_PROXY: "1" })).trustProxy).toBe(true);
        });

        it("any other value leaves it false, rather than truthy-string-coercing", () => {
            expect(loadConfig(baseEnv({ TRUST_PROXY: "true" })).trustProxy).toBe(false);
        });
    });

    describe("IMAGING_CLOUDFRONT_* (CDN delivery for pixel data)", () => {
        // A syntactically valid PEM is needed because loadConfig checks the
        // decoded content, not just that the base64 parses.
        const pem = generateKeyPairSync("rsa", {
            modulusLength: 2048,
            publicKeyEncoding: { type: "spki", format: "pem" },
            privateKeyEncoding: { type: "pkcs8", format: "pem" },
        }).privateKey;
        const pemBase64 = Buffer.from(pem, "utf8").toString("base64");
        const s3Env = { IMAGING_S3_BUCKET: "b", IMAGING_S3_KMS_KEY_ID: "k", IMAGING_S3_REGION: "eu-west-1" };
        const cloudFrontEnv = {
            IMAGING_CLOUDFRONT_DOMAIN: "cdn.example.test",
            IMAGING_CLOUDFRONT_KEY_PAIR_ID: "KID123",
            IMAGING_CLOUDFRONT_PRIVATE_KEY: pemBase64,
        };

        it("is undefined when unset — origin streaming is the default, never CDN-by-accident", () => {
            expect(loadConfig(baseEnv()).imaging.cloudFront).toBeUndefined();
        });

        it("decodes the base64 PEM when fully configured alongside S3", () => {
            const config = loadConfig(baseEnv({ ...s3Env, ...cloudFrontEnv }));
            expect(config.imaging.cloudFront).toEqual({ domain: "cdn.example.test", keyPairId: "KID123", privateKeyPem: pem });
        });

        it("rejects a partial configuration rather than silently ignoring the CDN settings", () => {
            for (const key of Object.keys(cloudFrontEnv) as (keyof typeof cloudFrontEnv)[]) {
                const partial = { ...cloudFrontEnv };
                delete partial[key];
                expect(() => loadConfig(baseEnv({ ...s3Env, ...partial }))).toThrow(ConfigError);
            }
        });

        it("rejects CloudFront without S3 — there would be no bucket for it to front", () => {
            expect(() => loadConfig(baseEnv(cloudFrontEnv))).toThrow(/requires S3 imaging storage/);
        });

        it("rejects a private key that is not a base64-encoded PEM", () => {
            expect(() =>
                loadConfig(baseEnv({ ...s3Env, ...cloudFrontEnv, IMAGING_CLOUDFRONT_PRIVATE_KEY: Buffer.from("nonsense").toString("base64") }))
            ).toThrow(/base64-encoded PEM/);
        });
    });

    describe("HL7_MLLP_*", () => {
        const ORG_ID = "11111111-1111-4111-8111-111111111111";

        it("is undefined when unset — no MLLP listener starts by default", () => {
            expect(loadConfig(baseEnv()).hl7Mllp).toBeUndefined();
        });

        it("rejects HL7_MLLP_PORT without HL7_MLLP_ORGANIZATION_ID", () => {
            expect(() => loadConfig(baseEnv({ HL7_MLLP_PORT: "2575" }))).toThrow(/must be configured together/);
        });

        it("rejects HL7_MLLP_ORGANIZATION_ID without HL7_MLLP_PORT", () => {
            expect(() => loadConfig(baseEnv({ HL7_MLLP_ORGANIZATION_ID: ORG_ID }))).toThrow(/must be configured together/);
        });

        it("rejects a non-UUID organization id", () => {
            expect(() => loadConfig(baseEnv({ HL7_MLLP_PORT: "2575", HL7_MLLP_ORGANIZATION_ID: "not-a-uuid" }))).toThrow(/must be the organization's UUID/);
        });

        it("accepts a valid configuration, defaulting host to loopback", () => {
            const config = loadConfig(baseEnv({ HL7_MLLP_PORT: "2575", HL7_MLLP_ORGANIZATION_ID: ORG_ID }));
            expect(config.hl7Mllp).toEqual({ port: 2575, host: "127.0.0.1", organizationId: ORG_ID });
        });

        it("honors an explicit HL7_MLLP_HOST override", () => {
            const config = loadConfig(baseEnv({ HL7_MLLP_PORT: "2575", HL7_MLLP_ORGANIZATION_ID: ORG_ID, HL7_MLLP_HOST: "0.0.0.0" }));
            expect(config.hl7Mllp?.host).toBe("0.0.0.0");
        });

        it("rejects a port outside the valid TCP range", () => {
            expect(() => loadConfig(baseEnv({ HL7_MLLP_PORT: "70000", HL7_MLLP_ORGANIZATION_ID: ORG_ID }))).toThrow(ConfigError);
        });
    });
});
