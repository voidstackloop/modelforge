// A minimal Storage implementation backed by a plain Map instead of a real
// browser storage — used to hold oidc-client-ts's issued tokens (access_token/
// refresh_token) in memory only, lost on reload. Re-login is required after a
// refresh/tab close; this is the deliberate v1 trade-off (see oidc-config.ts).
export class InMemoryWebStorage implements Storage {
    private readonly data = new Map<string, string>();

    get length(): number {
        return this.data.size;
    }

    clear(): void {
        this.data.clear();
    }

    getItem(key: string): string | null {
        return this.data.get(key) ?? null;
    }

    key(index: number): string | null {
        return [...this.data.keys()][index] ?? null;
    }

    removeItem(key: string): void {
        this.data.delete(key);
    }

    setItem(key: string, value: string): void {
        this.data.set(key, value);
    }
}
