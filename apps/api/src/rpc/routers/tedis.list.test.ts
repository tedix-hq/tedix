import { createRouterClient } from "@orpc/server";
import { describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";

const mocks = vi.hoisted(() => ({ listTediRoster: vi.fn() }));

vi.mock("@tedix/db/queries/tedis", async (original) => ({
	...(await original<Record<string, unknown>>()),
	listTediRoster: mocks.listTediRoster,
}));

import { listTedis } from "./tedis/crud";

describe("tedi list search and paging", () => {
	it("forwards tenant-scoped filters and reports the matching total", async () => {
		mocks.listTediRoster.mockResolvedValueOnce({ data: [], total: 75 });
		const context = {
			authType: "user",
			db: {} as BaseContext["db"],
			env: { ENVIRONMENT: "test" } as CloudflareEnv,
			headers: new Headers(),
			organizationId: "22222222-2222-4222-8222-222222222222",
			url: new URL("https://api.tedix.test/rpc/tedis"),
			user: {
				aud: "test",
				dct: "tenant-1",
				exp: 2,
				iat: 1,
				iss: "https://auth.tedix.test",
				permissions: ["tedis:read"],
				roles: [],
				sub: "user-1",
			},
		} as BaseContext;
		const client = createRouterClient({ list: listTedis }, { context });
		const result = await client.list({
			limit: 50,
			offset: 50,
			search: " Engineering Lead ",
			status: "active",
		});

		expect(mocks.listTediRoster).toHaveBeenCalledWith(context.db, {
			organizationId: context.organizationId,
			limit: 50,
			offset: 50,
			includeRetired: false,
			search: "Engineering Lead",
			status: "active",
		});
		expect(result.pagination).toEqual({
			limit: 50,
			offset: 50,
			total: 75,
			hasMore: false,
		});
	});
});
