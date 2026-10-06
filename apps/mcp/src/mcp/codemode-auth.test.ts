import { describe, expect, it } from "vite-plus/test";

import {
	assertCodeModeInnerToolAuthorized,
	enforceMcpToolScopeAuthorization,
	evaluateMcpToolScopeAuthorization,
	resolveCodeModeInnerToolScopes,
} from "./codemode-auth";
import type { AppTool, ServerContext } from "./server-context";
import { isMcpToolVisibleToCaller } from "@tedix/mcp-shared/auth/tool-scopes";

function tool(overrides: Partial<AppTool>): AppTool {
	return {
		id: "tool-row-id",
		toolId: "memory_search",
		title: "Memory search",
		description: null,
		toolTypeId: "rpc",
		inputSchema: { type: "object", properties: {} },
		outputSchema: null,
		config: null,
		icons: null,
		executionTaskSupport: null,
		annotations: null,
		meta: null,
		invocationStatus: null,
		fileParams: null,
		adapterScope: null,
		resultStrategy: null,
		outputTemplate: null,
		widgetKey: null,
		widgetRoute: null,
		widgetAccessible: null,
		visibility: null,
		widgetDescription: null,
		widgetPrefersBorder: null,
		widgetDomain: null,
		schemaDialect: null,
		schemaSource: null,
		schemaSourceRef: null,
		schemaSourceHash: null,
		schemaSyncedAt: null,
		sortOrder: null,
		enabled: true,
		createdAt: null,
		updatedAt: null,
		...overrides,
	};
}

function ctx(
	mcpConfig: Record<string, unknown>,
	scopes: string[] | undefined,
): Pick<ServerContext, "appMetadata" | "callerIdentity"> {
	return {
		appMetadata: { mcpConfig } as ServerContext["appMetadata"],
		callerIdentity: scopes
			? ({
					authType: "oauth",
					scopes,
				} as ServerContext["callerIdentity"])
			: undefined,
	};
}

const CODE_MODE = { fallbackOnAuthenticatedAuthMode: true } as const;

describe("Code Mode declared write scope", () => {
	const resolveGap = tool({
		toolId: "tedix__gaps_resolve",
		annotations: { readOnlyHint: false },
		writeCapability: "write",
	});

	it("denies a memory-read grant before a mutating inner tool runs", () => {
		const readOnlyCaller = ctx({}, ["mcp:memory.read"]);
		expect(resolveCodeModeInnerToolScopes(resolveGap, "memory", {})).toEqual([
			"mcp:memory.write",
		]);
		expect(
			evaluateMcpToolScopeAuthorization(readOnlyCaller, resolveGap, "memory"),
		).toMatchObject({
			authorized: false,
			missingScopes: ["mcp:memory.write"],
		});
		expect(() =>
			assertCodeModeInnerToolAuthorized(readOnlyCaller, resolveGap, "memory"),
		).toThrow(/mcp:memory.write/);
		expect(() =>
			assertCodeModeInnerToolAuthorized(
				ctx({}, ["mcp:memory.write"]),
				resolveGap,
				"memory",
			),
		).not.toThrow();
	});
});

describe("Code Mode connected Notion command authorization", () => {
	const notion = tool({
		toolId: "notion-tedix__notion-update-page",
		writeCapability: "destructive",
		annotations: { destructiveHint: true },
		config: {
			auth: { type: "connection", connectionId: "notion" },
			_aggregateConnectionProviderId: "notion",
		},
	});
	const standardTedi = ctx({}, ["connections.execute"]);

	it("is discoverable to a standard tedi and dispatches a bounded edit", () => {
		expect(
			evaluateMcpToolScopeAuthorization(standardTedi, notion, "notion_tedix"),
		).toEqual({ authorized: true });
		expect(() =>
			assertCodeModeInnerToolAuthorized(standardTedi, notion, "notion_tedix", {
				page_id: "page",
				command: "update_properties",
				properties: { Name: "Updated" },
			}),
		).not.toThrow();
	});

	it.each([
		{ page_id: "page", command: "replace_content", new_str: "replacement" },
		{
			page_id: "page",
			command: "update_content",
			content_updates: [{ old_str: "old", new_str: "new" }],
			allow_deleting_content: true,
		},
		{ page_id: "page", command: "insert_content", content: "x", cover: "none" },
		{},
	])("denies before dispatch for an admin command or ambiguity: %j", (args) => {
		expect(() =>
			assertCodeModeInnerToolAuthorized(
				standardTedi,
				notion,
				"notion_tedix",
				args,
			),
		).toThrow(/connections.admin/);
	});
});

