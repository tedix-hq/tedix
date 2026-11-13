import { describe, expect, it } from "vite-plus/test";
import { exactEgressFetchUrl } from "./exact-egress-fetch";
import type { ToolConfig } from "@tedix/api-contract/schemas/tools";

const config: ToolConfig = {
	transport: "external",
	method: "GET",
	baseUrl: "https://example.com",
	endpoint: "page",
};

describe("exact fetch destinations", () => {
	it("includes the full encoded query rather than granting a host", () => {
		expect(exactEgressFetchUrl(config, { q: "private & data" })).toBe(
			"https://example.com/page?q=private+%26+data",
		);
	});
	it.each([
		{ method: "POST" },
		{ transport: "code" },
		{ baseUrl: "https://127.0.0.1" },
		{ baseUrl: "http://example.com" },
		{ baseUrl: "https://user:password@example.com" },
		{ baseUrl: "https://example.com?secret=1" },
		{ endpoint: "{path}" },
		{ staticHeaders: { Authorization: "secret" } },
		{ "x-mcp-header": { "X-Key": "{secret}" } },
		{ paramMap: { url: "target" } },
		{ bodyEncoding: "gmail_rfc5322" },
	])(
		"refuses an ambiguous, credential-bearing or unsafe request: %j",
		(extension) => {
			expect(
				exactEgressFetchUrl({ ...config, ...extension } as ToolConfig, {}),
			).toBeNull();
		},
	);
});
