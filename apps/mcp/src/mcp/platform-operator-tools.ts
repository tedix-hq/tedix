import {
	WORKFLOW_DEFINITIONS_WIDGET,
	WORKFLOW_HEALTH_WIDGET,
} from "@tedix/api-contract/contracts/workflows";

/**
 * Slug of the aggregator MCP surface that re-exports platform-operator tools
 * (the `tedix-unified` bundle resolved by `platform-operator-aggregation.ts`).
 *
 * not the D1 row owner: the actual `app_tools` rows for these tool ids are
 * persisted under the canonical `tedix` admin app, resolved by slug. See
 * the retired operator-annotation backfill (PLATFORM_OPERATOR_ROW_APP_SLUG)
 * and `apps/api/src/services/tool-schema-sync.ts` (TEDIX_ADMIN_APP_SLUG).
 */
export const PLATFORM_OPERATOR_APP_SLUG = "tedix-unified";

type OperatorToolKind = "read" | "write" | "destructive";

interface PlatformOperatorToolDefinition {
	toolId: string;
	endpoint: string;
	kind: OperatorToolKind;
	description?: string;
	widget?: PlatformOperatorWidgetDefinition;
}

interface PlatformOperatorWidgetDefinition {
	layoutId: string;
	description: string;
	layoutSpec: Record<string, unknown>;
}

