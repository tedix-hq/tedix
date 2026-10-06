import { AppWithToolsSchema } from "@tedix/api-contract/schemas/app";
import { describe, expect, it } from "vite-plus/test";
import { toCatalogMcpSurfaceDto } from "./apps";

describe("app catalog MCP surface DTOs", () => {
	it("removes the parent catalog ID from hydrated prompt rows", () => {
		const prompt = toCatalogMcpSurfaceDto({
			id: "prompt-1",
			catalogAppId: "catalog-1",
			promptName: "research_domain",
			description: "Research a domain",
			arguments: null,
			detectedAt: "2026-08-02T00:00:00.000Z",
			lastSeenAt: "2026-08-02T00:00:00.000Z",
			removedAt: null,
		});

		expect(prompt).not.toHaveProperty("catalogAppId");
		expect(() =>
			AppWithToolsSchema.parse({
				app: null,
				tools: [],
				catalogPrompts: [prompt],
			}),
		).not.toThrow();
	});
});
