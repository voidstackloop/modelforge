import { describe, it, expect } from "vitest";
import { classifyLoadError } from "./native-capability";

describe("classifyLoadError", () => {
    it("classifies a MODULE_NOT_FOUND error as not-built", () => {
        const err = Object.assign(new Error("Cannot find module"), { code: "MODULE_NOT_FOUND" });
        expect(classifyLoadError(err)).toBe("not-built");
    });

    it("classifies an ABI-version-mismatch message as abi-or-platform-mismatch", () => {
        const err = new Error("The module was compiled against a different Node.js version using NODE_MODULE_VERSION 115");
        expect(classifyLoadError(err)).toBe("abi-or-platform-mismatch");
    });

    it("classifies a wrong-platform-binary message as abi-or-platform-mismatch", () => {
        expect(classifyLoadError(new Error("invalid ELF header"))).toBe("abi-or-platform-mismatch");
        expect(classifyLoadError(new Error("%1 is not a valid Win32 application"))).toBe("abi-or-platform-mismatch");
    });

    it("classifies anything else as a generic load-error", () => {
        expect(classifyLoadError(new Error("something else entirely"))).toBe("load-error");
    });

    it("handles a non-Error thrown value without throwing itself", () => {
        expect(classifyLoadError("a plain string")).toBe("load-error");
    });
});