describe("code-built tools/call authorization", () => {
	it("requires exact messaging consent for delegated interaction reads and replies", () => {
		for (const [name, endpoint, scope] of [
			["get_work_interaction", "workInteractions/get", "mcp:messaging.read"],
			[
				"respond_work_interaction",
				"workInteractions/respond",
				"mcp:messaging.write",
			],
		] as const) {
			const interaction = tool({
				toolId: `tedix__${name}`,
				config: { endpoint },
			});
			const granted = {
				...ctx({}, [scope]),
				callerIdentity: {
					authType: "tedi",
					credentialMode: "delegated-mcp",
					scopes: [scope],
				},
			} as ServerContext;
			expect(
				evaluateMcpToolScopeAuthorization(granted, interaction, "work"),
			).toMatchObject({ authorized: true });
			expect(
				evaluateMcpToolScopeAuthorization(
					{
						...granted,
						callerIdentity: {
							...granted.callerIdentity,
							authType: "tedi",
							scopes: ["mcp:work.read"],
						},
					},
					interaction,
					"work",
				),
			).toMatchObject({ authorized: false });
			expect(
				evaluateMcpToolScopeAuthorization(
					granted,
					tool({ ...interaction, toolTypeId: "code" }),
					"work",
				),
			).toMatchObject({ authorized: false });
		}
	});
	it("denies delegated Work discovery and execution even with a broad configured scope", () => {
		const delegated = {
			appMetadata: {
				mcpConfig: { toolScopes: { complete_work_item: ["mcp:apps.write"] } },
			} as unknown as ServerContext["appMetadata"],
			callerIdentity: {
				authType: "tedi",
				credentialMode: "delegated-mcp",
				scopes: ["mcp:apps.read", "mcp:apps.write"],
			} as ServerContext["callerIdentity"],
		};
		const workTool = tool({ toolId: "complete_work_item" });
		expect(
			evaluateMcpToolScopeAuthorization(delegated, workTool, "apps"),
		).toMatchObject({ authorized: false });
		expect(() =>
			assertCodeModeInnerToolAuthorized(delegated, workTool, "apps"),
		).toThrow("Insufficient scope");
		expect(
			evaluateMcpToolScopeAuthorization(
				delegated,
				tool({ toolId: "list_apps" }),
				"apps",
			),
		).toMatchObject({ authorized: true });
		const aliasedWorkTool = tool({
			toolId: "finish_task",
			config: { endpoint: "workItems/complete" },
		});
		expect(
			evaluateMcpToolScopeAuthorization(delegated, aliasedWorkTool, "ops"),
		).toMatchObject({ authorized: false });
		expect(() =>
			assertCodeModeInnerToolAuthorized(delegated, aliasedWorkTool, "ops"),
		).toThrow("Insufficient scope");
	});

	it("permits exact base and aggregate Work reads with delegated Work read scope", () => {
		const delegated = {
			appMetadata: {
				mcpConfig: { toolScopes: { work: ["mcp:work.read"] } },
			} as unknown as ServerContext["appMetadata"],
			callerIdentity: {
				authType: "tedi",
				credentialMode: "delegated-mcp",
				scopes: ["mcp:work.read"],
			} as ServerContext["callerIdentity"],
		};
		const read = tool({
			toolId: "echo__work_items_list",
			config: {
				endpoint: "workItems/list",
				_aggregateNamespace: "echo",
				_aggregateTediRemoteName: "work_items_list",
			},
		});
		expect(
			evaluateMcpToolScopeAuthorization(delegated, read, "echo"),
		).toMatchObject({ authorized: true });
		expect(() =>
			assertCodeModeInnerToolAuthorized(delegated, read, "echo"),
		).not.toThrow();
		const detail = tool({
			toolId: "cto__work_item_get",
			config: {
				endpoint: "workItems/getById",
				_aggregateNamespace: "cto",
				_aggregateTediRemoteName: "work_item_get",
			},
		});
		expect(
			evaluateMcpToolScopeAuthorization(delegated, detail, "cto"),
		).toMatchObject({ authorized: true });
		expect(() =>
			assertCodeModeInnerToolAuthorized(delegated, detail, "cto"),
		).not.toThrow();
		for (const read of [
			tool({
				toolId: "tedix__list_work_items",
				annotations: { readOnlyHint: true },
				config: { endpoint: "workItems/list" },
			}),
			tool({
				toolId: "tedix__get_work_item_readiness",
				annotations: { readOnlyHint: true },
				config: { endpoint: "workItems/getReadiness" },
			}),
			tool({
				toolId: "tedix__list_work_item_attempts",
				annotations: { readOnlyHint: true },
				config: { endpoint: "workItems/listAttempts" },
			}),
		]) {
			expect(
				evaluateMcpToolScopeAuthorization(delegated, read, "work"),
			).toMatchObject({ authorized: true });
		}
	});
	it("enforces explicitly declared scopes for external-agent callers", () => {
		const result = enforceMcpToolScopeAuthorization(
			{
				appMetadata: null,
				callerIdentity: {
					authType: "external_agent",
					scopes: ["mcp:skills"],
				} as ServerContext["callerIdentity"],
			},
			tool({ toolId: "design_widget_ui", authRequired: true }),
			"apps",
			["mcp:apps.read"],
		);

		expect(result?.isError).toBe(true);
		expect(result?.structuredContent).toMatchObject({
			error: "insufficient_scope",
			required_scopes: ["mcp:apps.read"],
			missing_scopes: ["mcp:apps.read"],
		});
	});

	it("allows an exact granular grant and trusted service binding", () => {
		const codeBuiltTool = tool({
			toolId: "register_muscle_memory",
			authRequired: true,
		});
		expect(
			enforceMcpToolScopeAuthorization(
				ctx({}, ["mcp:skills.write"]),
				codeBuiltTool,
				"skills",
				["mcp:skills.write"],
			),
		).toBeNull();
		expect(
			enforceMcpToolScopeAuthorization(
				{
					appMetadata: null,
					callerIdentity: {
						authType: "service",
						scopes: [],
					} as ServerContext["callerIdentity"],
				},
				codeBuiltTool,
				"skills",
				["mcp:skills"],
			),
		).toBeNull();
	});

	it("rejects a code-built tool that omits its capability declaration", () => {
		const result = enforceMcpToolScopeAuthorization(
			ctx({}, ["mcp:apps.read"]),
			tool({ toolId: "new_native_tool" }),
			"native",
		);
		expect(result?.structuredContent).toMatchObject({
			error: "scope_mapping_missing",
			toolId: "new_native_tool",
		});
	});
});

