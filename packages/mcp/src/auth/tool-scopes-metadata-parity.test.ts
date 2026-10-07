/**
 * The API must report the scope the EDGE would enforce, not an approximation.
 *
 * `appTools.list`/`get` expose a derived `requiredScopes` per tool. The whole
 * value of that field is that it agrees with enforcement, so these pin the two
 * ways it could silently diverge:
 *
 *  1. Reading `mcpConfig` off the raw column instead of through the edge's
 *     `normalizeAppMetadata(getAppMetadataJson(app))` — legacy rows store
 *     metadata as a JSON STRING, and a raw read yields `undefined` mcpConfig,
 *     which changes the resolver's answer.
 *  2. Passing an options object. `tools/list` passes none and `tools/call`
 *     passes `fallbackOnAuthenticatedAuthMode: false`; the flag is tested with
 *     `=== true`, so both resolve identically and the API must match them.
 */

import { describe, expect, it } from "vite-plus/test";
import {
	inferToolNamespace,
	isMcpToolVisibleToCaller,
	resolveMcpToolRequiredScopes,
	resolveMcpToolNamespace,
} from "./tool-scopes";

const tool = {
	toolId: "list_invoices",
	authRequired: false,
	visibility: null as string | null,
};

const ns = () => inferToolNamespace(tool.toolId);

