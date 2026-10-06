import { describe, expect, it } from "vite-plus/test";
import {
	isCmsControlMcpEndpoint,
	selectCatalogInstallCandidate,
} from "./install-scan";

describe("selectCatalogInstallCandidate", () => {
	it("prefers an exact catalog alias over an earlier broad prose match", () => {
		const generic = {
			name: "CB Insights",
			keywordsForDiscovery: null,
			keywordsForTriggering: null,
		};
		const microsoft = {
			name: "Microsoft 365",
			keywordsForDiscovery: ["outlook", "microsoft outlook"],
			keywordsForTriggering: ["install outlook"],
		};

		expect(selectCatalogInstallCandidate("Outlook", [generic, microsoft])).toBe(
			microsoft,
		);
	});

	it("preserves relevance order when no exact alias exists", () => {
		const first = {
			name: "First",
			keywordsForDiscovery: ["calendar search"],
			keywordsForTriggering: null,
		};
		const second = {
			name: "Second",
			keywordsForDiscovery: null,
			keywordsForTriggering: ["calendar helper"],
		};

		expect(selectCatalogInstallCandidate("calendar", [first, second])).toBe(
			first,
		);
		expect(selectCatalogInstallCandidate("calendar", [])).toBeNull();
	});
});

describe("CMS control MCP endpoint", () => {
	it.each([
		"https://builder.tedix.dev/mcp",
		"https://builder.tedix.dev/mcp?org=tedix",
	])("accepts canonical Site Builder endpoints: %s", (endpoint) => {
		expect(isCmsControlMcpEndpoint(endpoint)).toBe(true);
	});

	it.each([
		"http://builder.tedix.dev/mcp",
		"https://studio.tedix.dev/mcp",
		"https://builder.tedix.dev/not-mcp",
		"https://builder.tedix.dev.attacker.example/mcp",
	])("rejects an untrusted Site Builder endpoint: %s", (endpoint) => {
		expect(isCmsControlMcpEndpoint(endpoint)).toBe(false);
	});
});