describe("Code Mode inner-tool authorization", () => {
	it("derives the concrete inner tool scope in policy mode", () => {
		const innerTool = tool({ toolId: "memory_search" });

		expect(
			resolveCodeModeInnerToolScopes(innerTool, "memory", {
				enforcePolicies: true,
				toolScopes: { memory_search: ["mcp:memory.read"] },
			}),
		).toEqual(["mcp:memory.search"]);
	});

	it("rejects policy-mode callers that only have the outer code-tool scope", () => {
		const innerTool = tool({ toolId: "memory_search" });

		expect(() =>
			assertCodeModeInnerToolAuthorized(
				ctx({ enforcePolicies: true }, ["mcp:code"]),
				innerTool,
				"memory",
			),
		).toThrow(/mcp:memory\.search/);
	});

	it("uses explicit mcpConfig.toolScopes before fallback scopes", () => {
		const innerTool = tool({ toolId: "content_delete_post" });

		expect(
			resolveCodeModeInnerToolScopes(innerTool, "content", {
				toolScopes: { content_delete_post: ["mcp:content.admin"] },
			}),
		).toEqual(["mcp:content.admin"]);

		expect(() =>
			assertCodeModeInnerToolAuthorized(
				ctx({ toolScopes: { content_delete_post: ["mcp:content.admin"] } }, [
					"mcp:content.admin",
				]),
				innerTool,
				"content",
			),
		).not.toThrow();
	});

	it("rejects removed broad grants for granular configured scopes", () => {
		const innerTool = tool({ toolId: "app_update" });

		expect(
			resolveCodeModeInnerToolScopes(innerTool, "apps", {
				toolScopes: { app_update: ["mcp:apps.write"] },
			}),
		).toEqual(["mcp:apps.write"]);

		expect(() =>
			assertCodeModeInnerToolAuthorized(
				ctx({ toolScopes: { app_update: ["mcp:apps.write"] } }, [
					"mcp:apps.read",
				]),
				innerTool,
				"apps",
			),
		).toThrow(/mcp:apps\.write/);
	});

	it("falls back to authenticated namespace scopes when authMode is omitted", () => {
		const innerTool = tool({ toolId: "memory_search" });

		expect(resolveCodeModeInnerToolScopes(innerTool, "memory", {})).toEqual([
			"mcp:memory.read",
		]);
	});

	it("falls back to the namespace capability when a scoped config omits the tool", () => {
		const innerTool = tool({ toolId: "app_list" });

		expect(
			resolveCodeModeInnerToolScopes(innerTool, "apps", {
				toolScopes: { other_tool: ["mcp:content.write"] },
			}),
		).toEqual(["mcp:apps.read"]);

		expect(() =>
			assertCodeModeInnerToolAuthorized(
				ctx({ toolScopes: { other_tool: ["mcp:content.write"] } }, [
					"mcp:apps.read",
				]),
				innerTool,
				"apps",
			),
		).not.toThrow();
	});

	it("rejects unknown namespaces as configuration errors", () => {
		const innerTool = tool({ toolId: "third_party__mutate" });

		expect(() =>
			resolveCodeModeInnerToolScopes(innerTool, "third_party", {
				toolScopes: { other_tool: ["mcp:content.write"] },
			}),
		).toThrow(/Missing MCP capability mapping/);
	});

	it("scopes a destructive self-service skill run to mcp:skills, not platform admin", () => {
		// run_skill_workflow carries destructiveHint:true. Without the
		// SKILL_SELF_SERVICE override it would hit the isDangerousTool → platform:admin
		// fallback, which a tedi (correctly not a platform admin) lacks, and a
		// tedi's own scheduled skill runs would fail.
		const innerTool = tool({
			toolId: "run_skill_workflow",
			annotations: { destructiveHint: true },
		});

		expect(
			resolveCodeModeInnerToolScopes(innerTool, "skills", {
				toolScopes: { other_tool: ["mcp:content.write"] },
			}),
		).toEqual(["mcp:skills.write"]);

		// A tedi holding mcp:skills (every profile does) is now authorized...
		expect(() =>
			assertCodeModeInnerToolAuthorized(
				ctx({ toolScopes: { other_tool: ["mcp:content.write"] } }, [
					"mcp:skills.write",
				]),
				innerTool,
				"skills",
			),
		).not.toThrow();

		// ...and it no longer demands platform admin.
		expect(
			resolveCodeModeInnerToolScopes(innerTool, "skills", {
				toolScopes: { other_tool: ["mcp:content.write"] },
			}),
		).not.toContain("platform:admin");
	});

	it("keeps promote_skill at admin tier (self-service override does NOT cover it)", () => {
		const innerTool = tool({
			toolId: "promote_skill",
			annotations: { destructiveHint: true },
		});
		expect(
			resolveCodeModeInnerToolScopes(innerTool, "skills", {
				toolScopes: { other_tool: ["mcp:content.write"] },
			}),
		).toEqual(["mcp:skills.admin"]);
	});

	it("escalates ACCESS_LEVEL_OVERRIDES=admin skill tools above the broad mcp:skills every tedi holds", () => {
		// Real promote_skill / quarantine_skill_proposal carry MUTATING (readOnly:
		// false) — not destructiveHint — so before the admin-tier escalation they
		// fell to the broad mcp:skills capability that every profile grants,
		// leaving the intended admin tier dormant.
		for (const toolId of ["promote_skill", "quarantine_skill_proposal"]) {
			const innerTool = tool({ toolId, annotations: { readOnlyHint: false } });
			const required = resolveCodeModeInnerToolScopes(innerTool, "skills", {
				toolScopes: { other_tool: ["mcp:content.write"] },
			});
			expect(required, toolId).toEqual(["mcp:skills.admin"]);
			// A standard tedi has skill read/write but no skill administration.
			expect(
				isMcpToolVisibleToCaller(
					innerTool,
					"skills",
					undefined,
					{ authType: "oauth", scopes: ["mcp:skills.write"] },
					CODE_MODE,
				),
				toolId,
			).toBe(false);
			// An operator profile holding the domain-admin capability is admitted.
			expect(
				isMcpToolVisibleToCaller(
					innerTool,
					"skills",
					undefined,
					{ authType: "oauth", scopes: ["mcp:skills.admin"] },
					CODE_MODE,
				),
				toolId,
			).toBe(true);
		}
	});

	it("resolves own-org governance reads to mcp:settings instead of the unclassified-tool failure", () => {
		// Code Mode namespaces these by endpoint router root: members/connections
		// reads that name no exact rule previously fell to platform:admin (platform),
		// over-gating basic org governance.
		const cases: Array<{ toolId: string; namespace: string }> = [
			{ toolId: "list_members", namespace: "members" },
			{ toolId: "list_connections", namespace: "connections" },
			{ toolId: "get_org_usage", namespace: "org" },
		];
		for (const { toolId, namespace } of cases) {
			const innerTool = tool({ toolId });
			const required = resolveCodeModeInnerToolScopes(innerTool, namespace, {
				toolScopes: { other_tool: ["mcp:content.write"] },
			});
			expect(required, toolId).toEqual(["mcp:settings.read"]);
			// Grants org-admins access they should have; still denies a scopeless caller.
			expect(
				isMcpToolVisibleToCaller(
					innerTool,
					namespace,
					undefined,
					{ authType: "oauth", scopes: [] },
					CODE_MODE,
				),
				toolId,
			).toBe(false);
			expect(
				isMcpToolVisibleToCaller(
					innerTool,
					namespace,
					undefined,
					{ authType: "oauth", scopes: ["mcp:settings.read"] },
					CODE_MODE,
				),
				toolId,
			).toBe(true);
		}
	});

	it("resolves the tenant API-key lifecycle to settings read and admin tiers", () => {
		const cases: Array<{ toolId: string; requiredScope: string }> = [
			{ toolId: "list_api_keys", requiredScope: "mcp:settings.read" },
			{ toolId: "get_expiring_keys", requiredScope: "mcp:settings.read" },
			{ toolId: "create_api_key", requiredScope: "mcp:settings.admin" },
			{ toolId: "rotate_api_key", requiredScope: "mcp:settings.admin" },
			{ toolId: "revoke_api_key", requiredScope: "mcp:settings.admin" },
			{ toolId: "delete_api_key", requiredScope: "mcp:settings.admin" },
		];

		for (const { toolId, requiredScope } of cases) {
			const innerTool = tool({ toolId, authRequired: true });
			expect(
				resolveCodeModeInnerToolScopes(innerTool, "organizations", {}),
				toolId,
			).toEqual([requiredScope]);
			expect(
				isMcpToolVisibleToCaller(
					innerTool,
					"organizations",
					undefined,
					{ authType: "oauth", scopes: [requiredScope] },
					CODE_MODE,
				),
				toolId,
			).toBe(true);
		}
	});

	it("authorizes workflow status reads with the observe capability", () => {
		const innerTool = tool({ toolId: "get_workflow_status" });

		expect(
			resolveCodeModeInnerToolScopes(innerTool, "tedix", {
				toolScopes: { other_tool: ["mcp:content.write"] },
			}),
		).toEqual(["mcp:observe.read"]);

		expect(() =>
			assertCodeModeInnerToolAuthorized(
				ctx({ toolScopes: { other_tool: ["mcp:content.write"] } }, [
					"mcp:observe.read",
				]),
				innerTool,
				"tedix",
			),
		).not.toThrow();
	});

	it("authorizes Home kernel tools with the org messaging capability", () => {
		const innerTool = tool({ toolId: "ask" });

		expect(
			resolveCodeModeInnerToolScopes(innerTool, "home", {
				toolScopes: { content: ["mcp:content.write"] },
			}),
		).toEqual(["mcp:messaging.read"]);

		expect(() =>
			assertCodeModeInnerToolAuthorized(
				ctx({ toolScopes: { content: ["mcp:content.write"] } }, [
					"mcp:messaging.read",
				]),
				innerTool,
				"home",
			),
		).not.toThrow();
	});

	it("authorizes role tedi message bridges with the org messaging capability", () => {
		const innerTool = tool({ toolId: "operator__run_tedi_turn" });

		expect(
			resolveCodeModeInnerToolScopes(innerTool, "operator", {
				toolScopes: { content: ["mcp:content.write"] },
			}),
		).toEqual(["mcp:messaging.write"]);

		expect(() =>
			assertCodeModeInnerToolAuthorized(
				ctx({ toolScopes: { content: ["mcp:content.write"] } }, [
					"mcp:messaging.write",
				]),
				innerTool,
				"operator",
			),
		).not.toThrow();
	});

	it("authorizes role tedi spoken-reply synthesis with the org messaging capability", () => {
		const innerTool = tool({ toolId: "operator__synthesize_spoken_reply" });

		expect(
			resolveCodeModeInnerToolScopes(innerTool, "operator", {
				toolScopes: { content: ["mcp:content.write"] },
			}),
		).toEqual(["mcp:messaging.write"]);

		expect(() =>
			assertCodeModeInnerToolAuthorized(
				ctx({ toolScopes: { content: ["mcp:content.write"] } }, [
					"mcp:messaging.write",
				]),
				innerTool,
				"operator",
			),
		).not.toThrow();
	});

	it("authorizes role tedi skill tools with the org skills capability", () => {
		const innerTool = tool({ toolId: "operator__run_skill_workflow" });

		expect(
			resolveCodeModeInnerToolScopes(innerTool, "operator", {
				toolScopes: { content: ["mcp:content.write"] },
			}),
		).toEqual(["mcp:skills.write"]);

		expect(() =>
			assertCodeModeInnerToolAuthorized(
				ctx({ toolScopes: { content: ["mcp:content.write"] } }, [
					"mcp:skills.write",
				]),
				innerTool,
				"operator",
			),
		).not.toThrow();
	});

	it("authorizes governed role tedi cron tools with the org apps capability", () => {
		const innerTool = tool({
			toolId: "operator__cron",
			annotations: { destructiveHint: true },
		});

		expect(
			resolveCodeModeInnerToolScopes(innerTool, "operator", {
				toolScopes: { content: ["mcp:content.write"] },
			}),
		).toEqual(["mcp:apps.admin"]);

		expect(() =>
			assertCodeModeInnerToolAuthorized(
				ctx({ toolScopes: { content: ["mcp:content.write"] } }, [
					"mcp:apps.admin",
				]),
				innerTool,
				"operator",
			),
		).not.toThrow();

		expect(
			isMcpToolVisibleToCaller(
				innerTool,
				"operator",
				{ toolScopes: { content: ["mcp:content.write"] } },
				{ authType: "oauth", scopes: ["mcp:apps.admin"] },
			),
		).toBe(true);
		expect(
			isMcpToolVisibleToCaller(
				innerTool,
				"operator",
				{ toolScopes: { content: ["mcp:content.write"] } },
				{ authType: "oauth", scopes: ["mcp:settings"] },
			),
		).toBe(false);
	});

	it("authorizes role tedi Work Item collaboration with the org messaging capability", () => {
		for (const toolId of [
			"cmo__create_work_item",
			"cmo__update_work_item",
			"cmo__cancel_work_item",
			"cmo__get_work_item",
			"cmo__work_item_get",
			"cmo__list_work_items",
			"cmo__work_items_list",
			"cmo__work_item_comment",
			"cmo__work_item_heartbeat",
			"tedix__get_work_items_by_id",
			"tedix__update_work_items",
		]) {
			const innerTool = tool({ toolId });
			const required = resolveCodeModeInnerToolScopes(innerTool, "cmo", {
				toolScopes: { content: ["mcp:content.write"] },
			});
			expect(required).toHaveLength(1);
			expect(required[0], toolId).toMatch(/^mcp:work\.(read|write|admin)$/);
			expect(() =>
				assertCodeModeInnerToolAuthorized(
					ctx({ toolScopes: { content: ["mcp:content.write"] } }, required),
					innerTool,
					"cmo",
				),
			).not.toThrow();
		}
	});

	it("keeps destructive Work Item bulk operations at admin tier", () => {
		const innerTool = tool({
			toolId: "cmo__bulk_cancel_work_items",
			annotations: { destructiveHint: true },
		});

		expect(
			resolveCodeModeInnerToolScopes(innerTool, "cmo", {
				toolScopes: { content: ["mcp:content.write"] },
			}),
		).toEqual(["mcp:work.admin"]);
	});

	it("authorizes explicitly scoped PromptWatch tools without platform admin", () => {
		const innerTool = tool({ toolId: "promptwatch_tedix__update_persona" });
		const mcpConfig = {
			toolScopes: { promptwatch_tedix: ["mcp:content.write"] },
		};

		expect(
			resolveCodeModeInnerToolScopes(innerTool, "promptwatch_tedix", mcpConfig),
		).toEqual(["mcp:content.write"]);
		expect(() =>
			assertCodeModeInnerToolAuthorized(
				ctx(mcpConfig, ["mcp:content.write"]),
				innerTool,
				"promptwatch_tedix",
			),
		).not.toThrow();
	});

	it("authorizes direct skills namespace tools with the org skills capability", () => {
		const innerTool = tool({ toolId: "validate_skill" });

		expect(resolveCodeModeInnerToolScopes(innerTool, "skills", {})).toEqual([
			"mcp:skills.read",
		]);
	});

	it("rejects unknown namespaces on public apps", () => {
		const innerTool = tool({ toolId: "third_party__read" });

		expect(() =>
			resolveCodeModeInnerToolScopes(innerTool, "third_party", {
				authMode: "public",
			}),
		).toThrow(/Missing MCP capability mapping/);
	});

	// The whole domain-less workstation set, not just `read`: each of these is
	// registered UNPREFIXED on a tedi's own MCP server, so a name alone must
	// never let an unmapped namespace borrow `mcp:tedis`.
	it("rejects every bare workstation name behind an unknown namespace", () => {
		for (const name of [
			"exec",
			"read",
			"write",
			"edit",
			"delete",
			"ls",
			"find",
			"grep",
			"code_search",
		]) {
			expect(() =>
				resolveCodeModeInnerToolScopes(
					tool({ toolId: `third_party__${name}` }),
					"third_party",
					{ authMode: "public" },
				),
			).toThrow(/Missing MCP capability mapping/);
		}
	});

	it("authorizes workstation tools for configured aggregate tedi namespaces", () => {
		const mcpConfig = {
			authMode: "authenticated",
			aggregateTedis: [
				{ slug: "cpo", namespace: "cpo" },
				{ slug: "cto", namespace: "cto" },
			],
		};

		for (const [name, scope] of [
			["exec", "mcp:tedis.write"],
			["read", "mcp:tedis.read"],
			["write", "mcp:tedis.write"],
			["code_search", "mcp:tedis.read"],
		] as const) {
			expect(
				resolveCodeModeInnerToolScopes(
					tool({ toolId: `cpo__${name}` }),
					"cpo",
					mcpConfig,
				),
			).toEqual([scope]);
		}

		expect(() =>
			resolveCodeModeInnerToolScopes(
				tool({ toolId: "third_party__exec" }),
				"third_party",
				mcpConfig,
			),
		).toThrow(/Missing MCP capability mapping/);
	});

	// The counterweight: a tedi-slug namespace is unknown too, and these tools
	// must keep resolving by their own domain-carrying names. Narrowing on the
	// namespace instead of the tool name would have failed these closed.
	it("keeps domain-carrying tools resolving under a tedi-slug namespace", () => {
		expect(
			resolveCodeModeInnerToolScopes(
				tool({ toolId: "ceo__messages_read" }),
				"ceo",
				{ authMode: "public" },
			),
		).toEqual(["mcp:messaging.read"]);
		expect(
			resolveCodeModeInnerToolScopes(
				tool({ toolId: "cto__work_item_get" }),
				"cto",
				{ authMode: "public" },
			),
		).toEqual(["mcp:work.read"]);
	});

	it("requires admin for dangerous tools that only have fallback authorization", () => {
		const innerTool = tool({
			toolId: "app_delete",
			annotations: { destructiveHint: true },
		});

		expect(
			resolveCodeModeInnerToolScopes(innerTool, "apps", {
				toolScopes: { other_tool: ["mcp:content.write"] },
			}),
		).toEqual(["mcp:apps.admin"]);

		expect(() =>
			assertCodeModeInnerToolAuthorized(
				ctx({ toolScopes: { other_tool: ["mcp:content.write"] } }, [
					"mcp:apps.read",
				]),
				innerTool,
				"apps",
			),
		).toThrow(/mcp:apps.admin/);
	});

	it("does not let an empty configured scope make a dangerous tool public", () => {
		const innerTool = tool({
			toolId: "app_delete",
			annotations: { destructiveHint: true },
		});

		expect(
			resolveCodeModeInnerToolScopes(innerTool, "apps", {
				toolScopes: { app_delete: [] },
			}),
		).toEqual(["mcp:apps.admin"]);
	});

	it("requires authentication before executing private inner tools", () => {
		const innerTool = tool({
			toolId: "memory_search",
			visibility: "private",
		});

		expect(() =>
			assertCodeModeInnerToolAuthorized(
				ctx({ authMode: "hybrid" }, undefined),
				innerTool,
				"memory",
			),
		).toThrow(/Authentication required/);
	});
});

