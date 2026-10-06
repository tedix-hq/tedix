/**
 * The work board must not resolve to a scope no tenant can hold.
 *
 * `resolveNamespaceFallbackScope` recognises the board family by NAME regex
 * (`TEDI_WORK_ITEM_TOOL_NAME_RE`), so it covers `*_work_item(s)_*` but misses
 * canonical attempt/evidence/event verbs not spelled that way. Those reached the
 * `toolToCapabilityScope` unclassified-tool error. They were therefore omitted
 * from every OAuth client's usable catalog while their `*_work_items_*`
 * siblings worked for the same caller.
 */

import { describe, expect, it } from "vite-plus/test";
import {
	inferToolNamespace,
	isMcpToolVisibleToCaller,
	resolveMcpToolRequiredScopes,
} from "./tool-scopes";

/**
 * Mirrors the live tenant aggregate that surfaced this: `enforcePolicies` off,
 * `authMode: "authenticated"`, and a `toolScopes` map that carries NO key for
 * any board tool — so resolution falls through to the namespace fallback.
 */
const tenantAggregateConfig = {
	enforcePolicies: false,
	authMode: "authenticated",
	toolScopes: { tedis: ["mcp:tedis.read"] },
};

describe("Interaction RPC authority through organization aliases", () => {
	for (const [endpoint, scope] of [
		["create", "mcp:messaging.write"],
		["respond", "mcp:messaging.write"],
		["delegate", "mcp:messaging.write"],
		["cancel", "mcp:messaging.write"],
		["get", "mcp:messaging.read"],
		["listInbox", "mcp:messaging.read"],
		["listOutbox", "mcp:messaging.read"],
		["listAudit", "mcp:messaging.read"],
	] as const) {
		it(`preserves ${scope} for ${endpoint}`, () => {
			const tool = {
				toolId: "example__interaction_alias",
				toolTypeId: "rpc",
				authRequired: true,
				config: { endpoint: `workInteractions/${endpoint}` },
			};
			for (const namespace of ["example_org", "sales_org"]) {
				expect(
					resolveMcpToolRequiredScopes(tool, namespace, tenantAggregateConfig),
				).toEqual([scope]);
				for (const granted of ["mcp:messaging.read", "mcp:work.write"]) {
					expect(
						isMcpToolVisibleToCaller(tool, namespace, tenantAggregateConfig, {
							authType: "oauth",
							scopes: [granted],
						}),
					).toBe(granted === scope);
				}
				expect(
					isMcpToolVisibleToCaller(tool, namespace, tenantAggregateConfig, {
						authType: "oauth",
						scopes: [scope],
					}),
				).toBe(true);
			}
		});
	}

	it("retains destructive metadata and denies unknown RPCs", () => {
		const tool = {
			toolId: "example__interaction_alias",
			toolTypeId: "rpc",
			authRequired: true,
			config: { endpoint: "workInteractions/cancel" },
		};
		expect(
			resolveMcpToolRequiredScopes(
				{ ...tool, annotations: { destructiveHint: true } },
				"example_org",
				tenantAggregateConfig,
			),
		).toEqual(["mcp:messaging.admin"]);
		expect(() =>
			resolveMcpToolRequiredScopes(
				{ ...tool, config: { endpoint: "workInteractions/unknown" } },
				"example_org",
				tenantAggregateConfig,
			),
		).toThrow(/Missing MCP capability mapping/);
	});
});

function resolve(rawName: string): string[] {
	// Board tools reach a tenant gateway through the aggregated `tedix` app, so
	// the id is prefixed. `rawToolName` strips that prefix before the fallback
	// runs, which is exactly why an aggregate-prefixed rule cannot fix this.
	const toolId = `tedix__${rawName}`;
	return resolveMcpToolRequiredScopes(
		{ toolId, authRequired: false, visibility: "public" },
		inferToolNamespace(toolId),
		tenantAggregateConfig,
		{ fallbackOnAuthenticatedAuthMode: true },
	);
}

