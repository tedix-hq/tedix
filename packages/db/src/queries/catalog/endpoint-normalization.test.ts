import { describe, expect, it } from "vite-plus/test";
import { normalizeMcpEndpoint } from "./endpoint-normalization";

describe("normalizeMcpEndpoint", () => {
	it("preserves and sorts query parameters that route an MCP endpoint", () => {
		expect(
			normalizeMcpEndpoint(
				"http://DOCS-ADMIN.TEDIX.DEV/mcp/?site=public&org=tedix#ignored",
			),
		).toBe("https://docs-admin.tedix.dev/mcp?org=tedix&site=public");
	});

	it("keeps endpoint identities distinct when their tenant selector differs", () => {
		expect(normalizeMcpEndpoint("https://example.com/mcp?org=tedix")).not.toBe(
			normalizeMcpEndpoint("https://example.com/mcp?org=acme"),
		);
	});
});
