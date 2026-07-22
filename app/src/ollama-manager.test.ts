import { describe, it, expect } from "vitest";
import { setHost, getHost, setModelsDir, getModelsDir } from "./ollama-manager";

describe("ollama-manager config", () => {
    it("defaults to the local Ollama host", () => {
        setHost(undefined);
        expect(getHost()).toBe("http://127.0.0.1:11434");
    });

    it("trims a custom host and strips trailing slashes", () => {
        setHost("  http://example.com:11434/  ");
        expect(getHost()).toBe("http://example.com:11434");
        setHost(undefined); // reset for other tests
    });

    it("falls back to the default host for an empty string", () => {
        setHost("");
        expect(getHost()).toBe("http://127.0.0.1:11434");
    });

    it("has no models directory override by default", () => {
        setModelsDir(undefined);
        expect(getModelsDir()).toBeUndefined();
    });

    it("stores a trimmed models directory", () => {
        setModelsDir("  /data/models  ");
        expect(getModelsDir()).toBe("/data/models");
        setModelsDir(undefined); // reset for other tests
    });

    it("clears the models directory override for an empty string", () => {
        setModelsDir("");
        expect(getModelsDir()).toBeUndefined();
    });
});
