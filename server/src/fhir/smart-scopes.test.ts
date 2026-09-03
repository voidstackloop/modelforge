import { describe, expect, it } from "vitest";
import { deniedBySmartLaunchContext, resolveSmartLaunchContext } from "./smart-scopes.js";

describe("resolveSmartLaunchContext", () => {
    it("returns undefined for a plain OIDC token with no scope claim at all — existing IAM auth is unaffected", () => {
        expect(resolveSmartLaunchContext({ sub: "idp|clinician-1" })).toBeUndefined();
    });

    it("returns undefined when scope has no patient/-prefixed grant, even with a patient claim present", () => {
        expect(resolveSmartLaunchContext({ scope: "openid fhirUser", patient: "MRN-001" })).toBeUndefined();
    });

    it("returns undefined when a patient-scoped grant is present but there is no patient launch-context claim", () => {
        expect(resolveSmartLaunchContext({ scope: "patient/*.read" })).toBeUndefined();
    });

    it("returns a launch context confined to the patient claim when both a patient-scoped grant and a patient claim are present", () => {
        expect(resolveSmartLaunchContext({ scope: "openid launch patient/*.read", patient: "MRN-001" })).toEqual({ confinedToPatientId: "MRN-001" });
    });

    it("recognizes a resource-specific patient scope (patient/ImagingStudy.read), not just the wildcard", () => {
        expect(resolveSmartLaunchContext({ scope: "patient/ImagingStudy.read", patient: "MRN-002" })).toEqual({ confinedToPatientId: "MRN-002" });
    });
});

describe("deniedBySmartLaunchContext", () => {
    it("is never denied when there is no launch context (plain OIDC token)", () => {
        expect(deniedBySmartLaunchContext(undefined, "MRN-001")).toBe(false);
    });

    it("is not denied when the resource's patient matches the launch context", () => {
        expect(deniedBySmartLaunchContext({ confinedToPatientId: "MRN-001" }, "MRN-001")).toBe(false);
    });

    it("is denied when the resource's patient does not match the launch context", () => {
        expect(deniedBySmartLaunchContext({ confinedToPatientId: "MRN-001" }, "MRN-999")).toBe(true);
    });
});
