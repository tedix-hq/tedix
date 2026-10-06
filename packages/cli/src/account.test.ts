import { describe, expect, test } from "bun:test";
import { listAvailableWorkspaces } from "./account";

const discovered = [
	{
		callable: "acme_unified.list_all_mine",
		tool: "list_all_mine",
		authorized: true,
		schemaFreshness: { sourceRef: "organizations/listAllMine" },
	},
];
function client(value: unknown, discovery: unknown = discovered) {
	const sources: string[] = [];
	return {
		client: {
			runCode: async (source: string) => {
				sources.push(source);
				return {
					result: source.includes("discover.search") ? discovery : value,
				};
			},
		},
		sources,
	};
}

describe("listAvailableWorkspaces", () => {
	test("reads account memberships through the MCP gateway", async () => {
		const fake = client([
			{
				organizationId: "org-1",
				organizationSlug: "acme",
				organizationName: "Acme",
				mcpGatewayUrl: "https://acme-unified.mcp.tedix.dev/mcp",
				descopeTenantId: "org_acme",
			},
		]);

		await expect(
			listAvailableWorkspaces({ client: fake.client }),
		).resolves.toEqual([
			{
				org: "org-1",
				slug: "acme",
				name: "Acme",
				gatewayUrl: "https://acme-unified.mcp.tedix.dev/mcp",
				descopeTenantId: "org_acme",
			},
		]);
		expect(fake.sources[0]).toContain("discover.search");
		expect(fake.sources[1]).toContain("acme_unified.list_all_mine");
	});

	test("accepts a data envelope and skips malformed rows", async () => {
		const fake = client({
			data: [
				{ organizationId: "org-1", organizationSlug: "acme" },
				{ organizationId: "org-2" },
			],
		});
		const original = console.error;
		console.error = () => {};
		try {
			await expect(
				listAvailableWorkspaces({ client: fake.client }),
			).resolves.toEqual([
				{
					org: "org-1",
					slug: "acme",
					name: "acme",
					gatewayUrl: null,
					descopeTenantId: null,
				},
			]);
		} finally {
			console.error = original;
		}
	});

	test("surfaces gateway rejection values", async () => {
		const fake = client({ ok: false, error: "FORBIDDEN" });
		await expect(
			listAvailableWorkspaces({ client: fake.client }),
		).rejects.toThrow("FORBIDDEN");
	});

	test("rejects unauthorized, mismatched, and invalid callable discovery before dispatch", async () => {
		for (const discovery of [
			[],
			[{ ...discovered[0], authorized: false }],
			[
				{
					...discovered[0],
					schemaFreshness: { sourceRef: "other/listAllMine" },
				},
			],
			[{ ...discovered[0], callable: "x.list_all_mine();throw new Error()" }],
		]) {
			const fake = client([], discovery);
			await expect(
				listAvailableWorkspaces({ client: fake.client }),
			).rejects.toThrow("authorized organization list");
			expect(fake.sources).toHaveLength(1);
		}
	});
});
