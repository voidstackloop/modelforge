import type { HardwareSnapshot, ResourceBudgetMode, ResourceBudgetSettings } from "./resource-contracts";

/**
 * Item 4: "Default to a Balanced mode... Preserve an OS reserve based on
 * both a percentage and minimum floor." Applied to every hardware snapshot
 * before the orchestrator ever evaluates a request against it
 * (resource-orchestrator.ts's drain()) — every workload kind shares this
 * one ceiling, on top of (not instead of) the orchestrator's own per-lease
 * CPU/RAM/VRAM accounting.
 *
 * Percentages and floors below are a starting point, not a measured
 * constant — reasonable defaults for a desktop machine running one
 * interactive app alongside the OS, disclosed as such rather than
 * presented as empirically tuned.
 */
const MODE_RESERVES: Record<Exclude<ResourceBudgetMode, "manual">, { ramReservePercent: number; ramReserveFloorMB: number; cpuReserveThreads: number }> = {
    balanced: { ramReservePercent: 0.15, ramReserveFloorMB: 2_048, cpuReserveThreads: 1 },
    performance: { ramReservePercent: 0.08, ramReserveFloorMB: 1_024, cpuReserveThreads: 1 },
    efficient: { ramReservePercent: 0.30, ramReserveFloorMB: 4_096, cpuReserveThreads: 2 },
};

// Applied even in "manual" mode — a user-supplied ceiling is a maximum, not
// a promise the OS/UI needs nothing at all. Prevents a mistaken maxRamMB
// (e.g. accidentally set to the machine's full physical RAM) from starving
// the OS outright.
const MANUAL_MODE_FLOOR = { ramReservePercent: 0.05, ramReserveFloorMB: 512, cpuReserveThreads: 1 };

export function applyResourceBudgetMode(hardware: HardwareSnapshot, settings: ResourceBudgetSettings): HardwareSnapshot {
    if (settings.mode === "manual") {
        const floorReserveMB = Math.max(MANUAL_MODE_FLOOR.ramReserveFloorMB, hardware.totalRamMB * MANUAL_MODE_FLOOR.ramReservePercent);
        const floorCeilingMB = Math.max(0, hardware.totalRamMB - floorReserveMB);
        const ramCeilingMB = settings.maxRamMB !== undefined ? Math.min(settings.maxRamMB, floorCeilingMB) : floorCeilingMB;
        const availableRamMB = Math.max(0, Math.min(hardware.availableRamMB, ramCeilingMB));

        const cpuFloor = Math.max(1, hardware.cpuThreads - MANUAL_MODE_FLOOR.cpuReserveThreads);
        const cpuCeiling = settings.cpuThreadCeiling !== undefined ? Math.min(settings.cpuThreadCeiling, cpuFloor) : cpuFloor;
        const availableCpuThreads = Math.max(1, Math.min(hardware.availableCpuThreads, cpuCeiling));

        const gpus = settings.maxVramMB === undefined
            ? hardware.gpus
            : hardware.gpus.map((gpu) => ({
                  ...gpu,
                  availableVramMB: gpu.availableVramMB === null ? null : Math.min(gpu.availableVramMB, settings.maxVramMB!),
              }));

        return { ...hardware, availableRamMB, availableCpuThreads, gpus };
    }

    const reserve = MODE_RESERVES[settings.mode];
    const ramReserveMB = Math.max(reserve.ramReserveFloorMB, hardware.totalRamMB * reserve.ramReservePercent);
    const availableRamMB = Math.max(0, Math.min(hardware.availableRamMB, hardware.totalRamMB - ramReserveMB));
    const availableCpuThreads = Math.max(1, hardware.availableCpuThreads - reserve.cpuReserveThreads);

    return { ...hardware, availableRamMB, availableCpuThreads };
}
