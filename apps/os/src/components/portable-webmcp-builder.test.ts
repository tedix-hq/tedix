import { describe, expect, it } from "vite-plus/test";
import {
	buildPortableCatalogTool,
	publishPortableWebMcpRollout,
} from "./portable-webmcp-builder";

describe("Portable WebMCP catalog builder", () => {
	it("projects only bounded scalar inputs and keeps tenant authority absent", () => {
		expect(
			buildPortableCatalogTool({
				toolId: "orders_list",
				callable: "acme_staging.orders_list",
				title: "Orders",
				description: "List orders",
				writeCapability: "read",
				inputSchema: {
					type: "object",
					properties: {
						limit: { type: "integer", description: "Maximum rows" },
						companyId: { type: "object" },
						filters: { type: "array" },
					},
					required: ["limit", "companyId"],
				},
			}),
		).toEqual({
			callable: "acme_staging.orders_list",
			name: "orders_list",
			description: "List orders",
			inputSchema: {
				type: "object",
				properties: {
					limit: { type: "integer", description: "Maximum rows" },
				},
				required: ["limit"],
				additionalProperties: false,
			},
			annotations: { readOnlyHint: true, untrustedContentHint: true },
		});
	});

	it("publishes sequentially with each installation revision fence", async () => {
		const calls: Record<string, unknown>[] = [];
		await publishPortableWebMcpRollout({
			profile: { version: 1, routes: [] },
			changeSummary: "Roll out orders routes",
			targets: [
				{ installationId: "tenant-a", revision: 2 },
				{ installationId: "tenant-b", revision: 7 },
			],
			publish: async (input) => {
				calls.push(input);
				return {
					installationId: input.installationId,
					revision: input.expectedRevision + 1,
					profile: input.profile,
				};
			},
		});
		expect(
			calls.map(({ installationId, expectedRevision }) => ({
				installationId,
				expectedRevision,
			})),
		).toEqual([
			{ installationId: "tenant-a", expectedRevision: 2 },
			{ installationId: "tenant-b", expectedRevision: 7 },
		]);
	});

	it("builds a write only with an explicit preparation and convergence contract", () => {
		const tool = buildPortableCatalogTool(
			{
				toolId: "orders_update",
				callable: "acme.orders_update",
				title: "Update order",
				description: "Update an order",
				inputSchema: { type: "object", properties: {} },
				writeCapability: "write",
			},
			{
				prepareCallable: "acme.orders_preview_update",
				convergeCallable: "acme.orders_get",
				confirmationTitle: "Confirm update order",
				confirmationLabel: "Update order",
			},
		);
		expect(tool.annotations.readOnlyHint).toBe(false);
		expect(tool.action).toEqual({
			prepareCallable: "acme.orders_preview_update",
			convergeCallable: "acme.orders_get",
			confirmationTitle: "Confirm update order",
			confirmationLabel: "Update order",
		});
	});
});