describe("required-scope parity between the API field and the edge", () => {
	it.each(["tedis", "tedix_unified", "customer_unified"])(
		"preserves canonical tedi getter authority through %s",
		(namespace) => {
			const candidate = {
				toolId: `${namespace}__get_tedi`,
				toolTypeId: "rpc",
				config: { endpoint: "tedis/get", _aggregateNamespace: namespace },
				authRequired: true,
				writeCapability: "read" as const,
				annotations: { readOnlyHint: true },
			};
			for (const options of [
				undefined,
				{ fallbackOnAuthenticatedAuthMode: false },
				{ fallbackOnAuthenticatedAuthMode: true },
			]) {
				expect(
					resolveMcpToolRequiredScopes(candidate, namespace, {}, options),
				).toEqual(["mcp:tedis.read"]);
				for (const scopes of [
					["mcp:tedis.read"],
					[],
					["mcp:content.read"],
					["connections.execute"],
					["platform:admin"],
				]) {
					expect(
						isMcpToolVisibleToCaller(
							candidate,
							namespace,
							{},
							{ authType: "oauth", scopes },
							options,
						),
					).toBe(scopes.includes("mcp:tedis.read"));
				}
			}
			for (const writeCapability of ["write", "destructive"] as const) {
				const revised = { ...candidate, writeCapability };
				const required =
					writeCapability === "write" ? "mcp:tedis.write" : "mcp:tedis.admin";
				expect(resolveMcpToolRequiredScopes(revised, namespace, {})).toEqual([
					required,
				]);
				expect(
					isMcpToolVisibleToCaller(
						revised,
						namespace,
						{},
						{ authType: "oauth", scopes: ["mcp:tedis.read"] },
					),
				).toBe(false);
				expect(
					isMcpToolVisibleToCaller(
						revised,
						namespace,
						{},
						{ authType: "oauth", scopes: [required] },
					),
				).toBe(true);
			}
		},
	);

	it("does not give unknown aggregate tools a tedi endpoint fallback", () => {
		for (const endpoint of ["tedis/get", "tedis/unreviewedOperation"]) {
			const candidate = {
				toolId: "customer_unified__get_tedi_unreviewed",
				toolTypeId: "rpc",
				config: { endpoint },
				authRequired: true,
				annotations: { readOnlyHint: true },
			};
			expect(() =>
				resolveMcpToolRequiredScopes(candidate, "customer_unified", {}),
			).toThrow(/Missing MCP capability mapping/);
			expect(
				isMcpToolVisibleToCaller(
					candidate,
					"customer_unified",
					{},
					{ authType: "oauth", scopes: ["mcp:tedis.read"] },
				),
			).toBe(false);
		}
	});

	it.each([
		"apps",
		"tedix_unified",
		"acme_unified",
		"globex_unified",
		"example_unified",
		"tedix_demo_unified",
		"personal_unified",
		"workspace_unified",
		"sample_unified",
		"long_example_name_unified",
		"customer_unified",
	])("preserves the Apps list capability through %s", (namespace) => {
		const candidate = {
			toolId: `${namespace}__list_apps`,
			toolTypeId: "rpc",
			config: { endpoint: "apps/list", _aggregateNamespace: namespace },
			authRequired: true,
			writeCapability: "read" as const,
			annotations: { readOnlyHint: true },
		};
		expect(resolveMcpToolRequiredScopes(candidate, namespace, {})).toEqual([
			"mcp:apps.read",
		]);
		expect(
			isMcpToolVisibleToCaller(
				candidate,
				namespace,
				{},
				{
					authType: "oauth",
					scopes: ["mcp:apps.read"],
				},
			),
		).toBe(true);
		expect(
			isMcpToolVisibleToCaller(
				candidate,
				namespace,
				{},
				{
					authType: "oauth",
					scopes: ["mcp:content.read"],
				},
			),
		).toBe(false);
	});

	it.each([
		["apps/unreviewedOperation", "rpc"],
		["apps/list", "http"],
	])("does not borrow Apps authority from %s on %s", (endpoint, toolTypeId) => {
		expect(() =>
			resolveMcpToolRequiredScopes(
				{
					toolId: "customer_unified__list_apps",
					toolTypeId,
					config: { endpoint, _aggregateNamespace: "customer_unified" },
					authRequired: true,
					annotations: { readOnlyHint: true },
				},
				"customer_unified",
				{},
			),
		).toThrow(/Missing MCP capability mapping/);
	});

	it.each([
		["write", "mcp:apps.write"],
		["destructive", "mcp:apps.admin"],
	] as const)(
		"does not downgrade an Apps list declared %s",
		(writeCapability, scope) => {
			const candidate = {
				toolId: "customer_unified__list_apps",
				toolTypeId: "rpc",
				config: {
					endpoint: "apps/list",
					_aggregateNamespace: "customer_unified",
				},
				authRequired: true,
				writeCapability,
				annotations: { readOnlyHint: true },
			};
			expect(
				resolveMcpToolRequiredScopes(candidate, "customer_unified", {}),
			).toEqual([scope]);
			expect(
				isMcpToolVisibleToCaller(
					candidate,
					"customer_unified",
					{},
					{
						authType: "oauth",
						scopes: ["mcp:apps.read"],
					},
				),
			).toBe(false);
		},
	);

	it.each([
		["kernelRuntime/enqueueMessage", "ask", "write"],
		["kernelRuntime/readRun", "read_home_run", "read"],
		["kernelRuntime/readRunEvents", "read_home_run_events", "read"],
		["kernelRuntime/readMessages", "read_home_messages", "read"],
		["kernelRuntime/listConversations", "list_conversations", "read"],
		["kernelRuntime/readRunTrace", "read_home_trace", "read"],
		["kernelRuntime/readChildRunEvidence", "read_child_run_evidence", "read"],
		["kernelRuntime/readChildRunTree", "read_child_run_tree", "read"],
	] as const)(
		"retains the existing Home grant for %s",
		(endpoint, name, tier) => {
			expect(
				resolveMcpToolRequiredScopes(
					{
						toolId: name === "ask" ? name : `home__${name}`,
						toolTypeId: "rpc",
						config: { endpoint },
						authRequired: true,
						annotations: { readOnlyHint: tier === "read" },
					},
					"home",
					{},
				),
			).toEqual([`mcp:messaging.${tier}`]);
		},
	);

	it.each([
		[
			"kernelRuntime/enqueueMessage",
			"enqueue_kernel_runtime_message",
			"tedis",
			"write",
		],
		["kernelRuntime/readRun", "read_kernel_runtime_run", "tedis", "read"],
		[
			"kernelRuntime/readRunEvents",
			"read_kernel_runtime_run_events",
			"tedis",
			"read",
		],
		[
			"kernelRuntime/readMessages",
			"read_kernel_runtime_messages",
			"tedis",
			"read",
		],
		[
			"kernelRuntime/readToolResult",
			"read_kernel_runtime_tool_result",
			"tedis",
			"read",
		],
		[
			"kernelRuntime/listConversations",
			"list_kernel_runtime_conversations",
			"tedis",
			"read",
		],
		["kernelRuntime/readRunTrace", "read_run_trace", "tedis", "read"],
		[
			"kernelRuntime/readChildRunEvidence",
			"read_child_run_evidence",
			"tedis",
			"read",
		],
		["kernelRuntime/readChildRunTree", "read_child_run_tree", "tedis", "read"],
		[
			"harness/listKernelTraceBundles",
			"list_kernel_trace_bundles",
			"tedis",
			"read",
		],
		["osWorkspaces/workspaces/list", "list_os_workspaces", "apps", "read"],
		["osWorkspaces/workspaces/get", "get_os_workspace", "apps", "read"],
		["osWorkspaces/outputs/list", "list_os_outputs", "apps", "read"],
		["osWorkspaces/outputs/get", "get_os_output", "apps", "read"],
		["osWorkspaces/outputs/create", "create_os_output", "apps", "write"],
		["osWorkspaces/outputs/revise", "revise_os_output", "apps", "write"],
		[
			"osWorkspaces/outputs/patchDocument",
			"patch_os_document",
			"apps",
			"write",
		],
		[
			"osWorkspaces/outputs/setSheetRange",
			"set_os_sheet_range",
			"apps",
			"write",
		],
		["osWorkspaces/outputs/patchSlides", "patch_os_slides", "apps", "write"],
	] as const)(
		"preserves %s capability through organization aliases",
		(endpoint, name, family, tier) => {
			for (const namespace of ["os", "tedix_unified", "customer_unified"]) {
				const candidate = {
					toolId: `${namespace}__${name}`,
					toolTypeId: "rpc",
					config: { endpoint, _aggregateNamespace: namespace },
					authRequired: true,
					// A stale read declaration must not downgrade a write endpoint.
					annotations: { readOnlyHint: true },
				};
				expect(resolveMcpToolRequiredScopes(candidate, namespace, {})).toEqual([
					`mcp:${family}.${tier}`,
				]);
				expect(
					isMcpToolVisibleToCaller(
						candidate,
						namespace,
						{},
						{ authType: "oauth", scopes: [`mcp:${family}.${tier}`] },
					),
				).toBe(true);
				expect(
					isMcpToolVisibleToCaller(
						candidate,
						namespace,
						{},
						{ authType: "oauth", scopes: ["mcp:work.admin"] },
					),
				).toBe(false);
				if (tier === "write") {
					expect(
						isMcpToolVisibleToCaller(
							candidate,
							namespace,
							{},
							{ authType: "oauth", scopes: [`mcp:${family}.read`] },
						),
					).toBe(false);
				}
				expect(
					resolveMcpToolRequiredScopes(
						{ ...candidate, annotations: { destructiveHint: true } },
						namespace,
						{},
					),
				).toEqual([`mcp:${family}.admin`]);
			}
		},
	);

	it("does not grant organization aliases a broad RPC or spoofed endpoint fallback", () => {
		for (const [endpoint, toolTypeId] of [
			["kernelRuntime/unreviewedOperation", "rpc"],
			["harness/unreviewedOperation", "rpc"],
			["osWorkspaces/outputs/unreviewedOperation", "rpc"],
			["osWorkspaces/outputs/create", "http"],
		]) {
			expect(() =>
				resolveMcpToolRequiredScopes(
					{
						toolId: "customer_unified__create_os_output",
						toolTypeId,
						config: { endpoint },
						annotations: { readOnlyHint: false },
					},
					"customer_unified",
					{},
				),
			).toThrow(/Missing MCP capability mapping/);
		}
	});

	it.each([
		["mcpHealth/run", "run_mcp_protocol_probe", false, "mcp:observe.write"],
		["mcpEval/run", "run_mcp_eval", false, "platform:admin"],
		["tedis/rebind", "rebind_tedi", false, "platform:admin"],
		["mcpPayments/disablePolicy", "disable_policy", false, "platform:admin"],
		[
			"mcpPayments/getEffectivePolicy",
			"get_effective_policy",
			true,
			"mcp:settings.read",
		],
		["mcpPayments/getReceipt", "get_receipt", true, "mcp:settings.read"],
		["mcpPayments/listAccounts", "list_accounts", true, "mcp:settings.read"],
		["mcpPayments/listPolicies", "list_policies", true, "mcp:settings.read"],
		[
			"mcpPayments/listReservations",
			"list_reservations",
			true,
			"mcp:settings.read",
		],
		[
			"mcpPayments/registerAccount",
			"register_account",
			false,
			"platform:admin",
		],
		["mcpPayments/spendSummary", "spend_summary", true, "mcp:settings.read"],
		["mcpServer/adoptResource", "adopt_mcp_resource", false, "platform:admin"],
		["mcpServer/getStatus", "get_mcp_server_status", true, "mcp:apps.read"],
		["mcpServer/register", "register_mcp_server", false, "mcp:apps.write"],
		["mcpNetworkSecurity/getConfig", "get_config", true, "mcp:settings.read"],
		[
			"mcpNetworkSecurity/configure",
			"configure_mcp_network_security",
			false,
			"mcp:settings.admin",
		],
		[
			"mcpNetworkSecurity/reconcile",
			"reconcile_mcp_network_security",
			false,
			"mcp:settings.write",
		],
		[
			"mcpNetworkSecurity/applyPortalOnlyPolicy",
			"apply_portal_only_policy",
			false,
			"mcp:settings.admin",
		],
	] as const)(
		"gates retained %s at its exact endpoint scope",
		(endpoint, toolId, readOnly, requiredScope) => {
			const candidate = {
				toolId,
				toolTypeId: "rpc",
				config: { endpoint },
				authRequired: true,
				annotations: { readOnlyHint: readOnly },
			};
			expect(resolveMcpToolRequiredScopes(candidate, "mcp", {})).toEqual([
				requiredScope,
			]);
			expect(
				isMcpToolVisibleToCaller(
					candidate,
					"mcp",
					{},
					{
						authType: "oauth",
						scopes: [requiredScope],
					},
				),
			).toBe(true);
			if (requiredScope === "platform:admin") {
				expect(
					isMcpToolVisibleToCaller(
						candidate,
						"mcp",
						{},
						{
							authType: "oauth",
							scopes: ["mcp:settings.admin", "mcp:apps.admin"],
						},
					),
				).toBe(false);
			}
		},
	);

	it("does not let an unrelated RPC endpoint borrow an MCP operator scope", () => {
		for (const endpoint of [
			"other/getConfig",
			"mcpGovernance/resolveToolApprovalGrant",
		]) {
			const candidate = {
				toolId: endpoint.endsWith("getConfig")
					? "get_config"
					: "resolve_tool_approval_grant",
				toolTypeId: "rpc",
				config: { endpoint },
				authRequired: true,
				annotations: { readOnlyHint: true },
			};
			expect(() => resolveMcpToolRequiredScopes(candidate, "mcp", {})).toThrow(
				/Missing MCP capability mapping/,
			);
		}
	});

	it.each([
		["list_roles", true, "mcp:settings.read"],
		["list_permissions", true, "mcp:settings.read"],
		["update_member_role", false, "mcp:settings.write"],
		["set_member_permissions", false, "mcp:settings.write"],
	] as const)(
		"gates %s on tenant settings authority",
		(toolId, readOnly, scope) => {
			const candidate = {
				toolId,
				authRequired: true,
				annotations: { readOnlyHint: readOnly },
			};
			expect(resolveMcpToolRequiredScopes(candidate, "members", {})).toEqual([
				scope,
			]);
			expect(
				isMcpToolVisibleToCaller(
					candidate,
					"members",
					{},
					{
						authType: "oauth",
						scopes: ["mcp:settings.read"],
					},
				),
			).toBe(readOnly);
		},
	);

	it("allows a delegated tedi email send only with messaging write scope", () => {
		const email = {
			toolId: "cto__email_send",
			authRequired: true,
			visibility: "private",
			annotations: { readOnlyHint: false },
		};
		const config = { aggregateTedis: [{ namespace: "cto" }] };
		expect(resolveMcpToolRequiredScopes(email, "cto", config)).toEqual([
			"mcp:messaging.write",
		]);
		expect(
			isMcpToolVisibleToCaller(email, "cto", config, {
				authType: "tedi",
				scopes: ["mcp:messaging.read"],
			}),
		).toBe(false);
		expect(
			isMcpToolVisibleToCaller(email, "cto", config, {
				authType: "tedi",
				scopes: ["mcp:messaging.write"],
			}),
		).toBe(true);
	});

	it("agrees for both edge call shapes", () => {
		const config = { toolScopes: { "*": ["mcp:apps.read"] } };
		const toolsList = resolveMcpToolRequiredScopes(tool, ns(), config);
		const toolsCall = resolveMcpToolRequiredScopes(tool, ns(), config, {
			fallbackOnAuthenticatedAuthMode: false,
		});
		expect(toolsList).toEqual(toolsCall);
	});

	it("changes its answer when mcpConfig is absent, which is why the read path matters", () => {
		// If the API read metadata raw and a legacy row stored it as a JSON
		// string, mcpConfig would arrive undefined and this is the answer the
		// product would print — demonstrably not what the edge enforces.
		const withConfig = resolveMcpToolRequiredScopes(tool, ns(), {
			toolScopes: { "*": ["mcp:apps.read"] },
		});
		expect(withConfig).toEqual(["mcp:apps.read"]);
		expect(() => resolveMcpToolRequiredScopes(tool, ns(), undefined)).toThrow(
			/Missing MCP capability mapping/,
		);
	});

	it("honours enforcePolicies mode the same way the edge does", () => {
		const strict = resolveMcpToolRequiredScopes(tool, ns(), {
			enforcePolicies: true,
		});
		expect(strict.length).toBe(1);
		expect(strict[0]).toMatch(/^mcp:/);
	});

	it("promotes a destructive tool above its namespace capability", () => {
		// A dangerous tool must not report the broad namespace scope; the edge
		// promotes it, and a field that under-reports would be worse than absent.
		const destructive = resolveMcpToolRequiredScopes(
			{ toolId: "delete_invoice", authRequired: true, visibility: null },
			inferToolNamespace("delete_invoice"),
			{ toolScopes: { "*": ["mcp:content.admin"] } },
		);
		expect(destructive).toEqual(["mcp:content.admin"]);
	});

	it("compiles a capability-family policy into an exact access tier", () => {
		expect(
			resolveMcpToolRequiredScopes(tool, ns(), {
				toolScopes: { "*": ["mcp:apps"] },
			}),
		).toEqual(["mcp:apps.read"]);
	});

	it("hides an unclassified tool without breaking the surrounding tool list", () => {
		expect(
			isMcpToolVisibleToCaller(
				{ toolId: "unknown__get_curation_console" },
				"unknown",
				undefined,
				{},
				{ fallbackOnAuthenticatedAuthMode: true },
			),
		).toBe(false);
	});
});

