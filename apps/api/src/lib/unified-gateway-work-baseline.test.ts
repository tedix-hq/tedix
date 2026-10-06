import { describe, expect, it } from "vite-plus/test";
import { unifiedGatewayWorkBaselineIssues } from "./unified-gateway-work-baseline";

describe("unifiedGatewayWorkBaselineIssues", () => {
	const app = (mcpConfig: Record<string, unknown>, slug = "acme-unified") => ({
		slug,
		metadata: { mcpConfig },
	});

	it("reports missing scopes and bridge on an older unified gateway", () => {
		expect(
			unifiedGatewayWorkBaselineIssues(
				app({
					toolScopes: { content: ["mcp:content.write"] },
					aggregateTedis: [],
				}),
				"operator",
			),
		).toEqual([
			"toolScopes.work lacks mcp:work.read",
			"toolScopes.work lacks mcp:work.write",
			"aggregateTedis lacks a full operator bridge",
		]);
	});

	it("accepts the full operator baseline and ignores ordinary apps", () => {
		const config = {
			toolScopes: { work: ["mcp:work.read", "mcp:work.write"] },
			aggregateTedis: [{ slug: "operator", surface: "full" }],
		};
		expect(unifiedGatewayWorkBaselineIssues(app(config), "operator")).toEqual(
			[],
		);
		expect(
			unifiedGatewayWorkBaselineIssues(app({}, "ordinary-app"), "operator"),
		).toEqual([]);
	});
});
