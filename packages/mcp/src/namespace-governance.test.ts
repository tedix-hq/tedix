import { describe, expect, it } from "vite-plus/test";
import { namespaceGovernanceFor } from "./namespace-governance";

describe("MCP namespace governance", () => {
	it("makes reserved namespaces win and dynamic app namespaces collide", () => {
		expect(namespaceGovernanceFor("discover")).toMatchObject({
			owner: "mcp-platform",
			class: "discovery",
			collisionPolicy: "reserved_wins",
		});
		expect(namespaceGovernanceFor("firecrawl")).toMatchObject({
			owner: "app-config",
			class: "tenant_app",
			freshness: "d1_config",
			collisionPolicy: "reject_duplicate",
		});
	});
});
