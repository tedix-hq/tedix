import { afterEach, describe, expect, it } from "vite-plus/test";
import {
	readBrandingSnapshot,
	writeBrandingSnapshot,
} from "./branding-snapshot";

function useStorage(storage: unknown) {
	Object.defineProperty(globalThis, "localStorage", {
		value: storage,
		configurable: true,
	});
}

function memoryStorage(seed: Record<string, string> = {}) {
	const map = new Map(Object.entries(seed));
	return {
		getItem: (key: string) => map.get(key) ?? null,
		setItem: (key: string, value: string) => void map.set(key, value),
		removeItem: (key: string) => void map.delete(key),
		map,
	};
}

afterEach(() => {
	useStorage(undefined);
});

describe("branding snapshot", () => {
	it("returns the branding it stored for that tenant and locale", () => {
		useStorage(memoryStorage());
		writeBrandingSnapshot("acme", "es-MX", { title: "Acme Bot" });
		expect(readBrandingSnapshot("acme", "es-MX")).toEqual({
			title: "Acme Bot",
		});
		// Another locale is a different published answer, not this one.
		expect(readBrandingSnapshot("acme", "de-DE")).toBeNull();
		expect(readBrandingSnapshot("other", "es-MX")).toBeNull();
	});

	it("treats unusable storage as a cache miss, never as a failure", () => {
		useStorage({
			getItem() {
				throw new Error("blocked");
			},
			setItem() {
				throw new Error("quota");
			},
			removeItem() {},
		});
		expect(() =>
			writeBrandingSnapshot("acme", "es-MX", { title: "Acme Bot" }),
		).not.toThrow();
		expect(readBrandingSnapshot("acme", "es-MX")).toBeNull();

		useStorage(undefined);
		expect(readBrandingSnapshot("acme", "es-MX")).toBeNull();
	});

	it("rejects a corrupt or wrongly shaped entry", () => {
		useStorage(
			memoryStorage({
				"tedix:branding:acme:es-MX": "{not json",
				"tedix:branding:a:-": JSON.stringify(["x"]),
				"tedix:branding:b:-": JSON.stringify("x"),
			}),
		);
		expect(readBrandingSnapshot("acme", "es-MX")).toBeNull();
		expect(readBrandingSnapshot("a", "")).toBeNull();
		expect(readBrandingSnapshot("b", "")).toBeNull();
	});

	it("stores nothing for an absent tenant or an absent answer", () => {
		const storage = memoryStorage();
		useStorage(storage);
		writeBrandingSnapshot("", "es-MX", { title: "Acme Bot" });
		writeBrandingSnapshot("acme", "es-MX", null);
		expect(storage.map.size).toBe(0);
	});
});
