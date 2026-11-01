import { describe, expect, it } from "vite-plus/test";
import {
	CONSENT_KEY,
	CONSENT_VERSION,
	createConsent,
	parseConsent,
	readConsent,
	writeConsent,
} from "./consent";

function memoryStorage(initial?: Record<string, string>) {
	const store = new Map(Object.entries(initial ?? {}));
	return {
		store,
		getItem: (key: string) => store.get(key) ?? null,
		setItem: (key: string, value: string) => void store.set(key, value),
	};
}

describe("parseConsent", () => {
	it("returns null for missing or corrupt values", () => {
		expect(parseConsent(null)).toBeNull();
		expect(parseConsent("")).toBeNull();
		expect(parseConsent("not-json")).toBeNull();
		expect(parseConsent("null")).toBeNull();
		expect(parseConsent('{"version":2}')).toBeNull();
	});

	it("returns a stored record of the current version", () => {
		const record = createConsent(true);
		expect(parseConsent(JSON.stringify(record))).toEqual(record);
	});
});

describe("readConsent", () => {
	it("reads a saved record from storage", () => {
		const storage = memoryStorage({
			[CONSENT_KEY]: JSON.stringify(createConsent(true)),
		});
		expect(readConsent(storage)?.analytics).toBe(true);
	});

	it("returns null when storage throws", () => {
		const storage = {
			getItem() {
				throw new Error("denied");
			},
			setItem() {},
		};
		expect(readConsent(storage)).toBeNull();
	});
});

describe("createConsent", () => {
	it("records necessary as always true and analytics as opt-in", () => {
		const consent = createConsent(true, new Date("2026-11-01T00:00:00Z"));
		expect(consent).toEqual({
			version: CONSENT_VERSION,
			necessary: true,
			analytics: true,
			updatedAt: "2026-11-01T00:00:00.000Z",
		});
		expect(createConsent(false).analytics).toBe(false);
	});
});

describe("writeConsent", () => {
	it("persists the serialized record under the consent key", () => {
		const storage = memoryStorage();
		const consent = createConsent(false);
		writeConsent(storage, consent);
		expect(storage.store.get(CONSENT_KEY)).toBe(JSON.stringify(consent));
	});

	it("swallows storage failures", () => {
		const storage = {
			getItem: () => null,
			setItem() {
				throw new Error("denied");
			},
		};
		expect(() => writeConsent(storage, createConsent(false))).not.toThrow();
	});
});
