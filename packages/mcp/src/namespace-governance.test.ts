import { describe, expect, it } from "vite-plus/test";
import {
	namespaceGovernanceFor,
	RESERVED_MCP_NAMESPACES,
} from "./namespace-governance";

describe("MCP namespace governance", () => {
	it("keeps reserved namespaces distinct without peer aliases", () => {
		for (const namespace of ["app", "apps", "tedi", "tedis"]) {
			expect(RESERVED_MCP_NAMESPACES.has(namespace)).toBe(true);
			expect(namespaceGovernanceFor(namespace).aliases).toEqual([]);
		}
	});

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
