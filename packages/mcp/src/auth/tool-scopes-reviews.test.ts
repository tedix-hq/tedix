import { describe, expect, it } from "vite-plus/test";
import {
	resolveMcpToolRequiredScopes,
	isMcpToolVisibleToCaller,
} from "./tool-scopes";
describe("review RPC capability projection", () => {
	for (const [verb, scope] of [
		["create", "mcp:apps.write"],
		["get", "mcp:apps.read"],
		["listFeedback", "mcp:apps.write"],
		["saveFeedback", "mcp:apps.write"],
	] as const) {
		it(`retains exact ${verb} capability through organization aliases`, () => {
			const tool = {
				toolId: "review_alias",
				toolTypeId: "rpc",
				authRequired: true,
				config: { endpoint: `osShares/reviews/${verb}` },
			};
			expect(resolveMcpToolRequiredScopes(tool, "example_org", {})).toEqual([
				scope,
			]);
			expect(
				isMcpToolVisibleToCaller(
					tool,
					"example_org",
					{},
					{ authType: "oauth", scopes: [scope] },
				),
			).toBe(true);
			expect(
				isMcpToolVisibleToCaller(
					tool,
					"example_org",
					{},
					{ authType: "oauth", scopes: ["mcp:tedis.read"] },
				),
			).toBe(false);
		});
	}
	it("does not grant arbitrary sibling review operations", () => {
		expect(() =>
			resolveMcpToolRequiredScopes(
				{
					toolId: "unmapped",
					toolTypeId: "rpc",
					authRequired: true,
					config: { endpoint: "osShares/reviews/execute" },
				},
				"example_org",
				{},
			),
		).toThrow("Missing MCP capability mapping");
	});
});