describe("MCP tools/list visibility authorization", () => {
	it("keeps public tools visible when no scopes are required", () => {
		expect(
			isMcpToolVisibleToCaller(
				tool({ toolId: "catalog_search" }),
				"catalog",
				{ authMode: "public" },
				{ scopes: [] },
			),
		).toBe(true);
	});

	it("hides private tools from unauthenticated hybrid callers", () => {
		expect(
			isMcpToolVisibleToCaller(
				tool({ toolId: "memory_search", visibility: "private" }),
				"memory",
				{ authMode: "hybrid" },
				{ scopes: [] },
			),
		).toBe(false);
	});

	it("hides scoped tools when the caller is missing the required scope", () => {
		expect(
			isMcpToolVisibleToCaller(
				tool({ toolId: "apps_list" }),
				"apps",
				{ toolScopes: { apps_list: ["mcp:apps.read"] } },
				{ authType: "oauth", scopes: ["mcp:catalog"] },
			),
		).toBe(false);
	});

	it("hides scoped tools from removed broad capability grants", () => {
		expect(
			isMcpToolVisibleToCaller(
				tool({ toolId: "apps_list" }),
				"apps",
				{ toolScopes: { apps_list: ["mcp:apps.read"] } },
				{ authType: "oauth", scopes: ["mcp:apps"] },
			),
		).toBe(false);
	});

	it("hides dangerous fallback tools unless the caller has admin scope", () => {
		const dangerousTool = tool({
			toolId: "apps_delete",
			annotations: { destructiveHint: true },
		});

		expect(
			isMcpToolVisibleToCaller(
				dangerousTool,
				"apps",
				{ toolScopes: { other_tool: ["mcp:apps.read"] } },
				{ authType: "oauth", scopes: ["mcp:apps.read"] },
			),
		).toBe(false);
		expect(
			isMcpToolVisibleToCaller(
				dangerousTool,
				"apps",
				{ toolScopes: { other_tool: ["mcp:apps.read"] } },
				{ authType: "oauth", scopes: ["mcp:apps.admin"] },
			),
		).toBe(true);
	});

	it("exposes guarded tedi access-key rotation to tenant tedi admins", () => {
		const rotateAccessKey = tool({
			toolId: "rotate_access_key",
			authRequired: true,
			visibility: "private",
		});

		expect(
			resolveCodeModeInnerToolScopes(rotateAccessKey, "tedis", {
				toolScopes: { other_tool: ["platform:admin"] },
			}),
		).toEqual(["mcp:tedis.admin"]);
		expect(
			isMcpToolVisibleToCaller(
				rotateAccessKey,
				"tedis",
				{ toolScopes: { other_tool: ["platform:admin"] } },
				{ authType: "oauth", scopes: ["mcp:tedis.admin"] },
			),
		).toBe(true);

		const otherRotation = tool({ toolId: "rotate_signing_key" });
		expect(
			isMcpToolVisibleToCaller(
				otherRotation,
				"tedis",
				{ toolScopes: { other_tool: ["mcp:tedis.read"] } },
				{ authType: "oauth", scopes: ["mcp:tedis.read"] },
			),
		).toBe(false);
	});
});

