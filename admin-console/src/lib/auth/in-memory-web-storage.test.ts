import { describe, expect, it } from "vitest";
import { InMemoryWebStorage } from "./in-memory-web-storage";

describe("InMemoryWebStorage", () => {
    it("round-trips a stored value", () => {
        const storage = new InMemoryWebStorage();
        storage.setItem("a", "1");
        expect(storage.getItem("a")).toBe("1");
    });

    it("returns null for a key that was never set", () => {
        expect(new InMemoryWebStorage().getItem("missing")).toBeNull();
    });

    it("removeItem deletes the key", () => {
        const storage = new InMemoryWebStorage();
        storage.setItem("a", "1");
        storage.removeItem("a");
        expect(storage.getItem("a")).toBeNull();
    });

    it("clear() empties every key", () => {
        const storage = new InMemoryWebStorage();
        storage.setItem("a", "1");
        storage.setItem("b", "2");
        storage.clear();
        expect(storage.length).toBe(0);
        expect(storage.getItem("a")).toBeNull();
    });

    it("length and key(index) reflect the current contents", () => {
        const storage = new InMemoryWebStorage();
        storage.setItem("a", "1");
        storage.setItem("b", "2");
        expect(storage.length).toBe(2);
        expect([storage.key(0), storage.key(1)]).toEqual(["a", "b"]);
        expect(storage.key(2)).toBeNull();
    });

    it("does not persist across separate instances — the whole point of it", () => {
        const first = new InMemoryWebStorage();
        first.setItem("a", "1");
        expect(new InMemoryWebStorage().getItem("a")).toBeNull();
    });
});
