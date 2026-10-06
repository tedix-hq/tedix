import { describe, expect, it } from "vite-plus/test";
import {
	NAMESPACE_PEER_ALIASES,
	namespaceGovernanceFor,
	RESERVED_MCP_NAMESPACES,
} from "./namespace-governance";

describe("MCP namespace governance", () => {
	it("keeps peer aliases symmetric and reserved", () => {
		for (const [namespace, alias] of NAMESPACE_PEER_ALIASES) {
			expect(NAMESPACE_PEER_ALIASES.get(alias)).toBe(namespace);
			expect(RESERVED_MCP_NAMESPACES.has(namespace)).toBe(true);
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
