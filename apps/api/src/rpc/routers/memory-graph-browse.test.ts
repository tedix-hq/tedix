import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";

const mocks = vi.hoisted(() => ({ browseMemory: vi.fn() }));
vi.mock("@tedix/db/queries/memory-graph/browse", () => mocks);

async function client(
	authType: "user" | "tedi" | "apikey" = "user",
	tediId?: string,
	scopes = ["mcp:memory.read"],
) {
	const { browse } = await import("./memory-graph/observations");
	const context = {
		authType,
		tediId,
		db: {},
		env: { ENVIRONMENT: "test" },
		headers: new Headers(),
		organizationId: "orchard",
		tediScopes: scopes,
		apiKey: { scopes },
		url: new URL("https://api.orchard.test/rpc/memoryGraph"),
		user: {
			aud: "test",
			dct: "orchard",
			exp: 2,
			iat: 1,
			iss: "https://auth.orchard.test",
			permissions: ["tedis:read"],
			roles: [],
			sub: "user-orchard",
		},
	} as unknown as BaseContext;
	return createRouterClient({ browse }, { context });
}

beforeEach(() => {
	mocks.browseMemory.mockReset();
	mocks.browseMemory.mockResolvedValue({ facts: [], nextOffset: null });
});
describe("Memory browser authorization and projection", () => {
	it("binds the authenticated org and tedi, never a caller-selected scope", async () => {
		await (await client("tedi", "self")).browse({ view: "stale" });
		expect(mocks.browseMemory).toHaveBeenCalledWith(
			{},
			expect.objectContaining({
				orgId: "orchard",
				tediId: "self",
				view: "stale",
				limit: 20,
				offset: 0,
			}),
		);
	});
	it("rejects an unbound tedi before reading", async () => {
		await expect(
			(await client("tedi")).browse({ view: "stale" }),
		).rejects.toThrow("Authenticated tedi identity is required");
		expect(mocks.browseMemory).not.toHaveBeenCalled();
	});
	it("requires the memory-read machine scope", async () => {
		await expect(
			(await client("apikey", undefined, [])).browse({ view: "stale" }),
		).rejects.toThrow("Scope 'mcp:memory.read' required");
		expect(mocks.browseMemory).not.toHaveBeenCalled();
	});
	it("removes a redundant summary at the API boundary and preserves full content", async () => {
		mocks.browseMemory.mockResolvedValue({
			facts: [
				{
					id: "fact",
					organizationId: "orchard",
					content: "Discover the namespace first.",
					summary: "  Discover the namespace first.\n",
					factType: "technical",
					confidence: 0.9,
					accessCount: 1,
					usageCount: 0,
				},
			],
			nextOffset: null,
		});
		const result = await (await client()).browse({ view: "observations" });
		expect(result.facts[0]).toMatchObject({
			summary: null,
			content: "Discover the namespace first.",
		});
	});
});
