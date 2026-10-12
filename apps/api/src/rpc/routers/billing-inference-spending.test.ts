import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";
const storage = vi.hoisted(() => vi.fn());
vi.mock("@tedix/db/queries/billing/spending", () => ({
	listMonetaryInferenceSpending: storage,
}));
import { billingContractRouter } from "./billing";
const org = "5eed0033-0000-4000-8000-000000000033";
function context(scopes: string[], human = false): BaseContext {
	return {
		authType: human ? "user" : "apikey",
		organizationId: org,
		userRole: scopes.length ? "owner" : "viewer",
		db: {},
		env: {
			ENVIRONMENT: "test",
			TEDIX_FLEET_AUTHORITY_MODE: "co-located",
			DB: {},
		},
		headers: new Headers(),
		url: new URL("https://api.tedix.test/rpc/billing"),
		...(human
			? { user: { sub: "owner", permissions: scopes, roles: [] } }
			: {
					apiKey: { id: "key", name: "fictional", organizationId: org, scopes },
				}),
	} as BaseContext;
}
beforeEach(() => {
	storage.mockReset();
	storage.mockResolvedValue({ rows: [], hasMore: false });
});
describe("own-organization inference spending", () => {
	it.each([false, true])(
		"requires billing read authority for human=%s",
		async (human) => {
			const client = createRouterClient(billingContractRouter, {
				context: context([], human),
			});
			await expect(
				client.getInferenceSpending({ limit: 10 }),
			).rejects.toThrow();
			expect(storage).not.toHaveBeenCalled();
		},
	);
	it.each([false, true])(
		"scopes a bounded read to the authenticated tenant for human=%s",
		async (human) => {
			const client = createRouterClient(billingContractRouter, {
				context: context(["billing:read"], human),
			});
			const r = await client.getInferenceSpending({
				limit: 10,
				organizationId: "other",
			} as { limit: number });
			expect(r.rows).toEqual([]);
			expect(storage).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({ organizationId: org, limit: 10 }),
			);
			expect(Date.parse(r.to) - Date.parse(r.from)).toBe(30 * 86400000);
		},
	);
	it("rejects an unbounded page before storage", async () => {
		const client = createRouterClient(billingContractRouter, {
			context: context(["billing:read"]),
		});
		await expect(client.getInferenceSpending({ limit: 201 })).rejects.toThrow();
		expect(storage).not.toHaveBeenCalled();
	});
});
