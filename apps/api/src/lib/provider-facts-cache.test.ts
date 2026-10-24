import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const provider = vi.hoisted(() => ({
	registrations: new Map<string, { id: string; approvedScopes: string[] }>(),
	load: vi.fn(async (_env: unknown, id: string) =>
		provider.registrations.get(id),
	),
	update: vi.fn(
		async (_env: unknown, server: { id: string; approvedScopes: string[] }) => {
			provider.registrations.set(server.id, server);
			return server;
		},
	),
	remove: vi.fn(async (_env: unknown, id: string) => {
		provider.registrations.delete(id);
	}),
}));

vi.mock("@tedix/auth/aih-client", () => ({
	loadDescopeMcpServer: provider.load,
	updateDescopeMcpServer: provider.update,
	deleteDescopeMcpServer: provider.remove,
}));

import {
	deleteMcpServerRegistration,
	forgetMcpServerRegistrations,
	loadMcpServerRegistration,
	updateMcpServerRegistration,
} from "./provider-facts-cache";

const env = {} as Parameters<typeof loadMcpServerRegistration>[0];

describe("MCP server registration cache", () => {
	beforeEach(() => {
		forgetMcpServerRegistrations();
		provider.registrations.clear();
		provider.registrations.set("srv-1", {
			id: "srv-1",
			approvedScopes: ["tedis:read", "tedis:write"],
		});
		provider.load.mockClear();
	});

	it("serves a remembered registration without asking the provider again", async () => {
		await loadMcpServerRegistration(env, "srv-1");
		await loadMcpServerRegistration(env, "srv-1");
		expect(provider.load).toHaveBeenCalledTimes(1);
	});

	it("forgets a registration this isolate updated, so the next read sees the new scopes", async () => {
		const before = await loadMcpServerRegistration(env, "srv-1");
		expect(before?.approvedScopes).toEqual(["tedis:read", "tedis:write"]);
		await updateMcpServerRegistration(env, {
			id: "srv-1",
			approvedScopes: ["tedis:read"],
		} as Parameters<typeof updateMcpServerRegistration>[1]);
		const after = await loadMcpServerRegistration(env, "srv-1");
		expect(after?.approvedScopes).toEqual(["tedis:read"]);
		expect(provider.load).toHaveBeenCalledTimes(2);
	});

	it("forgets a registration even when the provider write fails", async () => {
		await loadMcpServerRegistration(env, "srv-1");
		provider.update.mockRejectedValueOnce(new Error("provider down"));
		await expect(
			updateMcpServerRegistration(env, {
				id: "srv-1",
				approvedScopes: [],
			} as Parameters<typeof updateMcpServerRegistration>[1]),
		).rejects.toThrow("provider down");
		await loadMcpServerRegistration(env, "srv-1");
		expect(provider.load).toHaveBeenCalledTimes(2);
	});

	it("forgets a deleted registration", async () => {
		await loadMcpServerRegistration(env, "srv-1");
		await deleteMcpServerRegistration(env, "srv-1");
		expect(await loadMcpServerRegistration(env, "srv-1")).toBeUndefined();
	});

	it.each(["update", "failed update", "delete", "forget", "forget all"])(
		"does not cache an old lookup that finishes after %s",
		async (action) => {
			const original = provider.registrations.get("srv-1")!;
			let finish!: (value: typeof original) => void;
			provider.load.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						finish = resolve;
					}),
			);
			const pending = loadMcpServerRegistration(env, "srv-1");
			const replacement = { ...original, approvedScopes: ["tedis:read"] };
			provider.registrations.set("srv-1", replacement);
			if (action === "update") {
				await updateMcpServerRegistration(
					env,
					replacement as Parameters<typeof updateMcpServerRegistration>[1],
				);
			} else if (action === "failed update") {
				provider.update.mockRejectedValueOnce(new Error("provider down"));
				await expect(
					updateMcpServerRegistration(
						env,
						replacement as Parameters<typeof updateMcpServerRegistration>[1],
					),
				).rejects.toThrow("provider down");
			} else if (action === "delete") {
				await deleteMcpServerRegistration(env, "srv-1");
			} else {
				forgetMcpServerRegistrations(action === "forget" ? "srv-1" : undefined);
			}
			finish(original);
			expect(await pending).toBe(original);
			expect(await loadMcpServerRegistration(env, "srv-1")).toEqual(
				provider.registrations.get("srv-1"),
			);
			expect(provider.load).toHaveBeenCalledTimes(2);
		},
	);
});
