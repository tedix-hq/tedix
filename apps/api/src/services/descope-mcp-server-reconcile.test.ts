import { describe, expect, it } from "vite-plus/test";
import {
	extractMcpApprovedScopeNames,
	extractMcpDefaultGrantedScopeNames,
	isPlatformOperatorMcpResource,
	reconcileMcpPlatformScopes,
} from "./descope-mcp-server-reconcile";

describe("reconcileMcpPlatformScopes", () => {
	it("adds every platform scope while deleting retired broad app scopes", () => {
		const result = reconcileMcpPlatformScopes({
			permissionsScopes: [{ name: "mcp:apps", description: "Apps" }],
			connectionsScopes: [
				{ name: "connections.execute", description: "Existing description" },
			],
		});

		expect(extractMcpApprovedScopeNames(result)).toEqual([
			"connections.admin",
			"connections.execute",
			"connections.read",
		]);
		expect(result.permissionsScopes).toEqual([]);
		expect(result.connectionsScopes).toContainEqual({
			name: "connections.execute",
			description: "Existing description",
			optional: true,
		});
		expect(extractMcpDefaultGrantedScopeNames(result)).toEqual([]);
	});

	it("removes identity scopes that Descope auto-grants to machine clients", () => {
		const once = reconcileMcpPlatformScopes({
			permissionsScopes: [
				{ name: "profile" },
				{ name: "email" },
				{ name: "mcp:observe" },
				{ name: "mcp:observe.read", description: "View observability" },
			],
		});
		const twice = reconcileMcpPlatformScopes(once);

		expect(twice).toEqual(once);
		expect(extractMcpApprovedScopeNames(twice)).toEqual([
			"connections.admin",
			"connections.execute",
			"connections.read",
			"mcp:observe.read",
			"mcp:work.admin",
			"mcp:work.read",
			"mcp:work.write",
		]);
		expect(extractMcpDefaultGrantedScopeNames(twice)).toEqual([]);
	});

	it("advertises platform authority only for the platform operator resource", () => {
		const tenant = reconcileMcpPlatformScopes({ connectionsScopes: [] });
		const platform = reconcileMcpPlatformScopes(
			{ connectionsScopes: [] },
			{ allowPlatformAdmin: true },
		);

		expect(extractMcpApprovedScopeNames(tenant)).not.toContain(
			"platform:admin",
		);
		expect(extractMcpApprovedScopeNames(platform)).toContain("platform:admin");
		expect(extractMcpDefaultGrantedScopeNames(platform)).not.toContain(
			"platform:admin",
		);
	});
});

it.each(["connect", "tedix", "tedix-unified"])(
	"keeps %s platform administration optional and reconciliation idempotent",
	(slug) => {
		expect(isPlatformOperatorMcpResource(slug)).toBe(true);
		const options = { allowPlatformAdmin: isPlatformOperatorMcpResource(slug) };
		const once = reconcileMcpPlatformScopes(
			{
				connectionsScopes: [
					{
						name: "platform:admin",
						description: "Prior required grant",
						optional: false,
					},
				],
			},
			options,
		);
		const twice = reconcileMcpPlatformScopes(once, options);
		expect(twice).toEqual(once);
		expect(extractMcpApprovedScopeNames(once)).toContain("platform:admin");
		expect(extractMcpDefaultGrantedScopeNames(once)).not.toContain(
			"platform:admin",
		);
		expect(
			once.connectionsScopes?.find((scope) => scope.name === "platform:admin")
				?.optional,
		).toBe(true);
	},
);

it.each([
	"customer",
	"customer-unified",
	"connect-customer",
	"customer-connect",
])("excludes platform authority from customer resource %s", (slug) => {
	expect(isPlatformOperatorMcpResource(slug)).toBe(false);
	const result = reconcileMcpPlatformScopes(
		{ connectionsScopes: [{ name: "platform:admin", optional: true }] },
		{ allowPlatformAdmin: isPlatformOperatorMcpResource(slug) },
	);
	expect(extractMcpApprovedScopeNames(result)).not.toContain("platform:admin");
});
