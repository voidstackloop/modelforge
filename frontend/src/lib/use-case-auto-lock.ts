import { useEffect } from "react";
import { ENCRYPTION_STATUS_CHANGED_EVENT, CASE_LOCKED_EVENT, shouldAutoLock } from "./case-auto-lock";

const ACTIVITY_EVENTS = ["mousemove", "mousedown", "keydown", "touchstart", "scroll", "wheel"] as const;
// Checking every 30s rather than setting one long setTimeout means a laptop
// sleep/wake doesn't leave a stale timer that never fires (setTimeout delays
// don't advance while the OS is suspended in a way that's reliable across
// platforms) — polling against wall-clock "time since last activity" is
// simple and self-correcting instead.
const POLL_INTERVAL_MS = 30_000;

/** Mounted once at the app shell: arms an inactivity timer that locks
 * case-encryption (if enabled) after the user-configured number of minutes.
 * A no-op whenever encryption isn't enabled — nothing to lock, nothing to
 * poll for. Re-checks whenever encryption/settings state changes elsewhere
 * (e.g. the user just turned encryption on in Settings) via a custom event,
 * rather than only once at mount. */
export function useCaseAutoLock(): void {
    useEffect(() => {
        if (typeof window === "undefined" || !window.api) return;

        let lastActivityAt = Date.now();
        let minutes: number | undefined;
        let encryptionEnabled = false;
        let pollId: number | null = null;

        function onActivity() {
            lastActivityAt = Date.now();
        }

        async function checkAndLock() {
            if (!encryptionEnabled) return;
            if (shouldAutoLock(Date.now() - lastActivityAt, minutes)) {
                const status = await window.api.encryption.status();
                if (status.enabled && status.unlocked) {
                    await window.api.encryption.lock();
                    window.dispatchEvent(new Event(CASE_LOCKED_EVENT));
                }
            }
        }

        async function refreshConfig() {
            const [settings, status] = await Promise.all([window.api.settings.get(), window.api.encryption.status()]);
            minutes = settings.caseAutoLockMinutes ?? 15;
            encryptionEnabled = status.enabled;
            lastActivityAt = Date.now();
        }

        refreshConfig();
        for (const evt of ACTIVITY_EVENTS) window.addEventListener(evt, onActivity, { passive: true });
        window.addEventListener(ENCRYPTION_STATUS_CHANGED_EVENT, refreshConfig);
        pollId = window.setInterval(checkAndLock, POLL_INTERVAL_MS);

        return () => {
            for (const evt of ACTIVITY_EVENTS) window.removeEventListener(evt, onActivity);
            window.removeEventListener(ENCRYPTION_STATUS_CHANGED_EVENT, refreshConfig);
            if (pollId !== null) window.clearInterval(pollId);
        };
    }, []);
}