describe("shared persisted-tool namespace resolution", () => {
	it("uses exact and camel-root D1 overrides before the endpoint root", () => {
		expect(
			resolveMcpToolNamespace(
				{
					toolId: "list_app_tools",
					config: { endpoint: "appTools/list" },
				},
				{ appTools: "app_config" },
			),
		).toBe("app_config");
		expect(
			resolveMcpToolNamespace(
				{
					toolId: "list_cognitive_runtime_events",
					config: { endpoint: "cognitiveRuntime/listEvents" },
				},
				{ cognitive: "skills" },
			),
		).toBe("skills");
	});

	it.each([
		["app_config", "mcp:apps.read"],
		["aeo", "mcp:apps.read"],
		["directory", "mcp:apps.read"],
		["feature", "mcp:apps.read"],
		["generated", "mcp:apps.read"],
		["items", "mcp:apps.read"],
		["listings", "mcp:apps.read"],
		["model", "mcp:apps.read"],
		["plugins", "mcp:apps.read"],
		["seo", "mcp:apps.read"],
		["snapshots", "mcp:apps.read"],
		["widget", "mcp:apps.read"],
		["growth", "mcp:memory.read"],
		["knowledge", "mcp:memory.read"],
		["mission", "mcp:memory.read"],
		["projects", "mcp:memory.read"],
		["docs", "mcp:content.read"],
		["flywheel", "mcp:tedis.read"],
		["harness", "mcp:tedis.read"],
		["kernel", "mcp:tedis.read"],
		["learning", "mcp:tedis.read"],
		["organization", "mcp:settings.read"],
		["secrets", "mcp:settings.read"],
		["user", "mcp:settings.read"],
		["billing", "platform:admin"],
		["control", "platform:admin"],
		["earned", "platform:admin"],
		["graph", "platform:admin"],
		["images", "platform:admin"],
		["organizations", "platform:admin"],
		["templates", "platform:admin"],
		["tenant", "platform:admin"],
		["waitlist", "platform:admin"],
		["video", "mcp:skills.read"],
	] as const)("classifies the %s namespace", (namespace, expected) => {
		expect(
			resolveMcpToolRequiredScopes(
				{ toolId: "list_status", authRequired: true },
				namespace,
				{ toolScopes: {} },
			),
		).toEqual([expected]);
	});
});
