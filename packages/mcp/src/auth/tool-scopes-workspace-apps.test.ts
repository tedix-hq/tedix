import { describe, expect, it } from "vite-plus/test";
import {
	isMcpToolVisibleToCaller,
	resolveMcpToolRequiredScopes,
} from "./tool-scopes";

// Explicit endpoint policy is independent of customer aggregate aliases and
// remains a floor when a catalog row loses or misreports effect metadata.
const cases = [
	[
		"calendarCoordinator/supportedAccounts",
		"list_calendar_accounts",
		"read",
		"mcp:apps.read",
	],
	[
		"calendarCoordinator/listCalendars",
		"list_account_calendars",
		"read",
		"mcp:apps.read",
	],
	[
		"calendarCoordinator/list",
		"list_calendar_coordinators",
		"read",
		"mcp:apps.read",
	],
	[
		"calendarCoordinator/configure",
		"configure_calendar_coordinator",
		"write",
		"mcp:apps.write",
	],
	[
		"calendarCoordinator/activate",
		"activate_calendar_coordinator",
		"destructive",
		"mcp:apps.admin",
	],
	[
		"calendarCoordinator/deactivate",
		"deactivate_calendar_coordinator",
		"destructive",
		"mcp:apps.admin",
	],
	[
		"calendarCoordinator/preview",
		"preview_calendar_reconciliation",
		"write",
		"mcp:apps.write",
	],
	[
		"calendarCoordinator/apply",
		"apply_calendar_reconciliation",
		"destructive",
		"mcp:apps.admin",
	],
	[
		"calendarCoordinator/previewCompensation",
		"preview_calendar_compensation",
		"write",
		"mcp:apps.write",
	],
	[
		"calendarCoordinator/compensate",
		"compensate_calendar_reconciliation",
		"destructive",
		"mcp:apps.admin",
	],
	[
		"calendarCoordinator/recover",
		"recover_calendar_reconciliation",
		"write",
		"mcp:apps.write",
	],
	[
		"calendarCoordinator/reconcileSubscription",
		"reconcile_calendar_subscription",
		"destructive",
		"mcp:apps.admin",
	],
	[
		"calendarCoordinator/status",
		"get_calendar_coordinator_status",
		"read",
		"mcp:apps.read",
	],
	[
		"personalResourceDelegations/create",
		"create_personal_resource_delegation",
		"destructive",
		"mcp:settings.admin",
	],
	[
		"personalResourceDelegations/list",
		"list_personal_resource_delegations",
		"read",
		"mcp:settings.read",
	],
	[
		"personalResourceDelegations/revoke",
		"revoke_personal_resource_delegation",
		"destructive",
		"mcp:settings.admin",
	],
	[
		"providerEvents/register",
		"register_provider_event_subscription",
		"destructive",
		"mcp:settings.admin",
	],
	[
		"providerEvents/list",
		"list_provider_event_subscriptions",
		"read",
		"mcp:settings.write",
	],
	[
		"providerEvents/get",
		"get_provider_event_subscription",
		"read",
		"mcp:settings.write",
	],
	[
		"providerEvents/disable",
		"disable_provider_event_subscription",
		"destructive",
		"mcp:settings.admin",
	],
	[
		"providerEvents/reconcile",
		"reconcile_provider_event_subscription",
		"destructive",
		"mcp:settings.admin",
	],
	["osGadgetState/get", "get_os_gadget_state", "read", "mcp:apps.read"],
	["osGadgetState/list", "list_os_gadget_state", "read", "mcp:apps.read"],
	["osGadgetState/put", "put_os_gadget_state", "write", "mcp:apps.write"],
	[
		"osGadgetState/delete",
		"delete_os_gadget_state",
		"destructive",
		"mcp:apps.admin",
	],
] as const;
function tool(endpoint: string, name = "unclassified_workspace_operation") {
	return {
		toolId: name,
		toolTypeId: "rpc",
		authRequired: true,
		config: { endpoint },
	};
}
describe("reviewed workspace RPC scope projection", () => {
	for (const [endpoint, name, writeCapability, scope] of cases) {
		it(`retains ${endpoint} authority through customer aliases`, () => {
			for (const namespace of ["goldup", "other_customer"]) {
				for (const candidate of [
					tool(endpoint),
					{
						...tool(endpoint),
						writeCapability: "read" as const,
						annotations: { readOnlyHint: true, destructiveHint: false },
					},
					{
						...tool(endpoint, `${namespace}__${name}`),
						writeCapability,
						annotations: {
							readOnlyHint: writeCapability === "read",
							destructiveHint: writeCapability === "destructive",
						},
					},
				]) {
					expect(
						resolveMcpToolRequiredScopes(candidate, namespace, {}),
					).toEqual([scope]);
					expect(
						isMcpToolVisibleToCaller(
							candidate,
							namespace,
							{},
							{ authType: "oauth", scopes: [scope] },
						),
					).toBe(true);
					for (const scopes of [
						[],
						["mcp:tedis.admin"],
						["connections.read"],
						["connections.execute"],
					])
						expect(
							isMcpToolVisibleToCaller(
								candidate,
								namespace,
								{},
								{ authType: "oauth", scopes },
							),
						).toBe(false);
					if (scope.endsWith(".write") || scope.endsWith(".admin"))
						expect(
							isMcpToolVisibleToCaller(
								candidate,
								namespace,
								{},
								{
									authType: "oauth",
									scopes: [scope.replace(/\.(write|admin)$/, ".read")],
								},
							),
						).toBe(false);
					if (scope.endsWith(".admin"))
						expect(
							isMcpToolVisibleToCaller(
								candidate,
								namespace,
								{},
								{
									authType: "oauth",
									scopes: [scope.replace(/\.admin$/, ".write")],
								},
							),
						).toBe(false);
				}
			}
		});
	}
	it("raises reviewed reads for declared writes and destructive metadata", () => {
		for (const endpoint of [
			"calendarCoordinator/supportedAccounts",
			"personalResourceDelegations/list",
			"osGadgetState/get",
		]) {
			const base = resolveMcpToolRequiredScopes(
				tool(endpoint, "get_probe"),
				"goldup",
				{},
			)[0]!;
			expect(
				resolveMcpToolRequiredScopes(
					{ ...tool(endpoint, "get_probe"), writeCapability: "write" },
					"goldup",
					{},
				),
			).toEqual([base.replace(/\.read$/, ".write")]);
			expect(
				resolveMcpToolRequiredScopes(
					{ ...tool(endpoint, "get_probe"), writeCapability: "destructive" },
					"goldup",
					{},
				),
			).toEqual([base.replace(/\.read$/, ".admin")]);
			expect(
				resolveMcpToolRequiredScopes(
					{
						...tool(endpoint, "get_probe"),
						annotations: { destructiveHint: true },
					},
					"goldup",
					{},
				),
			).toEqual([base.replace(/\.read$/, ".admin")]);
		}
	});
	it("does not grant unknown siblings, fabricated endpoint aliases or non-RPC tools", () => {
		for (const endpoint of [
			"calendarCoordinator/unreviewedOperation",
			"calendarCoordinator/listCalendarAccounts",
			"personalResourceDelegations/fetchToken",
			"providerEvents/execute",
			"osGadgetState/resetAll",
		]) {
			expect(() =>
				resolveMcpToolRequiredScopes(tool(endpoint), "goldup", {}),
			).toThrow("Missing MCP capability mapping");
			expect(
				isMcpToolVisibleToCaller(
					tool(endpoint),
					"goldup",
					{},
					{
						authType: "oauth",
						scopes: ["mcp:apps.admin", "mcp:settings.admin"],
					},
				),
			).toBe(false);
		}
		expect(() =>
			resolveMcpToolRequiredScopes(
				{
					...tool("calendarCoordinator/supportedAccounts"),
					toolTypeId: "external",
				},
				"goldup",
				{},
			),
		).toThrow("Missing MCP capability mapping");
	});
	it("preserves existing mapped namespace precedence", () => {
		expect(
			resolveMcpToolRequiredScopes(
				{
					...tool("providerEvents/list", "get_probe"),
					writeCapability: "read",
				},
				"os",
				{},
			),
		).toEqual(["mcp:apps.read"]);
	});
});
