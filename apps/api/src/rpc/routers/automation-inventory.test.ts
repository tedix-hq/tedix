import { createRouterClient } from "@orpc/server";
import { expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import { organizationsContractRouter } from "./organizations";

const mocks = vi.hoisted(() => ({ inventory: vi.fn() }));
vi.mock("@tedix/db/queries/automation-inventory", () => ({
	listAutomationInventory: mocks.inventory,
}));

it("restricts inventory to platform admins before querying and preserves the bounded page", async () => {
	const base = {
		db: {},
		env: { ENVIRONMENT: "test" },
		headers: new Headers(),
		url: new URL("https://api.example.test/rpc"),
		authType: "user",
	};
	const client = (roles: string[]) =>
		createRouterClient(organizationsContractRouter, {
			context: {
				...base,
				user: { sub: "u", roles, permissions: ["settings:manage"] },
			} as unknown as BaseContext,
		});
	await expect(
		client(["org-admin"]).listAutomationInventory({}),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
	expect(mocks.inventory).not.toHaveBeenCalled();
	mocks.inventory.mockResolvedValue({ organizations: [], nextCursor: null });
	await expect(
		client(["platform-admin"]).listAutomationInventory({ after: "a" }),
	).resolves.toEqual({ organizations: [], nextCursor: null });
	expect(mocks.inventory).toHaveBeenCalledWith(expect.anything(), {
		after: "a",
		limit: 1,
	});
	await expect(
		client(["platform-admin"]).listAutomationInventory({ limit: 6 }),
	).rejects.toMatchObject({ code: "BAD_REQUEST" });
});
