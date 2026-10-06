import { describe, expect, it } from "vite-plus/test";

import { loadServiceKey, storeServiceKey } from "./service-key-storage";

describe("CMS service key storage", () => {
	it("reads a key rotated by another Worker isolate", async () => {
		const objects = new Map<string, string>();
		const storage = {
			get: async (key: string) => {
				const value = objects.get(key);
				return value === undefined ? null : { text: async () => value };
			},
			put: async (key: string, value: string) => {
				objects.set(key, value);
			},
		} as unknown as R2Bucket;

		await storeServiceKey(storage, "tedix-landing", "ec_pat_old");
		expect(await loadServiceKey(storage, "tedix-landing", {})).toBe(
			"ec_pat_old",
		);

		// A different isolate writes the shared R2 object. This isolate must not
		// continue forwarding the old credential from process memory.
		objects.set("_cms-service-keys/tedix-landing", "ec_pat_new");
		expect(await loadServiceKey(storage, "tedix-landing", {})).toBe(
			"ec_pat_new",
		);
	});
});
