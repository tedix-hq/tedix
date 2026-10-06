import { describe, expect, it } from "vite-plus/test";
import {
	admitPortableWebMcpProfile,
	publicPortableWebMcpInputSchema,
} from "./portable-webmcp-profile";

const profile = {
	version: 1 as const,
	routes: [
		{
			id: "orders",
			match: { routeKey: "orders" },
			tools: [
				{
					callable: "acme.orders_list",
					name: "list_orders",
					description: "List orders",
					inputSchema: {
						type: "object" as const,
						properties: {},
						additionalProperties: false as const,
					},
					annotations: { readOnlyHint: true as const },
				},
				{
					callable: "acme.orders_delete",
					name: "delete_order",
					description: "Delete an order",
					inputSchema: {
						type: "object" as const,
						properties: {},
						additionalProperties: false as const,
					},
					annotations: { readOnlyHint: true as const },
				},
			],
		},
	],
};

describe("admitPortableWebMcpProfile", () => {
	it("admits only catalog-declared read tools in the installed namespace", () => {
		const result = admitPortableWebMcpProfile({
			profile,
			hostTenantNamespace: "acme",
			catalogTools: [
				{ toolId: "orders_list", writeCapability: "read" },
				{ toolId: "orders_delete", writeCapability: "destructive" },
			],
		});
		expect(
			result.profile?.routes[0]?.tools.map((tool) => tool.callable),
		).toEqual(["acme.orders_list"]);
		expect(result.diagnostics).toEqual([
			{ callable: "acme.orders_list", status: "admitted" },
			{
				callable: "acme.orders_delete",
				status: "rejected",
				reason: "destructive_tool_forbidden",
			},
		]);
	});

	it("admits a non-destructive write only with read-only prepare and converge tools", () => {
		const actionProfile = {
			version: 1 as const,
			routes: [
				{
					id: "orders",
					match: { routeKey: "orders" },
					tools: [
						{
							callable: "acme.orders_update",
							name: "update_order",
							description: "Update an order after confirmation",
							inputSchema: {
								type: "object" as const,
								properties: {},
								additionalProperties: false as const,
							},
							action: {
								prepareCallable: "acme.orders_preview_update",
								convergeCallable: "acme.orders_get",
								confirmationTitle: "Update this order?",
								confirmationLabel: "Update order",
							},
							annotations: { readOnlyHint: false as const },
						},
					],
				},
			],
		};
		const admitted = admitPortableWebMcpProfile({
			profile: actionProfile,
			hostTenantNamespace: "acme",
			catalogTools: [
				{ toolId: "orders_update", writeCapability: "write" },
				{ toolId: "orders_preview_update", writeCapability: "read" },
				{ toolId: "orders_get", writeCapability: "read" },
			],
		});
		expect(admitted.profile).toEqual(actionProfile);
		expect(admitted.diagnostics).toEqual([
			{ callable: "acme.orders_update", status: "admitted" },
		]);

		const rejected = admitPortableWebMcpProfile({
			profile: actionProfile,
			hostTenantNamespace: "acme",
			catalogTools: [
				{ toolId: "orders_update", writeCapability: "write" },
				{ toolId: "orders_preview_update", writeCapability: "write" },
				{ toolId: "orders_get", writeCapability: "read" },
			],
		});
		expect(rejected.profile).toBeUndefined();
		expect(rejected.diagnostics[0]?.reason).toBe("prepare_tool_not_read_only");
	});

	it("fails closed for an undeclared classification or another namespace", () => {
		const undeclared = admitPortableWebMcpProfile({
			profile,
			hostTenantNamespace: "acme",
			catalogTools: [{ toolId: "orders_list", writeCapability: null }],
		});
		expect(undeclared.profile).toBeUndefined();
		expect(undeclared.diagnostics[0]?.reason).toBe("not_declared_read_only");

		const wrongNamespace = admitPortableWebMcpProfile({
			profile,
			hostTenantNamespace: "another",
			catalogTools: [{ toolId: "orders_list", writeCapability: "read" }],
		});
		expect(wrongNamespace.profile).toBeUndefined();
		expect(
			wrongNamespace.diagnostics.every(
				(item) => item.reason === "namespace_mismatch",
			),
		).toBe(true);
	});

	it("admits only the explicit tenant Work surface", () => {
		const tenantProfile = {
			version: 1 as const,
			routes: [
				{
					id: "work",
					match: { pathname: "/m/dashboard" },
					tools: [
						{
							authority: "tedix_tenant" as const,
							callable: "work.list_work_items",
							name: "list_work_items",
							description: "List tenant Work Items",
							inputSchema: {
								type: "object" as const,
								additionalProperties: false as const,
							},
							annotations: { readOnlyHint: true as const },
						},
						{
							authority: "tedix_tenant" as const,
							callable: "work.add_comment",
							name: "add_work_comment",
							description: "Add a tenant Work Item comment",
							inputSchema: {
								type: "object" as const,
								additionalProperties: false as const,
							},
							action: {
								prepareCallable: "work.list_work_item_events",
								convergeCallable: "work.list_work_item_events",
								confirmationTitle: "Add this Work comment?",
								confirmationLabel: "Add comment",
								prepareFields: ["id"],
								convergeFields: ["id"],
							},
							annotations: { readOnlyHint: false as const },
						},
						{
							authority: "tedix_tenant" as const,
							callable: "work.complete_work_item",
							name: "complete_work_item",
							description: "Forbidden lifecycle mutation",
							inputSchema: {
								type: "object" as const,
								additionalProperties: false as const,
							},
							annotations: { readOnlyHint: true as const },
						},
					],
				},
			],
		};
		const result = admitPortableWebMcpProfile({
			profile: tenantProfile,
			hostTenantNamespace: "acme",
			catalogTools: [],
		});
		expect(
			result.profile?.routes[0]?.tools.map((tool) => tool.callable),
		).toEqual(["work.list_work_items", "work.add_comment"]);
		expect(result.diagnostics.at(-1)).toEqual({
			callable: "work.complete_work_item",
			status: "rejected",
			reason: "namespace_mismatch",
		});
	});
});

describe("publicPortableWebMcpInputSchema", () => {
	it("removes the signed tenant binding from properties and required", () => {
		expect(
			publicPortableWebMcpInputSchema(
				{
					type: "object",
					properties: {
						limit: { type: "integer" },
						companyId: { type: "string" },
					},
					required: ["limit", "companyId"],
					additionalProperties: false,
				},
				"companyId",
			),
		).toEqual({
			type: "object",
			properties: { limit: { type: "integer" } },
			required: ["limit"],
			additionalProperties: false,
		});
	});
});
