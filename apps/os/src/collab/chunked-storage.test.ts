// @vitest-environment node
import { describe, expect, it } from "vite-plus/test";
import type { OtAuthorityStorage } from "./ot/authority";
import { ChunkedRoomStorage } from "./chunked-storage";

function harness() {
	const values = new Map<string, unknown>();
	const raw: OtAuthorityStorage = {
		get: async <T>(key: string) => values.get(key) as T | undefined,
		list: async <T>({ prefix }: { prefix: string }) =>
			new Map([...values].filter(([key]) => key.startsWith(prefix))) as Map<
				string,
				T
			>,
		put: async (key, value) => {
			expect(JSON.stringify(value).length * 2 + key.length * 2).toBeLessThan(
				2 * 1024 * 1024,
			);
			values.set(key, structuredClone(value));
		},
		delete: async (key) => {
			values.delete(key);
		},
	};
	return { values, raw, storage: new ChunkedRoomStorage(raw) };
}

describe("chunked room storage", () => {
	it("reads legacy bases and rows and preserves opaque client keys", async () => {
		const { values, storage } = harness();
		values.set("ot:base", { revision: 0, files: [["document", "legacy"]] });
		values.set("ot:row:000000000001", { revision: 1 });
		values.set("ot:client:opaque:chunk:user", { seq: 1 });
		expect(await storage.get("ot:base")).toEqual(values.get("ot:base"));
		expect(await storage.list({ prefix: "ot:row:" })).toEqual(
			new Map([["ot:row:000000000001", { revision: 1 }]]),
		);
		expect((await storage.list({ prefix: "ot:client:" })).size).toBe(1);
	});

	it("round-trips escaped Unicode, overwrites and shrinks without retaining parts", async () => {
		const { values, raw, storage } = harness();
		const base = {
			revision: 0,
			files: [["document", '界😀\\\n\"'.repeat(300_000)]],
		};
		await storage.put("ot:base", base);
		let woke = new ChunkedRoomStorage(raw);
		expect(await woke.get("ot:base")).toEqual(base);
		await woke.put("ot:base", {
			revision: 1,
			files: [["document", "x".repeat(300_000)]],
		});
		woke = new ChunkedRoomStorage(raw);
		expect(await woke.get("ot:base")).toEqual({
			revision: 1,
			files: [["document", "x".repeat(300_000)]],
		});
		await woke.put("ot:base", { revision: 2, files: [] });
		expect([...values.keys()]).toEqual(["ot:base"]);
		expect(await woke.get("ot:base")).toEqual({ revision: 2, files: [] });
	});

	it("rehydrates chunked rows and removes all their parts when pruned", async () => {
		const { values, raw, storage } = harness();
		const key = "ot:row:000000000001";
		const row = {
			revision: 1,
			change: [["document", { set: "x".repeat(1_850_000) }]],
		};
		await storage.put(key, row);
		const woke = new ChunkedRoomStorage(raw);
		expect(await woke.list({ prefix: "ot:row:" })).toEqual(
			new Map([[key, row]]),
		);
		await woke.delete(key);
		expect(values.size).toBe(0);
	});

	it("refuses an incomplete record instead of returning partial content", async () => {
		const { values, storage } = harness();
		await storage.put("ot:base", {
			files: [["document", "x".repeat(300_000)]],
		});
		values.delete("ot:base:chunk:1");
		await expect(storage.get("ot:base")).rejects.toThrow(
			"incomplete stored record",
		);
	});
});
