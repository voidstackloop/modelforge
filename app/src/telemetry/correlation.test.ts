import { describe, it, expect } from "vitest";
import { newCorrelationId, withCorrelation, getCorrelationId } from "./correlation";

describe("correlation", () => {
    it("newCorrelationId returns distinct ids", () => {
        expect(newCorrelationId()).not.toBe(newCorrelationId());
    });

    it("getCorrelationId is undefined outside any withCorrelation() call", () => {
        expect(getCorrelationId()).toBeUndefined();
    });

    it("propagates the id to code running synchronously inside withCorrelation()", () => {
        withCorrelation("job-a", () => {
            expect(getCorrelationId()).toBe("job-a");
        });
        expect(getCorrelationId()).toBeUndefined();
    });

    it("propagates the id across an await boundary inside withCorrelation()", async () => {
        await withCorrelation("job-b", async () => {
            expect(getCorrelationId()).toBe("job-b");
            await new Promise((resolve) => setTimeout(resolve, 5));
            expect(getCorrelationId()).toBe("job-b");
        });
    });

    it("isolates two concurrent, interleaved operations from each other", async () => {
        const seenInA: (string | undefined)[] = [];
        const seenInB: (string | undefined)[] = [];

        async function operation(id: string, seen: (string | undefined)[]): Promise<void> {
            await withCorrelation(id, async () => {
                seen.push(getCorrelationId());
                await new Promise((resolve) => setTimeout(resolve, 10));
                seen.push(getCorrelationId());
            });
        }

        await Promise.all([operation("job-A", seenInA), operation("job-B", seenInB)]);

        expect(seenInA).toEqual(["job-A", "job-A"]);
        expect(seenInB).toEqual(["job-B", "job-B"]);
    });

    it("an inner withCorrelation() call shadows the outer id for its own duration, then the outer id resumes", () => {
        withCorrelation("outer", () => {
            expect(getCorrelationId()).toBe("outer");
            withCorrelation("inner", () => {
                expect(getCorrelationId()).toBe("inner");
            });
            expect(getCorrelationId()).toBe("outer");
        });
    });

    it("returns the wrapped function's return value", () => {
        const result = withCorrelation("job-c", () => 42);
        expect(result).toBe(42);
    });
});
