import { describe, expect, it } from "vite-plus/test";
import { PortableWebMcpProfileSchema } from "./portable-webmcp";

const actionTool = {
	callable: "acme.orders_update",
	name: "update_order",
	description: "Update an order",
	inputSchema: { type: "object", properties: {}, additionalProperties: false },
	annotations: { readOnlyHint: false },
};

describe("PortableWebMcpProfileSchema", () => {
	it("requires the full prepare-confirm-execute-converge contract for writes", () => {
		const profile = (tool: Record<string, unknown>) => ({
			version: 1,
			routes: [{ id: "orders", match: { routeKey: "orders" }, tools: [tool] }],
		});
		expect(
			PortableWebMcpProfileSchema.safeParse(profile(actionTool)).success,
		).toBe(false);
		expect(
			PortableWebMcpProfileSchema.safeParse(
				profile({
					...actionTool,
					action: {
						prepareCallable: "acme.orders_preview_update",
						convergeCallable: "acme.orders_get",
						confirmationTitle: "Update this order?",
						confirmationLabel: "Update order",
					},
				}),
			).success,
		).toBe(true);
	});
});
