/// <reference types="@cloudflare/vitest-plugin/types" />

import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

describe("real MCP Worker to API service binding", () => {
	it("turns an upstream discovery failure into a retryable public response", async () => {
		const service = (env as unknown as CloudflareEnv).API_SERVICE;
		const fixture = await service.fetch("https://api/fixture-health");
		expect(fixture.status).toBe(200);
		expect(await fixture.json()).toEqual({ fixture: "api-service" });

		const response = await SELF.fetch(
			"https://pilot.mcp.tedix.dev/.well-known/openai-apps-challenge",
		);
		expect(response.status).toBe(503);
		expect(response.headers.get("Retry-After")).toBeTruthy();
		expect(response.headers.get("Cache-Control")).toBe("private, no-store");
		expect(await response.json()).toMatchObject({
			error: "Upstream unavailable",
		});
	});
});
