import { describe, expect, test, vi } from "vite-plus/test";

import {
	fetchWithTenantLoaderRecovery,
	TenantLoaderRecovery,
} from "./tenant-loader-recovery";

const cloneError = () =>
	new Error(
		"Unable to deserialize cloned data due to invalid or unsupported version.",
	);

describe("tenant Worker Loader recovery", () => {
	test("retires a poisoned isolate, replays a bodyless GET once, then uses the fresh identity", async () => {
		const recovery = new TenantLoaderRecovery();
		const keys: string[] = [];
		const warn = vi.fn();
		const load = (key: string) => ({
			async fetch() {
				keys.push(key);
				if (key === "tenant@v1") throw cloneError();
				return new Response("ok");
			},
		});

		const request = new Request("https://tenant.example/");
		expect(
			await (
				await fetchWithTenantLoaderRecovery(
					request,
					"tenant@v1",
					recovery,
					load,
					warn,
				)
			).text(),
		).toBe("ok");
		expect(
			await (
				await fetchWithTenantLoaderRecovery(
					new Request("https://tenant.example/"),
					"tenant@v1",
					recovery,
					load,
					warn,
				)
			).text(),
		).toBe("ok");
		expect(keys).toEqual([
			"tenant@v1",
			"tenant@v1#recovery:1",
			"tenant@v1#recovery:1",
		]);
		expect(warn).toHaveBeenCalledTimes(1);
	});

	test("a POST is not replayed, but the next request uses a fresh identity", async () => {
		const recovery = new TenantLoaderRecovery();
		const keys: string[] = [];
		const warn = vi.fn();
		const load = (key: string) => ({
			async fetch() {
				keys.push(key);
				if (key === "tenant@v1") throw cloneError();
				return new Response("ok");
			},
		});

		await expect(
			fetchWithTenantLoaderRecovery(
				new Request("https://tenant.example/", {
					method: "POST",
					body: "write",
				}),
				"tenant@v1",
				recovery,
				load,
				warn,
			),
		).rejects.toThrow("Unable to deserialize cloned data");
		expect(
			await (
				await fetchWithTenantLoaderRecovery(
					new Request("https://tenant.example/"),
					"tenant@v1",
					recovery,
					load,
					warn,
				)
			).text(),
		).toBe("ok");
		expect(keys).toEqual(["tenant@v1", "tenant@v1#recovery:1"]);
		expect(warn).not.toHaveBeenCalled();
	});

	test("a late failure from an old generation cannot retire a recovered identity", () => {
		const recovery = new TenantLoaderRecovery();
		const old = recovery.snapshot("tenant@v1");
		recovery.retire("tenant@v1", old.generation);
		recovery.retire("tenant@v1", old.generation);
		expect(recovery.snapshot("tenant@v1").key).toBe("tenant@v1#recovery:1");
	});

	test("unrelated errors remain single-shot", async () => {
		const recovery = new TenantLoaderRecovery();
		const warn = vi.fn();
		const load = vi.fn(() => ({
			async fetch(): Promise<Response> {
				throw new Error("tenant render failed");
			},
		}));
		await expect(
			fetchWithTenantLoaderRecovery(
				new Request("https://tenant.example/"),
				"tenant@v1",
				recovery,
				load,
				warn,
			),
		).rejects.toThrow("tenant render failed");
		expect(load).toHaveBeenCalledTimes(1);
		expect(recovery.snapshot("tenant@v1").key).toBe("tenant@v1");
		expect(warn).not.toHaveBeenCalled();
	});
});