export const PLATFORM_OPERATOR_TOOL_DEFINITIONS = [
	// Tedix OS workspace domain (osWorkspaces, D1-canonical). The OS domain
	// owns the `os` namespace outright.
	{
		toolId: "list_os_workspaces",
		endpoint: "osWorkspaces/workspaces/list",
		kind: "read",
	},
	{
		toolId: "create_os_workspace",
		endpoint: "osWorkspaces/workspaces/create",
		kind: "write",
	},
	{
		toolId: "get_os_workspace",
		endpoint: "osWorkspaces/workspaces/get",
		kind: "read",
	},
	{
		toolId: "update_os_workspace",
		endpoint: "osWorkspaces/workspaces/update",
		kind: "write",
	},
	{
		toolId: "archive_os_workspace",
		endpoint: "osWorkspaces/workspaces/archive",
		kind: "write",
	},
	{
		toolId: "list_os_workspace_preferences",
		endpoint: "osWorkspaces/workspacePreferences/list",
		kind: "read",
	},
	{
		toolId: "set_os_workspace_favorite",
		endpoint: "osWorkspaces/workspacePreferences/setFavorite",
		kind: "write",
	},
	{
		toolId: "touch_os_workspace",
		endpoint: "osWorkspaces/workspacePreferences/touch",
		kind: "write",
	},
	{
		toolId: "list_os_workspace_resources",
		endpoint: "osWorkspaces/resources/list",
		kind: "read",
	},
	{
		toolId: "create_os_workspace_resource",
		endpoint: "osWorkspaces/resources/create",
		kind: "write",
	},
	{
		toolId: "get_os_workspace_resource",
		endpoint: "osWorkspaces/resources/get",
		kind: "read",
	},
	{
		toolId: "read_os_workspace_pdf",
		endpoint: "osWorkspaces/resources/readPdf",
		kind: "read",
	},
	{
		toolId: "rename_os_workspace_resource",
		endpoint: "osWorkspaces/resources/rename",
		kind: "write",
	},
	{
		toolId: "remove_os_workspace_resource",
		endpoint: "osWorkspaces/resources/remove",
		kind: "write",
	},
	{
		toolId: "list_os_gadgets",
		endpoint: "osWorkspaces/gadgets/list",
		kind: "read",
	},
	{
		toolId: "create_os_gadget",
		endpoint: "osWorkspaces/gadgets/create",
		kind: "write",
	},
	{
		toolId: "get_os_gadget",
		endpoint: "osWorkspaces/gadgets/get",
		kind: "read",
	},
	{
		toolId: "revise_os_gadget",
		endpoint: "osWorkspaces/gadgets/revise",
		kind: "write",
	},
	{
		toolId: "archive_os_gadget",
		endpoint: "osWorkspaces/gadgets/archive",
		kind: "write",
	},
	{
		toolId: "run_os_gadget",
		endpoint: "osWorkspaces/gadgets/run",
		kind: "destructive",
	},
	{
		toolId: "delete_os_gadget",
		endpoint: "osWorkspaces/gadgets/delete",
		kind: "destructive",
	},
	{
		toolId: "list_os_gadget_executions",
		endpoint: "osWorkspaces/executions/list",
		kind: "read",
	},
	{
		toolId: "get_os_gadget_execution",
		endpoint: "osWorkspaces/executions/get",
		kind: "read",
	},
	{
		toolId: "list_os_blueprints",
		endpoint: "osWorkspaces/blueprints/list",
		kind: "read",
	},
	{
		toolId: "create_os_blueprint",
		endpoint: "osWorkspaces/blueprints/create",
		kind: "write",
	},
	{
		toolId: "get_os_blueprint",
		endpoint: "osWorkspaces/blueprints/get",
		kind: "read",
	},
	{
		toolId: "revise_os_blueprint",
		endpoint: "osWorkspaces/blueprints/revise",
		kind: "write",
	},
	{
		toolId: "publish_os_blueprint",
		endpoint: "osWorkspaces/blueprints/publish",
		kind: "write",
	},
	{
		toolId: "instantiate_os_blueprint",
		endpoint: "osWorkspaces/blueprints/instantiate",
		kind: "write",
	},
	{
		toolId: "list_os_outputs",
		endpoint: "osWorkspaces/outputs/list",
		kind: "read",
	},
	{
		toolId: "create_os_output",
		endpoint: "osWorkspaces/outputs/create",
		kind: "write",
	},
	{
		toolId: "get_os_output",
		endpoint: "osWorkspaces/outputs/get",
		kind: "read",
	},
	{
		toolId: "revise_os_output",
		endpoint: "osWorkspaces/outputs/revise",
		kind: "write",
	},
	{
		toolId: "patch_os_document",
		endpoint: "osWorkspaces/outputs/patchDocument",
		kind: "write",
	},
	{
		toolId: "patch_os_slides",
		endpoint: "osWorkspaces/outputs/patchSlides",
		kind: "write",
	},
	{
		toolId: "set_os_sheet_range",
		endpoint: "osWorkspaces/outputs/setSheetRange",
		kind: "write",
	},
	{
		toolId: "export_os_output",
		endpoint: "osWorkspaces/outputs/export",
		kind: "write",
	},
	{
		toolId: "archive_os_output",
		endpoint: "osWorkspaces/outputs/archive",
		kind: "write",
	},
	// External-agent identity lifecycle. Session bootstrap remains a dedicated
	// edge exchange and internal session resolution/attribution are never tools.
	{
		toolId: "create_external_agent_principal",
		endpoint: "externalAgentIdentity/createPrincipal",
		kind: "write",
	},
	{
		toolId: "record_external_agent_knowledge_checkpoint",
		endpoint: "externalAgentIdentity/recordKnowledgeCheckpoint",
		kind: "write",
	},
	{
		toolId: "record_external_agent_knowledge_disposition",
		endpoint: "externalAgentIdentity/recordKnowledgeDisposition",
		kind: "write",
	},
	{
		toolId: "end_external_agent_session",
		endpoint: "externalAgentIdentity/endSession",
		kind: "destructive",
	},
	{
		toolId: "retire_abandoned_external_agent_session",
		endpoint: "externalAgentIdentity/retireAbandonedSession",
		kind: "destructive",
	},
	{
		toolId: "revoke_external_agent_mcp_credential",
		endpoint: "externalAgentIdentity/revokeMcpCredential",
		kind: "destructive",
	},
	{
		toolId: "list_stale_external_agent_knowledge_sessions",
		endpoint: "externalAgentIdentity/listStaleKnowledgeSessions",
		kind: "read",
	},
	// Catalog lifecycle.
	{ toolId: "list_catalog_apps", endpoint: "catalog/list", kind: "read" },
	{ toolId: "get_catalog_app", endpoint: "catalog/getBySlug", kind: "read" },
	{
		toolId: "get_catalog_categories",
		endpoint: "catalog/getCategories",
		kind: "read",
	},
	{
		toolId: "get_catalog_stats",
		endpoint: "catalog/getStats",
		kind: "read",
		widget: {
			layoutId: "catalog-stats",
			description: "Catalog stats summary with source breakdown.",
			layoutSpec: {
				root: "shell",
				elements: {
					shell: {
						type: "Stack",
						props: { gap: 4 },
						children: ["stats", "sources"],
					},
					stats: {
						type: "StatGrid",
						props: {
							columns: { mobile: 1, tablet: 2, desktop: 4 },
							density: "compact",
							stats: [
								{
									label: "Catalog apps",
									value: { $state: "/total" },
									tone: "info",
								},
								{
									label: "MCP apps",
									value: { $state: "/mcp" },
									tone: "success",
								},
								{
									label: "Interactive",
									value: { $state: "/withInteractive" },
									tone: "default",
								},
								{
									label: "Write tools",
									value: { $state: "/withWrites" },
									tone: "warning",
								},
							],
						},
						children: [],
					},
					sources: {
						type: "DataTable",
						props: {
							data: { $state: "/sourceBreakdown" },
							columns: [
								{
									field: "source",
									header: "Source",
									format: "badge",
									sortable: true,
								},
								{
									field: "count",
									header: "Apps",
									format: "number",
									sortable: true,
								},
							],
							pageSize: 10,
							compact: true,
							striped: true,
						},
						children: [],
					},
				},
			},
		},
	},
	{
		toolId: "get_catalog_health_summary",
		endpoint: "catalog/getHealthSummary",
		kind: "read",
		widget: {
			layoutId: "catalog-health-summary",
			description:
				"Catalog health, scan backlog, and persisted MCP protocol-era inventory for compatibility removal decisions.",
			layoutSpec: {
				root: "stats",
				elements: {
					stats: {
						type: "StatGrid",
						props: {
							columns: { mobile: 1, tablet: 2, desktop: 4 },
							density: "compact",
							stats: [
								{ label: "Total", value: { $state: "/total" }, tone: "info" },
								{
									label: "Healthy",
									value: { $state: "/healthy" },
									tone: "success",
								},
								{
									label: "Degraded",
									value: { $state: "/degraded" },
									tone: "warning",
								},
								{
									label: "Unhealthy",
									value: { $state: "/unhealthy" },
									tone: "danger",
								},
								{
									label: "Requires auth",
									value: { $state: "/requiresAuth" },
									tone: "default",
								},
								{
									label: "Blocked",
									value: { $state: "/blocked" },
									tone: "danger",
								},
								{
									label: "Unsupported",
									value: { $state: "/unsupported" },
									tone: "warning",
								},
								{
									label: "Unknown",
									value: { $state: "/unknown" },
									tone: "default",
								},
							],
						},
						children: [],
					},
				},
			},
		},
	},
	{
		toolId: "get_catalog_sync_logs",
		endpoint: "catalog/getSyncLogs",
		kind: "read",
		widget: {
			layoutId: "catalog-sync-logs",
			description: "Recent catalog sync workflow logs.",
			layoutSpec: {
				root: "table",
				elements: {
					table: {
						type: "DataTable",
						props: {
							data: { $state: "/logs" },
							columns: [
								{
									field: "syncType",
									header: "Type",
									format: "badge",
									sortable: true,
								},
								{
									field: "source",
									header: "Source",
									format: "text",
									sortable: true,
								},
								{
									field: "status",
									header: "Status",
									format: "badge",
									sortable: true,
								},
								{
									field: "appsDiscovered",
									header: "Discovered",
									format: "number",
									sortable: true,
								},
								{
									field: "appsUpdated",
									header: "Updated",
									format: "number",
									sortable: true,
								},
								{
									field: "appsFailed",
									header: "Failed",
									format: "number",
									sortable: true,
								},
								{
									field: "startedAt",
									header: "Started",
									format: "date",
									sortable: true,
								},
								{
									field: "completedAt",
									header: "Completed",
									format: "date",
									sortable: true,
								},
								{
									field: "error",
									header: "Error",
									format: "text",
									sortable: false,
								},
							],
							pageSize: 10,
							compact: true,
							striped: true,
						},
						children: [],
					},
				},
			},
		},
	},
	{
		toolId: "trigger_catalog_sync",
		endpoint: "catalog/triggerSync",
		kind: "write",
	},
	{
		toolId: "sync_claude_registry",
		endpoint: "catalog/syncClaudeRegistry",
		kind: "write",
	},
	{
		toolId: "trigger_catalog_scan",
		endpoint: "catalog/triggerScan",
		kind: "write",
	},
	{
		toolId: "install_catalog_app",
		endpoint: "catalog/installFromCatalog",
		kind: "write",
	},
	{
		toolId: "create_mcp_connection_provider",
		endpoint: "connections/createProviderFromMcp",
		kind: "write",
		description:
			"Provision or update a Descope AIH outbound connection provider from a catalog MCP app or upstream MCP endpoint. OAuth apps discover protected-resource metadata, authorization-server metadata, DCR registration endpoint, scopes, and resource parameters automatically; API-key apps create a Custom API Key connection provider.",
	},
	{
		toolId: "create_connection_provider",
		endpoint: "connections/createProvider",
		kind: "write",
		description:
			"Create a governed OAuth or API-key provider with explicit configuration. Use only when upstream discovery cannot safely provision the provider; client secrets are accepted only for secure storage and are never returned.",
	},
	{
		toolId: "initiate_connection",
		endpoint: "connections/initiateConnection",
		kind: "write",
		description:
			"Create a Descope OAuth authorization URL for an outbound connection provider. Use this after provisioning an OAuth provider to let an operator or tenant admin complete the interactive grant; no credential or token is returned.",
	},
	{
		toolId: "store_connection_api_key",
		endpoint: "connections/storeApiKey",
		kind: "write",
		description:
			"Upload a tenant-scoped or user-scoped API key/PAT credential into Descope AIH Token Vault for an outbound connection provider. Provider-specific credentialFields are composed server-side; the secret is never returned.",
	},
	{
		toolId: "list_descope_aih_mcp_servers",
		endpoint: "descopeAih/listMcpServers",
		kind: "read",
		description:
			"List Descope Agentic Identity Hub MCP servers registered for this project, including approved scopes and AIH metadata.",
	},
	{
		toolId: "load_descope_aih_mcp_server",
		endpoint: "descopeAih/loadMcpServer",
		kind: "read",
		description:
			"Load one Descope Agentic Identity Hub MCP server by resource id.",
	},
	{
		toolId: "search_descope_aih_mcp_clients",
		endpoint: "descopeAih/searchMcpClients",
		kind: "read",
		description:
			"Search Descope AIH MCP server clients for a server. Use this to inspect Codex/Claude/tedi client scopes, tags, and verification state.",
	},
	{
		toolId: "audit_descope_aih_drift",
		endpoint: "descopeAih/auditDrift",
		kind: "read",
		description:
			"Read-only drift audit comparing Descope AIH MCP servers, MCP clients, outbound apps, tenants, roles, and Tedix D1 references.",
	},
	{
		toolId: "repair_stale_descope_fga_relation",
		endpoint: "descopeAih/repairStaleFgaRelation",
		kind: "destructive",
		description:
			"Delete one exact Descope FGA relation only after proving its referenced app no longer exists in D1. Defaults to dryRun=true.",
	},
	{
		toolId: "repair_descope_devtool_dcr_clients",
		endpoint: "descopeAih/repairDevtoolDcrClients",
		kind: "write",
		description:
			"Repair/tag/scope devtool DCR clients such as Codex on a Descope AIH MCP server. Defaults to dryRun=true; pass dryRun=false to mutate client scopes/tags.",
	},
	{
		toolId: "update_descope_aih_mcp_client",
		endpoint: "descopeAih/updateMcpClient",
		kind: "write",
		description:
			"Update a Descope AIH MCP server client scopes/tags/callback metadata. Use narrowly; prefer repair_descope_devtool_dcr_clients for Codex/Claude DCR repairs.",
	},
	{
		toolId: "delete_descope_aih_mcp_client",
		endpoint: "descopeAih/deleteMcpClient",
		kind: "destructive",
		description:
			"Delete a Descope AIH MCP server client by id. Use only for stale duplicate DCR/debug clients after audit.",
	},
	{
		toolId: "get_app_changelog",
		endpoint: "catalog/getAppChangelog",
		kind: "read",
	},
	{
		toolId: "get_recent_catalog_changes",
		endpoint: "catalog/getRecentChanges",
		kind: "read",
	},
	{
		toolId: "run_catalog_test",
		endpoint: "catalog/triggerToolTest",
		kind: "write",
	},
	{
		toolId: "get_tool_tests",
		endpoint: "catalog/getToolTests",
		kind: "read",
		widget: {
			layoutId: "catalog-tool-tests",
			description: "Catalog MCP tool test history.",
			layoutSpec: {
				root: "shell",
				elements: {
					shell: {
						type: "Stack",
						props: { gap: 4 },
						children: ["summary", "table"],
					},
					summary: {
						type: "KeyValuePanel",
						props: {
							variant: "plain",
							columns: 3,
							items: [
								{ label: "Total", value: { $state: "/total" } },
								{ label: "Limit", value: { $state: "/pagination/limit" } },
								{
									label: "Has more",
									value: { $state: "/pagination/hasMore" },
								},
							],
						},
						children: [],
					},
					table: {
						type: "DataTable",
						props: {
							data: { $state: "/tests" },
							columns: [
								{
									field: "toolName",
									header: "Tool",
									format: "text",
									sortable: true,
								},
								{
									field: "testType",
									header: "Type",
									format: "badge",
									sortable: true,
								},
								{
									field: "success",
									header: "Passed",
									format: "badge",
									sortable: true,
								},
								{
									field: "latencyMs",
									header: "Latency",
									format: "number",
									sortable: true,
								},
								{
									field: "errorClass",
									header: "Error",
									format: "badge",
									sortable: true,
								},
								{
									field: "outputValid",
									header: "Output",
									format: "badge",
									sortable: true,
								},
								{
									field: "testedAt",
									header: "Tested",
									format: "date",
									sortable: true,
								},
							],
							pageSize: 10,
							compact: true,
							striped: true,
						},
						children: [],
					},
				},
			},
		},
	},
	{
		toolId: "get_tool_test_stats",
		endpoint: "catalog/getToolTestStats",
		kind: "read",
		widget: {
			layoutId: "catalog-tool-test-stats",
			description: "Catalog MCP tool test coverage and pass-rate summary.",
			layoutSpec: {
				root: "stats",
				elements: {
					stats: {
						type: "StatGrid",
						props: {
							columns: { mobile: 1, tablet: 2, desktop: 4 },
							density: "compact",
							stats: [
								{
									label: "Total tools",
									value: { $state: "/totalTools" },
									tone: "info",
								},
								{
									label: "Tested",
									value: { $state: "/testedTools" },
									tone: "success",
								},
								{
									label: "Untested",
									value: { $state: "/untestedTools" },
									tone: "warning",
								},
								{
									label: "Total tests",
									value: { $state: "/totalTests" },
									tone: "default",
								},
								{
									label: "Passed",
									value: { $state: "/successfulTests" },
									tone: "success",
								},
								{
									label: "Failed",
									value: { $state: "/failedTests" },
									tone: "danger",
								},
								{
									label: "Success rate",
									value: { $state: "/overallSuccessRate" },
									tone: "success",
								},
								{
									label: "Avg latency",
									value: { $state: "/avgLatencyMs" },
									tone: "info",
								},
							],
						},
						children: [],
					},
				},
			},
		},
	},
	{
		toolId: "get_drift_reports",
		endpoint: "catalog/getDriftReports",
		kind: "read",
		widget: {
			layoutId: "catalog-drift-reports",
			description: "Catalog drift reports table.",
			layoutSpec: {
				root: "table",
				elements: {
					table: {
						type: "DataTable",
						props: {
							data: { $state: "/reports" },
							columns: [
								{
									field: "catalogAppName",
									header: "App",
									format: "text",
									sortable: true,
								},
								{
									field: "addedTools",
									header: "Added",
									format: "number",
									sortable: true,
								},
								{
									field: "removedTools",
									header: "Removed",
									format: "number",
									sortable: true,
								},
								{
									field: "changedTools",
									header: "Changed",
									format: "number",
									sortable: true,
								},
								{
									field: "checkedAt",
									header: "Checked",
									format: "date",
									sortable: true,
								},
								{
									field: "resolvedAt",
									header: "Resolved",
									format: "date",
									sortable: true,
								},
								{
									field: "summary",
									header: "Summary",
									format: "text",
									sortable: false,
								},
							],
							pageSize: 10,
							compact: true,
							striped: true,
						},
						children: [],
					},
				},
			},
		},
	},
	{
		toolId: "backfill_tool_provenance",
		endpoint: "catalog/backfillToolProvenance",
		kind: "write",
	},
	{
		toolId: "check_catalog_integrity",
		endpoint: "catalog/checkIntegrity",
		kind: "write",
	},
	{
		toolId: "propagate_tools",
		endpoint: "catalog/propagateTools",
		kind: "write",
	},
	{
		toolId: "create_base_app_from_catalog",
		endpoint: "catalog/createBaseAppFromCatalog",
		kind: "write",
	},
	{
		toolId: "sync_catalog_tools_to_app",
		endpoint: "catalog/syncCatalogToolsToApp",
		kind: "write",
	},
	{
		toolId: "install_tenant_mcp_app",
		endpoint: "tenantCatalog/installTenantMcpApp",
		kind: "write",
		description:
			"Install a prepared MCP product such as Docs into this tenant's own Unified gateway. Creates or reuses an org-owned proxy and never grants fleet catalog authority.",
	},
	{
		toolId: "create_tenant_openapi_mcp_app",
		endpoint: "catalog/createTenantOpenApiMcpApp",
		kind: "write",
	},
	{
		toolId: "preview_openapi_import",
		endpoint: "tenantCatalog/previewOpenApiImport",
		kind: "read",
		widget: {
			layoutId: "openapi-import-preview",
			description: "OpenAPI import dry-run summary and planned tool changes.",
			layoutSpec: {
				root: "shell",
				elements: {
					shell: {
						type: "Stack",
						props: { gap: 4 },
						children: ["stats", "items"],
					},
					stats: {
						type: "StatGrid",
						props: {
							columns: { mobile: 1, tablet: 2, desktop: 4 },
							density: "compact",
							stats: [
								{
									label: "Operations",
									value: { $state: "/totalOperations" },
									tone: "info",
								},
								{
									label: "Planned",
									value: { $state: "/planned" },
									tone: "default",
								},
								{
									label: "Created",
									value: { $state: "/created" },
									tone: "success",
								},
								{
									label: "Updated",
									value: { $state: "/updated" },
									tone: "warning",
								},
								{
									label: "In sync",
									value: { $state: "/inSync" },
									tone: "success",
								},
								{
									label: "Deleted",
									value: { $state: "/deleted" },
									tone: "danger",
								},
								{
									label: "Skipped",
									value: { $state: "/skipped" },
									tone: "default",
								},
								{
									label: "Failed",
									value: { $state: "/failed" },
									tone: "danger",
								},
							],
						},
						children: [],
					},
					items: {
						type: "DataTable",
						props: {
							data: { $state: "/items" },
							columns: [
								{
									field: "toolId",
									header: "Tool",
									format: "text",
									sortable: true,
								},
								{
									field: "method",
									header: "Method",
									format: "badge",
									sortable: true,
								},
								{
									field: "path",
									header: "Path",
									format: "text",
									sortable: true,
								},
								{
									field: "status",
									header: "Status",
									format: "badge",
									sortable: true,
								},
								{
									field: "message",
									header: "Message",
									format: "text",
									sortable: false,
								},
							],
							pageSize: 10,
							compact: true,
							striped: true,
						},
						children: [],
					},
				},
			},
		},
	},
	{
		toolId: "run_openapi_import",
		endpoint: "catalog/runOpenApiImport",
		kind: "write",
	},
	{
		toolId: "reconcile_app",
		endpoint: "catalog/reconcileApp",
		kind: "write",
	},
	{
		toolId: "update_catalog_app",
		endpoint: "catalog/updateApp",
		kind: "write",
	},
	{
		toolId: "update_catalog_store_listing",
		endpoint: "catalog/updateStoreListing",
		kind: "write",
	},
	{
		toolId: "delete_catalog_app",
		endpoint: "catalog/deleteApp",
		kind: "destructive",
	},
	{
		toolId: "create_catalog_app",
		endpoint: "catalog/createFromEndpoint",
		kind: "write",
	},
	// App and tool management.
	{
		toolId: "list_apps",
		endpoint: "apps/list",
		kind: "read",
		widget: {
			layoutId: "apps-list",
			description: "Platform apps table.",
			layoutSpec: {
				root: "table",
				elements: {
					table: {
						type: "DataTable",
						props: {
							data: { $state: "/data" },
							columns: [
								{
									field: "name",
									header: "Name",
									format: "text",
									sortable: true,
								},
								{
									field: "slug",
									header: "Slug",
									format: "text",
									sortable: true,
								},
								{
									field: "visibility",
									header: "Visibility",
									format: "badge",
									sortable: true,
								},
								{
									field: "discoveryStatus",
									header: "Discovery",
									format: "badge",
									sortable: true,
								},
								{
									field: "appStoreStatus",
									header: "Store",
									format: "badge",
									sortable: true,
								},
								{
									field: "updatedAt",
									header: "Updated",
									format: "date",
									sortable: true,
								},
							],
							pageSize: 10,
							compact: true,
							striped: true,
						},
						children: [],
					},
				},
			},
		},
	},
	{ toolId: "get_app", endpoint: "apps/get", kind: "read" },
	{ toolId: "get_app_by_slug", endpoint: "apps/getBySlug", kind: "read" },
	{ toolId: "create_app", endpoint: "apps/create", kind: "write" },
	{
		toolId: "provision_app",
		endpoint: "apps/provision",
		kind: "write",
	},
	{ toolId: "update_app", endpoint: "apps/update", kind: "write" },
	{ toolId: "delete_app", endpoint: "apps/delete", kind: "destructive" },
	// Sites are deployed content surfaces, independent of MCP apps and gateways.
	{ toolId: "list_sites", endpoint: "sites/list", kind: "read" },
	{ toolId: "create_cms_site", endpoint: "sites/createCms", kind: "write" },
	{
		toolId: "begin_cms_domain",
		endpoint: "sites/beginCmsDomain",
		kind: "write",
	},
	{ toolId: "get_cms_domain", endpoint: "sites/getCmsDomain", kind: "read" },
	{
		toolId: "verify_cms_domain",
		endpoint: "sites/verifyCmsDomain",
		kind: "write",
	},
	{
		toolId: "remove_cms_domain",
		endpoint: "sites/removeCmsDomain",
		kind: "destructive",
	},
	{
		toolId: "get_site_recovery_manifest",
		endpoint: "sites/getRecoveryManifest",
		kind: "read",
	},
	{
		toolId: "set_site_lifecycle",
		endpoint: "sites/setLifecycle",
		kind: "write",
	},
	{
		toolId: "get_site_reconciliation",
		endpoint: "sites/getReconciliation",
		kind: "read",
	},
	{
		toolId: "run_site_reconciliation",
		endpoint: "sites/runReconciliation",
		kind: "write",
	},
	{
		toolId: "get_site_deprovision_plan",
		endpoint: "sites/getDeprovisionPlan",
		kind: "read",
	},
	{
		toolId: "get_site_deprovision_status",
		endpoint: "sites/getDeprovisionStatus",
		kind: "read",
	},
	{
		toolId: "deprovision_site",
		endpoint: "sites/deprovision",
		kind: "destructive",
	},
	{
		toolId: "repair_cms_media",
		endpoint: "sites/repairCmsMedia",
		kind: "write",
	},
	{
		toolId: "get_app_integrations",
		endpoint: "apps/getIntegrations",
		kind: "read",
	},
	{
		toolId: "get_app_scope_manifest",
		endpoint: "apps/getScopeManifest",
		kind: "read",
	},
	{ toolId: "list_app_tools", endpoint: "appTools/list", kind: "read" },
	{ toolId: "get_app_tool", endpoint: "appTools/get", kind: "read" },
	{ toolId: "create_app_tool", endpoint: "appTools/create", kind: "write" },
	{ toolId: "update_app_tool", endpoint: "appTools/update", kind: "write" },
	{
		toolId: "delete_app_tool",
		endpoint: "appTools/delete",
		kind: "destructive",
	},
	{ toolId: "enable_app_tool", endpoint: "appTools/enable", kind: "write" },
	{ toolId: "disable_app_tool", endpoint: "appTools/disable", kind: "write" },
	{ toolId: "reorder_app_tools", endpoint: "appTools/reorder", kind: "write" },
	{
		toolId: "preflight_app_tool",
		endpoint: "appTools/preflight",
		kind: "read",
	},
	{
		toolId: "run_mcp_protocol_probe",
		endpoint: "mcpHealth/run",
		kind: "read",
		description:
			"Run a stateless 2026 protocol probe against an app server: server/discover, Tasks expectation, cache hints, schema shape, resource templates, and missing-resource error semantics.",
		widget: {
			layoutId: "mcp-protocol-probe",
			description: "MCP protocol probe result with pass/fail checks.",
			layoutSpec: {
				root: "shell",
				elements: {
					shell: {
						type: "Stack",
						props: { gap: 4 },
						children: ["summary", "checks"],
					},
					summary: {
						type: "StatGrid",
						props: {
							columns: { mobile: 1, tablet: 2, desktop: 4 },
							density: "compact",
							stats: [
								{
									label: "Passed",
									value: { $state: "/passCount" },
									tone: "success",
								},
								{
									label: "Failed",
									value: { $state: "/failCount" },
									tone: "danger",
								},
								{
									label: "Duration",
									value: { $state: "/totalDurationMs" },
									tone: "info",
								},
								{
									label: "All passed",
									value: { $state: "/allPassed" },
									tone: "default",
								},
							],
						},
						children: [],
					},
					checks: {
						type: "DataTable",
						props: {
							data: { $state: "/checks" },
							columns: [
								{
									field: "name",
									header: "Check",
									format: "text",
									sortable: true,
								},
								{
									field: "passed",
									header: "Passed",
									format: "badge",
									sortable: true,
								},
								{
									field: "detail",
									header: "Detail",
									format: "text",
									sortable: false,
								},
								{
									field: "durationMs",
									header: "ms",
									format: "number",
									sortable: true,
								},
							],
							pageSize: 12,
							compact: true,
							striped: true,
						},
						children: [],
					},
				},
			},
		},
	},

	// SEO / Google Search Console discovery metrics.
	{
		toolId: "research_keywords",
		endpoint: "seo/researchKeywords",
		kind: "read",
		description:
			"Research normalized keyword opportunities for a tenant app. This calls a paid external SEO provider and returns an exact provider-cost receipt.",
	},
	{
		toolId: "get_serp_results",
		endpoint: "seo/getSerpResults",
		kind: "read",
		description:
			"Get normalized live Google SERP results for a keyword and market. This calls a paid external SEO provider and returns an exact provider-cost receipt.",
	},
	{
		toolId: "get_domain_overview",
		endpoint: "seo/getDomainOverview",
		kind: "read",
		description:
			"Get normalized organic visibility estimates for a domain and market. This calls a paid external SEO provider and returns an exact provider-cost receipt.",
	},
	{
		toolId: "get_backlinks_overview",
		endpoint: "seo/getBacklinksOverview",
		kind: "read",
		description:
			"Get normalized backlink and referring-domain metrics for a domain or page. This calls a paid external SEO provider and returns an exact provider-cost receipt.",
	},
	{
		toolId: "query_gsc_search_analytics",
		endpoint: "seo/querySearchAnalytics",
		kind: "read",
	},
	{
		toolId: "get_search_discovery_status",
		endpoint: "seo/getStatus",
		kind: "read",
	},
	{
		toolId: "list_gsc_sitemaps",
		endpoint: "seo/listSitemaps",
		kind: "read",
	},
	{
		toolId: "get_gsc_indexing_status",
		endpoint: "seo/getIndexingStatus",
		kind: "read",
	},
	{
		toolId: "configure_search_discovery",
		endpoint: "seo/configure",
		kind: "write",
	},
	{
		toolId: "register_google_property",
		endpoint: "seo/registerGoogleProperty",
		kind: "write",
		description:
			"Issue a Google Search Console verification token. Use verificationMethod=DNS_TXT for domain properties such as sc-domain:tedix.dev.",
	},
	{
		toolId: "verify_google_property",
		endpoint: "seo/verifyGoogle",
		kind: "write",
		description:
			"Claim Google Search Console ownership after the META tag or DNS TXT record is live.",
	},
	{
		toolId: "submit_google_sitemap",
		endpoint: "seo/submitSitemap",
		kind: "write",
	},
	{
		toolId: "delete_google_property",
		endpoint: "seo/deleteGoogleProperty",
		kind: "destructive",
	},

	// Tedi workforce lifecycle and app access.
	{ toolId: "list_tedis", endpoint: "tedis/list", kind: "read" },
	{ toolId: "get_tedi", endpoint: "tedis/get", kind: "read" },
	{ toolId: "create_tedi", endpoint: "tedis/create", kind: "write" },
	{ toolId: "update_tedi", endpoint: "tedis/update", kind: "write" },
	{
		toolId: "get_tedi_runtime_status",
		endpoint: "tedis/getStatus",
		kind: "read",
	},
	{
		toolId: "audit_tedi_backups",
		endpoint: "tedis/auditBackups",
		kind: "read",
		description:
			"Read-only fleet backup audit for the current organization. Checks backup handles, R2 object presence, freshness, and restore readiness without waking containers.",
	},
	{
		toolId: "wake_tedi",
		endpoint: "tedis/wake",
		kind: "write",
	},
	{
		toolId: "restart_tedi",
		endpoint: "tedis/restart",
		kind: "write",
		description:
			"Restart the active tedi runtime when a supported runtime exposes a restart path.",
	},
	{
		toolId: "reset_tedi_sandbox",
		endpoint: "tedis/resetSandbox",
		kind: "write",
		description:
			"Destroy a tedi sandbox so the next wake starts a fresh container from the current runtime image. Use for explicit operator recovery or post-runtime-image validation.",
	},
	{
		toolId: "sync_tedi_config",
		endpoint: "tedis/syncConfig",
		kind: "write",
	},
	{
		toolId: "repair_tedi_identity",
		endpoint: "tedis/repair",
		kind: "write",
	},
	{
		toolId: "decommission_tedi",
		endpoint: "tedis/decommission",
		kind: "destructive",
		description:
			"Platform-admin staged teardown of a tedi. Default (safe, reversible) decommissions: sets status=paused + runtime_state=archived and stops the tedi's Durable Object's armed maintenance schedules (dequeue cancelSchedules). Pass hardPurge=true with confirmSlug matching the tedi slug to ALSO irreversibly delete the D1 tedi row (cascading tedi_secrets, runtime events, sessions), the Descope identity, FGA grants, and the AIH MCP server. Returns residualManualSteps for sub-cleanups with no programmatic path (R2 storage, artifacts repo) with the scope each requires. platform:admin / trusted-service-binding only.",
	},
	{
		toolId: "list_tedi_app_assignments",
		endpoint: "tediAppAssignments/listByTedi",
		kind: "read",
	},
	{
		toolId: "assign_tedi_to_app",
		endpoint: "tediAppAssignments/create",
		kind: "write",
	},
	{
		toolId: "preview_managed_tedi_app_assignments",
		endpoint: "tediAppAssignments/previewManagedByTedi",
		kind: "read",
	},
	{
		toolId: "reconcile_managed_tedi_app_assignments",
		endpoint: "tediAppAssignments/reconcileManagedByTedi",
		kind: "write",
	},
	{
		toolId: "validate_tedi_mcp_access",
		endpoint: "tediAppAssignments/validateMcpAccess",
		kind: "read",
		description:
			"Read-only validation of a tedi's MCP app access. Checks assignment role, expected AIH scopes, actual Descope AIH client scopes, and tedi credential-secret presence without repair.",
	},
	{
		toolId: "validate_tedi_mcp_access_batch",
		endpoint: "tediAppAssignments/validateMcpAccessBatch",
		kind: "read",
		description:
			"Read-only fleet validation for tedi MCP app assignments. Checks every matching assignment and reports AIH scope or credential-secret drift without repair.",
	},
	{
		toolId: "repair_tedi_mcp_access_batch",
		endpoint: "tediAppAssignments/repairMcpAccessBatch",
		kind: "write",
		description:
			"Validate matching tedi MCP app assignments, then repair Descope AIH clients and tedi credential secrets only for invalid rows.",
	},
	{
		toolId: "get_tedi_mcp_access_health",
		endpoint: "tediAppAssignments/mcpAccessHealth",
		kind: "read",
		description:
			"Compact read-only fleet health summary for tedi MCP app access. Returns invalid/skipped rows only so operators can see AIH drift without scanning every valid assignment.",
	},
	{
		toolId: "run_tedi_mcp_access_health_workflow",
		endpoint: "tediAppAssignments/runMcpAccessHealthWorkflow",
		kind: "write",
		description:
			"Start the durable tedi MCP access-health workflow for this organization. Use repairInvalid=true only when you want the workflow to repair invalid Descope AIH clients.",
	},

	// Generated widget artifacts and GenUI promotion lifecycle.
	{
		toolId: "create_generated_widget_artifact",
		endpoint: "generatedWidgetArtifacts/create",
		kind: "write",
		description:
			"Create a durable generated widget artifact from MCP tool output. Stores a draft json-render or MCP UI layout for Browser QA and later publication.",
	},
	{
		toolId: "list_generated_widget_artifacts",
		endpoint: "generatedWidgetArtifacts/list",
		kind: "read",
		description:
			"List generated widget artifacts, draft layouts, Browser QA results, and published MCP UI resources for the current organization.",
		widget: {
			layoutId: "generated-widget-artifacts",
			description:
				"Generated widget artifact inventory with QA and publication state.",
			layoutSpec: {
				root: "table",
				elements: {
					table: {
						type: "DataTable",
						props: {
							data: { $state: "/artifacts" },
							columns: [
								{
									field: "title",
									header: "Artifact",
									format: "text",
									sortable: true,
								},
								{
									field: "appSlug",
									header: "App",
									format: "badge",
									sortable: true,
								},
								{
									field: "toolName",
									header: "Tool",
									format: "text",
									sortable: true,
								},
								{
									field: "kind",
									header: "Kind",
									format: "badge",
									sortable: true,
								},
								{
									field: "source",
									header: "Source",
									format: "badge",
									sortable: true,
								},
								{
									field: "status",
									header: "Status",
									format: "badge",
									sortable: true,
								},
								{
									field: "widgetTestRunId",
									header: "QA run",
									format: "text",
									sortable: true,
								},
								{
									field: "publishedAt",
									header: "Published",
									format: "date",
									sortable: true,
								},
								{
									field: "updatedAt",
									header: "Updated",
									format: "date",
									sortable: true,
								},
							],
							pageSize: 10,
							compact: true,
							striped: true,
						},
						children: [],
					},
				},
			},
		},
	},
	{
		toolId: "get_generated_widget_artifact",
		endpoint: "generatedWidgetArtifacts/get",
		kind: "read",
		description:
			"Read one generated widget artifact including layoutSpec, MCP UI resource URI, Browser QA evidence, screenshots, and publication status.",
		widget: {
			layoutId: "generated-widget-artifact",
			description: "Generated widget artifact detail and QA timeline.",
			layoutSpec: {
				root: "shell",
				elements: {
					shell: {
						type: "Stack",
						props: { gap: 4 },
						children: ["summary", "timeline"],
					},
					summary: {
						type: "KeyValuePanel",
						props: {
							variant: "plain",
							columns: 2,
							items: [
								{ label: "Title", value: { $state: "/artifact/title" } },
								{ label: "App", value: { $state: "/artifact/appSlug" } },
								{
									label: "Tool",
									value: { $state: "/artifact/toolName" },
								},
								{
									label: "Status",
									value: { $state: "/artifact/status" },
									badge: { $state: "/artifact/status" },
								},
								{ label: "Kind", value: { $state: "/artifact/kind" } },
								{
									label: "Source",
									value: { $state: "/artifact/source" },
									badge: { $state: "/artifact/source" },
								},
								{
									label: "QA run",
									value: { $state: "/artifact/widgetTestRunId" },
								},
								{
									label: "Workflow",
									value: { $state: "/artifact/workflowId" },
								},
								{
									label: "Preview",
									value: { $state: "/artifact/previewUrl" },
								},
								{
									label: "Resource",
									value: { $state: "/artifact/resourceUri" },
								},
							],
						},
						children: [],
					},
					timeline: {
						type: "StatusTimeline",
						props: {
							variant: "plain",
							items: [
								{
									title: "Created",
									status: "completed",
									description: { $state: "/artifact/createdAt" },
								},
								{
									title: "Current state",
									status: "current",
									statusLabel: { $state: "/artifact/status" },
									description: { $state: "/artifact/progressMessage" },
								},
								{
									title: "Published",
									status: "completed",
									description: { $state: "/artifact/publishedAt" },
								},
							],
						},
						children: [],
					},
				},
			},
		},
	},
	{
		toolId: "record_generated_widget_artifact_progress",
		endpoint: "generatedWidgetArtifacts/recordProgress",
		kind: "write",
		description:
			"Record generated widget artifact workflow progress, QA state, screenshots, preview URLs, and promotion metadata.",
	},
	{
		toolId: "attach_generated_widget_qa_run",
		endpoint: "generatedWidgetArtifacts/attachQaRun",
		kind: "write",
		description:
			"Attach a Browser QA run to a generated widget artifact and copy pass/fail status, screenshots, DOM analysis, and preview metadata.",
	},
	{
		toolId: "publish_generated_widget_artifact",
		endpoint: "generatedWidgetArtifacts/publish",
		kind: "write",
		description:
			"Publish a QA-passed generated widget artifact as renderable MCP UI resource metadata for Tedix OS chat and app tool visuals.",
	},
	{
		toolId: "run_widget_browser_qa",
		endpoint: "widgetTest/run",
		kind: "write",
		description:
			"Run Browser QA for a widget or generated MCP UI resource. Captures screenshots, console errors, network errors, layout dimensions, and interaction results.",
	},
	{
		toolId: "list_widget_browser_qa_runs",
		endpoint: "widgetTestRuns/list",
		kind: "read",
		description:
			"List widget Browser QA runs and their screenshots, pass/fail state, preview URLs, and diagnostics.",
		widget: {
			layoutId: "widget-browser-qa-runs",
			description: "Widget Browser QA run history.",
			layoutSpec: {
				root: "table",
				elements: {
					table: {
						type: "DataTable",
						props: {
							data: { $state: "/runs" },
							columns: [
								{
									field: "appSlug",
									header: "App",
									format: "badge",
									sortable: true,
								},
								{
									field: "toolName",
									header: "Tool",
									format: "text",
									sortable: true,
								},
								{
									field: "mode",
									header: "Mode",
									format: "badge",
									sortable: true,
								},
								{
									field: "passed",
									header: "Passed",
									format: "badge",
									sortable: true,
								},
								{
									field: "stepCount",
									header: "Steps",
									format: "number",
									sortable: true,
								},
								{
									field: "stepsPassedCount",
									header: "Steps passed",
									format: "number",
									sortable: true,
								},
								{
									field: "durationMs",
									header: "Duration",
									format: "number",
									sortable: true,
								},
								{
									field: "createdAt",
									header: "Created",
									format: "date",
									sortable: true,
								},
							],
							pageSize: 10,
							compact: true,
							striped: true,
						},
						children: [],
					},
				},
			},
		},
	},
	{
		toolId: "get_widget_browser_qa_run",
		endpoint: "widgetTestRuns/get",
		kind: "read",
		description:
			"Read one widget Browser QA run with screenshots, DOM summary, widget analysis, console errors, and network diagnostics.",
		widget: {
			layoutId: "widget-browser-qa-run",
			description: "Widget Browser QA run detail with pass/fail diagnostics.",
			layoutSpec: {
				root: "shell",
				elements: {
					shell: {
						type: "Stack",
						props: { gap: 4 },
						children: ["summary", "timeline"],
					},
					summary: {
						type: "KeyValuePanel",
						props: {
							variant: "plain",
							columns: 2,
							items: [
								{ label: "App", value: { $state: "/appSlug" } },
								{ label: "Tool", value: { $state: "/toolName" } },
								{
									label: "Mode",
									value: { $state: "/mode" },
									badge: { $state: "/mode" },
								},
								{
									label: "Passed",
									value: { $state: "/passed" },
									badge: { $state: "/passed" },
								},
								{ label: "Steps", value: { $state: "/stepCount" } },
								{
									label: "Steps passed",
									value: { $state: "/stepsPassedCount" },
								},
								{
									label: "Duration",
									value: { $state: "/durationMs" },
								},
								{ label: "Preview", value: { $state: "/previewUrl" } },
								{ label: "Error", value: { $state: "/error" } },
							],
						},
						children: [],
					},
					timeline: {
						type: "StatusTimeline",
						props: {
							variant: "plain",
							items: [
								{
									title: "Run created",
									status: "completed",
									description: { $state: "/createdAt" },
								},
								{
									title: "Browser QA",
									status: "current",
									statusLabel: { $state: "/passed" },
									description: { $state: "/error" },
								},
							],
						},
						children: [],
					},
				},
			},
		},
	},

	// Tedi email provisioning.
	{
		toolId: "list_tedi_email_address_requests",
		endpoint: "tediEmail/listAddressRequests",
		kind: "read",
		widget: {
			layoutId: "tedi-email-address-requests",
			description: "Tedi email address provisioning queue.",
			layoutSpec: {
				root: "shell",
				elements: {
					shell: {
						type: "Stack",
						props: { gap: 4 },
						children: ["summary", "table"],
					},
					summary: {
						type: "KeyValuePanel",
						props: {
							variant: "plain",
							columns: 3,
							items: [
								{ label: "Addresses", value: { $state: "/total" } },
								{ label: "Default status", value: "reserved" },
								{ label: "Provider", value: "Cloudflare Email" },
							],
						},
						children: [],
					},
					table: {
						type: "DataTable",
						props: {
							data: { $state: "/addresses" },
							columns: [
								{
									field: "address",
									header: "Address",
									format: "text",
									sortable: true,
								},
								{
									field: "status",
									header: "Status",
									format: "badge",
									sortable: true,
								},
								{
									field: "kind",
									header: "Kind",
									format: "badge",
									sortable: true,
								},
								{
									field: "domain",
									header: "Domain",
									format: "text",
									sortable: true,
								},
								{
									field: "tediId",
									header: "Tedi",
									format: "text",
									sortable: true,
								},
								{
									field: "organizationId",
									header: "Org",
									format: "text",
									sortable: true,
								},
								{
									field: "updatedAt",
									header: "Updated",
									format: "date",
									sortable: true,
								},
							],
							pageSize: 10,
							compact: true,
							striped: true,
						},
						children: [],
					},
				},
			},
		},
	},
	{
		toolId: "provision_tedi_email_address",
		endpoint: "tediEmail/provisionAddress",
		kind: "write",
	},

	// Async platform workflows and schema projection.
	{
		toolId: "list_workflow_definitions",
		endpoint: "workflows/listDefinitions",
		kind: "read",
		description:
			"List platform-owned static WorkflowEntrypoints and tenant-owned dynamic skill runs with their source, mutation, and operator contracts.",
		widget: WORKFLOW_DEFINITIONS_WIDGET,
	},
	{
		toolId: "list_workflow_definition_health",
		endpoint: "workflows/listDefinitionHealth",
		kind: "read",
		description:
			"Evaluate tenant-visible automation definitions against executable runtime surfaces and latest durable run evidence without treating missing history as failure.",
		widget: WORKFLOW_HEALTH_WIDGET,
	},
	{
		toolId: "get_workflow_status",
		endpoint: "workflows/getStatus",
		kind: "read",
		widget: {
			layoutId: "workflow-status",
			description: "Execution status details and timeline.",
			layoutSpec: {
				root: "shell",
				elements: {
					shell: {
						type: "Stack",
						props: { gap: 4 },
						children: ["summary", "timeline"],
					},
					summary: {
						type: "KeyValuePanel",
						props: {
							variant: "plain",
							columns: 2,
							items: [
								{ label: "Workflow", value: { $state: "/data/id" } },
								{
									label: "Status",
									value: { $state: "/data/status" },
									tone: "info",
									badge: { $state: "/data/status" },
								},
								{ label: "Type", value: { $state: "/data/workflowType" } },
								{ label: "App", value: { $state: "/data/appId" } },
							],
						},
						children: [],
					},
					timeline: {
						type: "StatusTimeline",
						props: {
							variant: "plain",
							items: [
								{
									title: "Queued",
									status: "completed",
									description: "Execution was accepted by the platform.",
								},
								{
									title: "Current state",
									status: "current",
									statusLabel: { $state: "/data/status" },
									description: { $state: "/data.message" },
								},
							],
						},
						children: [],
					},
				},
			},
		},
	},
	{
		toolId: "list_workflow_runs",
		endpoint: "workflows/listRuns",
		kind: "read",
		widget: {
			layoutId: "workflow-runs",
			description: "Recent scheduled and operator-triggered execution records.",
			layoutSpec: {
				root: "shell",
				elements: {
					shell: {
						type: "Stack",
						props: { gap: 4 },
						children: ["runs"],
					},
					runs: {
						type: "DataTable",
						props: {
							data: { $state: "/runs" },
							columns: [
								{
									field: "workflowType",
									header: "Workflow",
									format: "badge",
									sortable: true,
								},
								{
									field: "status",
									header: "Status",
									format: "badge",
									sortable: true,
								},
								{
									field: "trigger",
									header: "Trigger",
									format: "badge",
									sortable: true,
								},
								{
									field: "target",
									header: "Target",
									format: "text",
									sortable: true,
								},
								{
									field: "startedAt",
									header: "Started",
									format: "date",
									sortable: true,
								},
								{
									field: "completedAt",
									header: "Completed",
									format: "date",
									sortable: true,
								},
								{
									field: "errorCount",
									header: "Errors",
									format: "number",
									sortable: true,
								},
							],
							pageSize: 10,
							compact: true,
							striped: true,
						},
						children: [],
					},
				},
			},
		},
	},
	{
		toolId: "preview_tool_schema_sync",
		endpoint: "toolSchemaSync/preview",
		kind: "read",
	},
	{
		toolId: "check_tool_schema_sync",
		endpoint: "toolSchemaSync/check",
		kind: "read",
	},
	{
		toolId: "run_tool_schema_sync",
		endpoint: "toolSchemaSync/run",
		kind: "write",
	},
] as const satisfies readonly PlatformOperatorToolDefinition[];
