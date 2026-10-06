import { describe, expect, it } from "vite-plus/test";
import { buildWwwAuthenticate } from "./middleware";

describe("buildWwwAuthenticate", () => {
	it("escapes backslashes and quotes inside quoted-string parameters", () => {
		const header = buildWwwAuthenticate(
			"mcp.example.com",
			"invalid_token",
			'bad \\" token',
			['a\\"b', "c"],
		);
		expect(header).toBe(
			'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource", error="invalid_token", error_description="bad \\\\\\" token", scope="a\\\\\\"b c"',
		);
	});
});
