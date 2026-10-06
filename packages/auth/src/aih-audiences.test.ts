import { describe, expect, it } from "vite-plus/test";
import {
	buildTedixMcpAuthorizationAudiences,
	buildTedixMcpResourceUri,
	parseTedixMcpAudience,
	reconcileTedixMcpOwnershipTags,
} from "./aih-audiences";

describe("Tedix MCP audiences", () => {
	it("uses one canonical production URI for every managed app", () => {
		expect(buildTedixMcpResourceUri("acme")).toBe(
			"https://acme.mcp.tedix.dev/mcp",
		);
		expect(buildTedixMcpAuthorizationAudiences("acme")).toEqual([
			"https://acme.mcp.tedix.dev/mcp",
		]);
	});

	it.each([
		["https://acme.mcp.tedix.dev/mcp", "production"],
		["https://acme.mcp.tedix.tech/mcp", "development"],
	] as const)("parses %s as %s", (audience, surface) => {
		expect(parseTedixMcpAudience(audience)).toEqual({
			slug: "acme",
			surface,
		});
	});

	it("no longer recognises the retired staging surface", () => {
		expect(parseTedixMcpAudience("https://acme.mcp.tedi.club/mcp")).toBe(null);
	});

	it.each([
		"http://acme.mcp.tedix.dev/mcp",
		"https://*.mcp.tedix.dev/mcp",
		"https://acme.mcp.tedix.dev",
		"https://acme.mcp.tedix.dev/mcp/",
		"https://acme.mcp.tedix.dev/mcp?tenant=other",
		"https://acme.mcp.tedix.dev/other",
		"https://acme.mcp.tedix.com/mcp",
		"https://nested.acme.mcp.tedix.dev/mcp",
		"https://Acme.mcp.tedix.dev/mcp",
	])("rejects non-canonical audience %s", (audience) => {
		expect(parseTedixMcpAudience(audience)).toBeNull();
	});

	it.each(["", "Acme", "ac_me", "-acme", "acme-", "a".repeat(64)])(
		"rejects invalid app slug %s",
		(slug) => {
			expect(() => buildTedixMcpResourceUri(slug)).toThrow(
				`Invalid MCP app slug: ${slug}`,
			);
		},
	);
});

describe("Tedix MCP ownership tags", () => {
	it("replaces owned keys while preserving unrelated tags", () => {
		expect(
			reconcileTedixMcpOwnershipTags(
				[
					"provider:descope",
					"managed-by:manual",
					"resource:legacy",
					"environment:production",
					"app:old",
					"operator:ada",
				],
				{ app: "acme" },
			),
		).toEqual([
			"provider:descope",
			"operator:ada",
			"managed-by:tedix",
			"resource:mcp-app",
			"environment:shared",
			"app:acme",
		]);
	});

	it("is idempotent", () => {
		const first = reconcileTedixMcpOwnershipTags(["custom:keep"], {
			app: "tedix-unified",
		});
		expect(
			reconcileTedixMcpOwnershipTags(first, { app: "tedix-unified" }),
		).toEqual(first);
	});
});
