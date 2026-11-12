import { developerInstallationManifest } from "./developer-example";
import type { InstallationManifest } from "./schema";

const resolved = (value: string) => ({ state: "resolved" as const, value });
const workspaceRuntime = {
	kind: "service" as const,
	name: "WORKSPACE_RUNTIME",
	resource: "workspace-service",
	entrypoint: "InternalEntrypoint",
};

/** Sanitized workspace storage wiring; not a certified installation. */
export const workspaceInstallationManifest: InstallationManifest = {
	...developerInstallationManifest,
	workers: [
		{
			...developerInstallationManifest.workers[0]!,
			bindings: [
				...developerInstallationManifest.workers[0]!.bindings,
				workspaceRuntime,
			],
		},
		{
			id: "workspace-storage",
			account: "developer-account",
			sourceConfig: "apps/workspace-do/wrangler.jsonc",
			scriptName: resolved("acme-workspace-storage"),
			compatibilityDate: "2026-05-14",
			workersDev: false,
			routes: [],
			bindings: [
				{
					kind: "durable-object",
					name: "WORKSPACE",
					resource: "workspace-state",
				},
				{
					kind: "durable-object",
					name: "TEDI_AGENT",
					resource: "tedi-agent-state",
				},
				{ kind: "d1", name: "DB", resource: "primary-database" },
				{ kind: "r2", name: "R2_BUCKET", resource: "artifact-bucket" },
				{ kind: "ai", name: "AI", resource: "workers-ai" },
				{ kind: "service", name: "MCP_SERVICE", resource: "mcp-service" },
			],
			vars: { ENVIRONMENT: "development", DO_JURISDICTION: "" },
		},
		{
			id: "mcp-gateway",
			account: "developer-account",
			sourceConfig: "apps/mcp/cloudflare.config.ts",
			scriptName: resolved("acme-mcp"),
			compatibilityDate: "2026-05-14",
			workersDev: false,
			routes: [],
			bindings: [
				workspaceRuntime,
				{ kind: "d1", name: "DB", resource: "primary-database" },
				{ kind: "r2", name: "AGGREGATE_CACHE", resource: "artifact-bucket" },
				{
					kind: "durable-object",
					name: "MCP_SUBSCRIPTIONS",
					resource: "mcp-subscriptions",
				},
				{
					kind: "workflow",
					name: "GENERIC_TASKS_WORKFLOW",
					resource: "generic-tasks",
				},
				{
					kind: "service",
					name: "API_SERVICE",
					resource: "api-service",
					entrypoint: "McpEntrypoint",
				},
				{
					kind: "service",
					name: "TEDI_SERVICE",
					resource: "tedi-service",
					entrypoint: "InternalEntrypoint",
				},
				{ kind: "service", name: "CMS", resource: "cms-service" },
				{ kind: "service", name: "DOCS", resource: "docs-service" },
			],
			vars: {
				ENVIRONMENT: "development",
				API_URL: "https://api.workers.example.invalid",
				MCP_URL: "https://mcp.workers.example.invalid",
				MCP_UI_URL: "https://widget.workers.example.invalid",
			},
		},
		{
			id: "os",
			account: "developer-account",
			sourceConfig: "apps/os/cloudflare.config.ts",
			scriptName: resolved("acme-os"),
			compatibilityDate: "2026-05-14",
			workersDev: false,
			routes: [],
			bindings: [
				workspaceRuntime,
				{ kind: "assets", name: "ASSETS", resource: "os-assets" },
				{
					kind: "durable-object",
					name: "COLLAB_ROOM",
					resource: "collab-room",
				},
				{
					kind: "service",
					name: "API_SERVICE",
					resource: "api-service",
					entrypoint: "InternalEntrypoint",
				},
				{
					kind: "service",
					name: "MCP_SERVICE",
					resource: "mcp-service",
					entrypoint: "InternalEntrypoint",
				},
				{
					kind: "service",
					name: "OS_SESSION_BROKER",
					resource: "session-broker-service",
					entrypoint: "OsSessionBroker",
				},
				{
					kind: "service",
					name: "CLI_SESSION_BROKER",
					resource: "session-broker-service",
					entrypoint: "CliSessionBroker",
				},
			],
			vars: {
				API_URL: "https://api.workers.example.invalid",
				OS_URL: "https://os.workers.example.invalid",
				SESSION_BROKER_URL: "https://auth.workers.example.invalid",
				DESCOPE_BASE_URL: "https://auth.workers.example.invalid",
				DESCOPE_PROJECT_ID: "example-descope-project",
			},
		},
	],
	resources: [
		...developerInstallationManifest.resources,
		{
			id: "workspace-state",
			kind: "durable-object",
			provisioning: "create",
			requirement: "required",
			className: "WorkspaceDO",
			scriptName: resolved("acme-workspace-storage"),
			storage: "sqlite",
		},
		{
			id: "tedi-agent-state",
			kind: "durable-object",
			provisioning: "adopt",
			requirement: "required",
			className: "AgentTediDO",
			scriptName: resolved("acme-tedi-runtime"),
			storage: "sqlite",
		},
		{
			id: "mcp-subscriptions",
			kind: "durable-object",
			provisioning: "create",
			requirement: "required",
			className: "McpSubscriptionDurableObject",
			scriptName: resolved("acme-mcp"),
			storage: "sqlite",
		},
		{
			id: "collab-room",
			kind: "durable-object",
			provisioning: "create",
			requirement: "required",
			className: "CollabRoom",
			scriptName: resolved("acme-os"),
			storage: "sqlite",
		},
		{
			id: "generic-tasks",
			kind: "workflow",
			provisioning: "create",
			requirement: "required",
			className: "GenericTasksWorkflow",
			workflowName: resolved("acme-generic-tasks"),
		},
		...(
			[
				["workspace-service", "acme-workspace-storage"],
				["api-service", "acme-control-api"],
				["mcp-service", "acme-mcp"],
				["tedi-service", "acme-tedi"],
				["cms-service", "acme-cms"],
				["docs-service", "acme-docs"],
				["session-broker-service", "acme-session-broker"],
			] as const
		).map(([id, name]) => ({
			id,
			kind: "service" as const,
			provisioning: "adopt" as const,
			requirement: "required" as const,
			serviceName: resolved(name),
		})),
	],
	secretRequirements: [
		...developerInstallationManifest.secretRequirements,
		...(["workspace-storage", "mcp-gateway"] as const).map((target) => ({
			name: "MIGRATE_WORKSPACES_TOKEN",
			scope: "worker" as const,
			target,
			required: true,
		})),
		{
			name: "CF_AI_GATEWAY_TOKEN",
			scope: "worker",
			target: "workspace-storage",
			required: true,
		},
	],
};
