import { describe, expect, it } from "vite-plus/test";
import { UpdateCatalogAppInputSchema } from "./catalog.ts";

describe("UpdateCatalogAppInputSchema", () => {
	it("accepts an explicit catalog authentication-mode replacement", () => {
		const input = UpdateCatalogAppInputSchema.parse({
			id: "5eed0025-0000-4000-8000-000000000025",
			baseUrl: "https://mcp.firecrawl.dev/v2/mcp-oauth",
			authTypes: ["OAUTH"],
		});

		expect(input.authTypes).toEqual(["OAUTH"]);
	});

	it("rejects an empty authentication-mode replacement", () => {
		expect(() =>
			UpdateCatalogAppInputSchema.parse({
				id: "5eed0025-0000-4000-8000-000000000025",
				authTypes: [],
			}),
		).toThrow();
	});
});