it("requires tenant administration for Work configuration even with destructive annotations", () => {
	for (const name of ["put_work_resource_pool", "put_work_budget_envelope"]) {
		const entry = tool({
			toolId: `tedix__${name}`,
			authRequired: true,
			annotations: { destructiveHint: true },
		});
		expect(resolveCodeModeInnerToolScopes(entry, "workItems", {})).toEqual([
			"mcp:settings.admin",
		]);
		expect(
			isMcpToolVisibleToCaller(
				entry,
				"workItems",
				{},
				{
					authType: "jwt",
					scopes: ["mcp:settings.read", "mcp:settings.write"],
				},
			),
		).toBe(false);
		expect(
			isMcpToolVisibleToCaller(
				entry,
				"workItems",
				{},
				{ authType: "jwt", scopes: ["mcp:settings.admin"] },
			),
		).toBe(true);
		expect(
			resolveCodeModeInnerToolScopes(entry, "workItems", {
				toolScopes: { [entry.toolId]: ["platform:admin"] },
			}),
		).toEqual(["platform:admin"]);
	}
});

describe("Code Mode reviewed provider reads", () => {
	const connected = (writeCapability: "read" | "write" | "destructive") =>
		tool({
			toolId: "vendor__operate_record",
			writeCapability,
			config: {
				auth: { type: "connection", connectionId: "vendor" },
				connectionReadOnly: true,
			},
		});
	it("dispatches reviewed reads but blocks ordinary and destructive writes", () => {
		const reader = ctx({}, ["connections.read"]);
		expect(() =>
			assertCodeModeInnerToolAuthorized(
				reader,
				connected("read"),
				"vendor",
				{},
			),
		).not.toThrow();
		expect(() =>
			assertCodeModeInnerToolAuthorized(
				reader,
				connected("write"),
				"vendor",
				{},
			),
		).toThrow(/connections.execute/);
		expect(() =>
			assertCodeModeInnerToolAuthorized(
				reader,
				connected("destructive"),
				"vendor",
				{},
			),
		).toThrow(/connections.execute/);
	});
});
