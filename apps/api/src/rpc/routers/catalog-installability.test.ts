/**
 * Installability derivation — the `service_connector` (brokered) state.
 *
 * Store-brokered connectors (e.g. GitHub's ChatGPT SERVICE connector) publish
 * no public MCP endpoint and must surface as a distinct, non-installable state
 * rather than a generic listing.
 */

import { describe, expect, it } from "vite-plus/test";
import { calculateCatalogInstallability } from "./catalog";

describe("calculateCatalogInstallability — service_connector", () => {
	it("classifies a no-endpoint SERVICE connector as service_connector", () => {
		const result = calculateCatalogInstallability({
			status: "ENABLED",
			connectorType: "SERVICE",
			baseUrl: null,
			mcpEndpointNormalized: null,
			mcpToolCount: 0,
		});
		expect(result.installable).toBe(false);
		expect(result.state).toBe("service_connector");
	});

	it("keeps FIRST_PARTY_ECOSYSTEM umbrellas as listing_only", () => {
		const result = calculateCatalogInstallability({
			status: "ENABLED",
			connectorType: "FIRST_PARTY_ECOSYSTEM",
			baseUrl: null,
			mcpEndpointNormalized: null,
			mcpToolCount: 0,
		});
		expect(result.state).toBe("listing_only");
	});

	it("does not mark a SERVICE connector that has an endpoint as service_connector", () => {
		const result = calculateCatalogInstallability(
			{
				status: "ENABLED",
				connectorType: "SERVICE",
				baseUrl: "https://api.example.com/mcp",
				mcpEndpointNormalized: "https://api.example.com/mcp",
				mcpToolCount: 3,
			},
			null,
		);
		expect(result.state).not.toBe("service_connector");
	});

	it("still reports a real MCP app with a prepared base app as installable", () => {
		const result = calculateCatalogInstallability(
			{
				status: "ENABLED",
				connectorType: "MCP",
				baseUrl: "https://api.githubcopilot.com/mcp",
				mcpEndpointNormalized: "https://api.githubcopilot.com/mcp",
				mcpToolCount: 44,
			},
			{ metadata: {} } as never,
		);
		expect(result.installable).toBe(true);
		expect(result.state).toBe("installable");
	});
});
