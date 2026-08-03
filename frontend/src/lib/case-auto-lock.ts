export const ENCRYPTION_STATUS_CHANGED_EVENT = "modelforge:encryption-status-changed";
export const CASE_LOCKED_EVENT = "modelforge:case-locked";

/** Pure decision logic, exported separately from the DOM-wiring hook so it's
 * unit-testable without touching timers/window listeners: given how long
 * it's been since the last user activity and the configured timeout, should
 * the case data lock now? `minutes <= 0` means auto-lock is off. */
export function shouldAutoLock(msSinceActivity: number, minutes: number | undefined): boolean {
    if (!minutes || minutes <= 0) return false;
    return msSinceActivity >= minutes * 60_000;
}
