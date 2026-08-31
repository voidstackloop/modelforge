import { describe, it, expect } from "vitest";
import { getSchedule, updateSchedule } from "./backup-schedule-store";

describe("backup-schedule-store", () => {
    it("starts disabled with sensible defaults", () => {
        const schedule = getSchedule();
        expect(schedule.enabled).toBe(false);
        expect(schedule.intervalHours).toBe(24);
        expect(schedule.retentionCount).toBe(14);
        expect(schedule.destinationDir).toBeNull();
        expect(schedule.lastRunAt).toBeNull();
        expect(schedule.lastError).toBeNull();
        expect(schedule.lastCloudError).toBeNull();
    });

    it("merges a partial update onto the existing schedule rather than replacing it", () => {
        updateSchedule({ enabled: true, intervalHours: 6 });
        updateSchedule({ destinationDir: "/tmp/backups" });

        const schedule = getSchedule();
        expect(schedule.enabled).toBe(true);
        expect(schedule.intervalHours).toBe(6);
        expect(schedule.destinationDir).toBe("/tmp/backups");
    });
});