describe("Local agent session board authority", () => {
	for (const [endpoint, toolName, scope] of [
		["report", "report_work_agent_session_status", "mcp:work.write"],
		["list", "list_work_agent_sessions", "mcp:work.read"],
	] as const) {
		it(`requires ${scope} for ${toolName} by endpoint and by name`, () => {
			const rpcTool = {
				toolId: `example__${toolName}`,
				toolTypeId: "rpc",
				authRequired: true,
				config: { endpoint: `workAgentSessions/${endpoint}` },
			};
			for (const namespace of ["work", "example_org"]) {
				expect(
					resolveMcpToolRequiredScopes(
						rpcTool,
						namespace,
						tenantAggregateConfig,
					),
				).toEqual([scope]);
				for (const granted of [
					"mcp:work.read",
					"mcp:work.write",
					"mcp:messaging.write",
				]) {
					expect(
						isMcpToolVisibleToCaller(
							rpcTool,
							namespace,
							tenantAggregateConfig,
							{ authType: "oauth", scopes: [granted] },
						),
					).toBe(granted === scope);
				}
			}
			expect(resolve(toolName)).toEqual([scope]);
		});
	}
});

describe("work board scope resolution", () => {
	it("requires the existing Work read grant for the exact approval inbox", () => {
		expect(resolve("list_work_approvals")).toEqual(["mcp:work.read"]);
		for (const prefix of ["", "tedix__", "tedix_unified__"]) {
			const tool = {
				toolId: `${prefix}list_work_approvals`,
				authRequired: true,
				annotations: { readOnlyHint: true },
			};
			for (const namespace of ["work", "tedix_unified", "unknown"]) {
				expect(
					resolveMcpToolRequiredScopes(tool, namespace, tenantAggregateConfig),
				).toEqual(["mcp:work.read"]);
				for (const [scope, allowed] of [
					["mcp:work.read", true],
					["mcp:settings.admin", false],
					["mcp:messaging.read", false],
					["platform:admin", false],
				] as const) {
					expect(
						isMcpToolVisibleToCaller(tool, namespace, tenantAggregateConfig, {
							authType: "oauth",
							scopes: [scope],
						}),
					).toBe(allowed);
				}
			}
		}
		expect(() => resolve("list_work_approvals_unreviewed")).toThrow(
			/Missing MCP capability mapping/,
		);
	});

	it("exposes admission tools only through their canonical Work tier", () => {
		for (const namespace of ["work", "tedix_unified", "unknown"]) {
			for (const prefix of ["", "tedix__", "tedix_unified__"]) {
				for (const [name, requiredScope] of [
					["get_work_admission_specification", "mcp:work.read"],
					["replace_work_admission_specification", "mcp:work.admin"],
				] as const) {
					const shape = {
						toolId: `${prefix}${name}`,
						authRequired: true,
						annotations: {
							readOnlyHint: name === "get_work_admission_specification",
							destructiveHint: false,
						},
					};
					expect(
						resolveMcpToolRequiredScopes(
							shape,
							namespace,
							tenantAggregateConfig,
							{ fallbackOnAuthenticatedAuthMode: true },
						),
					).toEqual([requiredScope]);
					for (const [scope, expected] of [
						[requiredScope, true],
						["mcp:settings.admin", false],
						["mcp:messaging.admin", false],
					] as const) {
						expect(
							isMcpToolVisibleToCaller(
								shape,
								namespace,
								tenantAggregateConfig,
								{ authType: "external_agent", scopes: [scope] },
							),
						).toBe(expected);
					}
					if (requiredScope === "mcp:work.admin") {
						for (const scope of ["mcp:work.read", "mcp:work.write"]) {
							expect(
								isMcpToolVisibleToCaller(
									shape,
									namespace,
									tenantAggregateConfig,
									{ authType: "external_agent", scopes: [scope] },
								),
							).toBe(false);
						}
					}
				}
			}
		}
		expect(() =>
			resolve("get_work_admission_specification_unreviewed"),
		).toThrow(/Missing MCP capability mapping/);
		expect(resolve("list_work_resource_pools")).toEqual(["mcp:settings.read"]);
	});

	it("keeps canonical attempt, evidence, event, and steward verbs on the collaboration scope", () => {
		for (const [tool, scope] of [
			["start_work_attempt", "mcp:work.write"],
			["heartbeat_work_attempt", "mcp:work.write"],
			["settle_work_attempt", "mcp:work.write"],
			["list_work_attempts", "mcp:work.read"],
			["submit_work_evidence", "mcp:work.write"],
			["complete_work_item", "mcp:work.write"],
			["list_work_evidence", "mcp:work.read"],
			["list_work_events", "mcp:work.read"],
			["run_work_graph_steward", "mcp:work.write"],
		] as const) {
			expect(resolve(tool)).toEqual([scope]);
		}
	});

	it("keeps the canonical tool-schema-sync board ids on the collaboration scope", () => {
		// The `*_work_item_*` ids are what WORK_HIERARCHY_TOOL_ID_OVERRIDES
		// actually syncs to the admin `tedix` app (the ids the CLI `work` verbs
		// call). Their verbs (start/heartbeat/settle/submit/review) match neither
		// verb regex, so without an explicit access-level override they resolved
		// to `mcp:messaging.admin` — which only a platform-admin OAuth grant
		// holds, so a CLI token without `platform:admin` failed while the
		// `_work_` twins above kept working.
		for (const [tool, scope] of [
			["start_work_item_attempt", "mcp:work.write"],
			["heartbeat_work_item_attempt", "mcp:work.write"],
			["settle_work_item_attempt", "mcp:work.write"],
			["submit_work_item_evidence", "mcp:work.write"],
			["review_work_item_evidence", "mcp:work.write"],
			["list_work_item_attempts", "mcp:work.read"],
			["list_work_item_evidence", "mcp:work.read"],
			["list_work_item_events", "mcp:work.read"],
		] as const) {
			expect(resolve(tool)).toEqual([scope]);
		}
	});

	it("keeps board observability reads on the analytics capability", () => {
		expect(resolve("get_work_graph_health")).toEqual(["mcp:work.read"]);
		expect(resolve("get_org_graph_health")).toEqual(["mcp:work.read"]);
		expect(resolve("list_activity")).toEqual(["mcp:work.read"]);
	});

	it("still resolves the work_items family it always did", () => {
		// Regression guard: these already worked via the name regex and must not
		// move, or the fix would have traded one broken half for the other.
		for (const [tool, scope] of [
			["list_work_items", "mcp:work.read"],
			["update_work_items", "mcp:work.write"],
			["get_work_items_by_id", "mcp:work.read"],
			["work_item_comment", "mcp:work.write"],
		] as const) {
			expect(resolve(tool)).toEqual([scope]);
		}
	});

	it("does not hand the board an unobtainable scope", () => {
		// The whole point: no board tool may require platform:admin, because a tenant
		// OAuth client can never obtain it.
		for (const tool of [
			"start_work_attempt",
			"heartbeat_work_attempt",
			"settle_work_attempt",
			"list_work_attempts",
			"submit_work_evidence",
			"complete_work_item",
			"list_work_evidence",
			"list_work_events",
			"run_work_graph_steward",
			"get_work_graph_health",
			"get_org_graph_health",
			"list_activity",
		]) {
			expect(resolve(tool)).not.toContain("platform:admin");
		}
	});

	it("leaves unrelated unknown tools on the fail-closed catch-all", () => {
		// The fix is an explicit name set, not a looser pattern, precisely so it
		// cannot widen anything it was not meant to reach.
		expect(() => resolve("frobnicate_widget")).toThrow(
			/Missing MCP capability mapping/,
		);
	});
});

it("admits Work approval requests with Work write without granting decision authority", () => {
	const tool = { toolId: "tedix__propose_work_approval", authRequired: true };
	for (const annotations of [
		undefined,
		{ readOnlyHint: false, destructiveHint: false },
	]) {
		const shape = { ...tool, annotations };
		expect(
			resolveMcpToolRequiredScopes(shape, "work", tenantAggregateConfig),
		).toEqual(["mcp:work.write"]);
		expect(
			isMcpToolVisibleToCaller(shape, "work", tenantAggregateConfig, {
				authType: "external_agent",
				scopes: ["mcp:work.write"],
			}),
		).toBe(true);
		expect(
			isMcpToolVisibleToCaller(shape, "work", tenantAggregateConfig, {
				authType: "external_agent",
				scopes: ["mcp:work.read"],
			}),
		).toBe(false);
	}
	expect(resolve("decide_work_approval")).toEqual(["mcp:work.admin"]);
});
