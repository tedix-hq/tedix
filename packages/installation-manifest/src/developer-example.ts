import type { InstallationManifest } from "./schema";

const resolved = (value: string) => ({ state: "resolved" as const, value });

export const developerInstallationManifest = {
	schemaVersion: "1.0",
	installation: {
		id: "acme-developer",
		name: "Acme developer installation",
		environment: "development",
		release: { version: "0.1.0", channel: "candidate" },
	},
	organization: {
		key: "acme-labs",
		displayName: "Acme Labs",
		profile: "developer",
		capabilityRequirements: {
			required: ["core-runtime"],
			optional: ["browser-automation"],
		},
	},
	cloudflare: {
		primaryAccount: "developer-account",
		accounts: [
			{
				key: "developer-account",
				accountId: resolved("example-cloudflare-account"),
				freshAccount: false,
			},
		],
		domains: [
			{
				key: "application-domain",
				hostname: "workers.example.invalid",
				account: "developer-account",
				zoneId: resolved("example-cloudflare-zone"),
				purpose: "application",
			},
		],
	},
	workers: [
		{
			id: "control-api",
			account: "developer-account",
			sourceConfig: "apps/api/wrangler.jsonc",
			scriptName: resolved("acme-control-api"),
			compatibilityDate: "2026-07-22",
			workersDev: false,
			routes: [
				{
					kind: "custom-domain",
					hostname: "api.workers.example.invalid",
					domain: "application-domain",
				},
			],
			bindings: [
				{ kind: "d1", name: "DB", resource: "primary-database" },
				{ kind: "r2", name: "ARTIFACTS", resource: "artifact-bucket" },
				{ kind: "kv", name: "CACHE", resource: "cache-namespace" },
				{ kind: "durable-object", name: "AGENT", resource: "agent-state" },
				{ kind: "workflow", name: "INSTALLER", resource: "install-workflow" },
				{
					kind: "queue",
					name: "EVENTS",
					resource: "event-queue",
					role: "producer",
				},
				{ kind: "service", name: "RUNTIME", resource: "runtime-service" },
				{ kind: "browser", name: "BROWSER", resource: "browser-service" },
				{ kind: "ai", name: "AI", resource: "workers-ai" },
				{ kind: "vectorize", name: "VECTOR", resource: "memory-index" },
				{ kind: "hyperdrive", name: "GRAPH_DB", resource: "graph-hyperdrive" },
				{
					kind: "container",
					name: "WORKSTATION",
					resource: "workstation-container",
				},
				{ kind: "assets", name: "ASSETS", resource: "os-assets" },
			],
			vars: {
				ENVIRONMENT: "development",
				API_URL: "https://api.workers.example.invalid",
				MCP_UI_URL: "https://widget.workers.example.invalid",
				MCP_URL: "https://mcp.workers.example.invalid",
				TEDI_DEV_BASE_URL: "https://tedi.workers.example.invalid",
				OS_URL: "https://os.workers.example.invalid",
			},
		},
	],
	surfaces: [
		{
			id: "api",
			kind: "api",
			worker: "control-api",
			exposure: "authenticated",
		},
	],
	resources: [
		{
			id: "primary-database",
			kind: "d1",
			provisioning: "create",
			requirement: "required",
			databaseId: resolved("example-d1-database"),
			databaseName: "acme-developer",
		},
		{
			id: "artifact-bucket",
			kind: "r2",
			provisioning: "create",
			requirement: "required",
			bucketName: resolved("acme-developer-artifacts"),
		},
		{
			id: "cache-namespace",
			kind: "kv",
			provisioning: "create",
			requirement: "optional",
			namespaceId: resolved("example-kv-namespace"),
		},
		{
			id: "agent-state",
			kind: "durable-object",
			provisioning: "create",
			requirement: "required",
			className: "AgentState",
			scriptName: resolved("acme-control-api"),
			storage: "sqlite",
		},
		{
			id: "install-workflow",
			kind: "workflow",
			provisioning: "create",
			requirement: "required",
			className: "InstallWorkflow",
			workflowName: resolved("acme-install"),
		},
		{
			id: "event-queue",
			kind: "queue",
			provisioning: "create",
			requirement: "optional",
			queueName: resolved("acme-events"),
			delivery: "at-least-once",
		},
		{
			id: "runtime-service",
			kind: "service",
			provisioning: "create",
			requirement: "required",
			serviceName: resolved("acme-runtime"),
			environment: "production",
		},
		{
			id: "browser-service",
			kind: "browser",
			provisioning: "adopt",
			requirement: "optional",
			account: "developer-account",
		},
		{
			id: "workers-ai",
			kind: "ai",
			provisioning: "adopt",
			requirement: "required",
			account: "developer-account",
		},
		{
			id: "memory-index",
			kind: "vectorize",
			provisioning: "create",
			requirement: "optional",
			indexName: resolved("acme-memory"),
			dimensions: 768,
			metric: "cosine",
		},
		{
			id: "graph-hyperdrive",
			kind: "hyperdrive",
			provisioning: "create",
			requirement: "optional",
			configurationId: resolved("example-hyperdrive-configuration"),
		},
		{
			id: "workstation-container",
			kind: "container",
			provisioning: "create",
			requirement: "optional",
			containerName: resolved("acme-workstation"),
			className: "WorkstationContainer",
			image: "registry.example.invalid/acme/workstation:0.1.0",
		},
		{
			id: "os-assets",
			kind: "assets",
			provisioning: "create",
			requirement: "required",
			directory: "./dist/client",
			runWorkerFirst: true,
		},
	],
	providerPrerequisites: [
		{
			id: "identity-provider",
			provider: "descope",
			requirement: "required",
			status: "ready",
			configurationNames: ["DESCOPE_BASE_URL", "DESCOPE_PROJECT_ID"],
			secretNames: ["DESCOPE_MANAGEMENT_KEY"],
		},
	],
	secretRequirements: [
		{
			name: "DESCOPE_MANAGEMENT_KEY",
			scope: "provider",
			target: "identity-provider",
			required: true,
		},
	],
	capabilities: [
		{
			id: "core-runtime",
			requirement: "required",
			availability: "available",
			accessPlan: {
				kind: "included",
				profiles: ["developer", "smb", "enterprise"],
			},
		},
		{
			id: "browser-automation",
			requirement: "optional",
			availability: "available",
			accessPlan: {
				kind: "entitlement",
				profiles: ["developer", "smb", "enterprise"],
				entitlement: "browser-runtime",
			},
		},
	],
	entitlements: {
		grants: [{ key: "browser-runtime", status: "active", source: "operator" }],
	},
	fleetAuthority: { mode: "disabled" },
	bootstrap: {
		seed: "developer-example",
		inputs: [
			{
				kind: "hostname",
				name: "PRIMARY_HOSTNAME",
				value: "api.workers.example.invalid",
				source: "operator",
			},
			{
				kind: "identifier",
				name: "ORGANIZATION_SLUG",
				value: "acme-labs",
				source: "operator",
			},
		],
	},
	lifecycle: {
		backup: {
			required: true,
			resourceIds: ["primary-database", "artifact-bucket"],
			retentionDays: 14,
			restoreTestRequired: true,
		},
		export: {
			required: true,
			format: "both",
			includes: ["configuration", "data", "artifacts", "audit"],
		},
		upgrade: {
			strategy: "in-place",
			fromSchemaVersions: ["1.0"],
			preflightRequired: true,
			backupRequired: true,
			rollbackRequired: true,
		},
	},
	execution: {
		preflight: "fail-before-mutation",
		mutationRequiresCertification: true,
	},
	certification: {
		status: "uncertified",
		level: "schema-valid",
		evidence: [{ kind: "schema", reference: "sanitized-developer-fixture" }],
	},
} satisfies InstallationManifest;
