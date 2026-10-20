import { describe, expect, it } from "vite-plus/test";
import { stripRedundantApiKeyHeader } from "./auth-helpers";
describe("MCP credential header hygiene", () => {
	it("forwards the bearer and body without a competing bootstrap header", async () => {
		const request = new Request("https://example.mcp.tedix.dev/mcp", {
			method: "POST",
			headers: {
				Authorization: "Bearer fixture-bearer",
				"x-api-key": "sk_fictional_bootstrap",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
		});
		const forwarded = stripRedundantApiKeyHeader(request);
		expect(forwarded.headers.get("Authorization")).toBe(
			"Bearer fixture-bearer",
		);
		expect(forwarded.headers.has("X-API-Key")).toBe(false);
		expect(await forwarded.json()).toMatchObject({
			method: "tools/list",
			id: 1,
		});
	});
	const singleCredentialHeaders: Record<string, string>[] = [
		{ Authorization: "Bearer fixture" },
		{ "X-API-Key": "sk_fictional_fallback" },
		{},
	];
	it.each(singleCredentialHeaders)(
		"preserves existing single-credential paths %j",
		(headers) => {
			const request = new Request("https://example.mcp.tedix.dev/mcp", {
				headers,
			});
			expect(stripRedundantApiKeyHeader(request)).toBe(request);
		},
	);
	it("does not fall back to a key when an empty Authorization header is present", () => {
		expect(
			stripRedundantApiKeyHeader(
				new Request("https://example.mcp.tedix.dev/mcp", {
					headers: { Authorization: "", "X-API-Key": "sk_fictional" },
				}),
			).headers.has("X-API-Key"),
		).toBe(false);
	});
});
