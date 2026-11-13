/**
 * Sample apps, tools, eligibility, connections, inventory, members and API
 * keys.
 */

import type {
	ConnectionInventoryRow,
	ConnectionProvider,
} from "@tedix/api-contract/schemas/connections";
import { projectConnectionCapabilities } from "@tedix/api-contract/utils/connection-capabilities";
import {
	APP_FINANCE,
	APP_GATEWAY,
	APP_STOREFRONT,
	APP_SUPPORT,
	fid,
	ORG_ID,
	T0,
	T1,
	T2,
	T4,
	T5,
	TEDI_NOVA,
} from "./core";
import { AGENT_AVATAR, NOVA_AVATAR, svgAvatar } from "./tedis";

/**
 * One app per logo source: its own logo, one inherited from its base app, and
 * none at all (letters). The domains are reserved, so no favicon resolves.
 */
const appListItem = (
	id: string,
	name: string,
	slug: string,
	description: string,
	logos: { logoUrl?: string; inheritedLogoUrl?: string } = {},
) => ({
	id,
	name,
	slug,
	domain: `${slug}.solstice.example`,
	description,
	logoUrl: logos.logoUrl ?? null,
	inheritedLogoUrl: logos.inheritedLogoUrl ?? null,
	visibility: "private" as const,
	discoveryStatus: "scraped" as const,
	customMcpDomain: null,
	appStoreStatus: null,
	createdAt: T0,
	updatedAt: T4,
});

export const APPS = [
	appListItem(
		APP_STOREFRONT,
		"Storefront",
		"storefront",
		"Orders, subscriptions, and wholesale accounts",
		{ logoUrl: svgAvatar("#0f766e", "S") },
	),
	appListItem(
		APP_SUPPORT,
		"Support Inbox",
		"support-inbox",
		"Ticket queue with SLA tracking",
		{ inheritedLogoUrl: svgAvatar("#b45309", "H") },
	),
	appListItem(
		APP_FINANCE,
		"Finance Ledger",
		"finance-ledger",
		"Invoices, credits, and payout history",
	),
	appListItem(
		APP_GATEWAY,
		"Solstice Unified MCP",
		"solstice-unified",
		"Unified MCP gateway for Solstice",
	),
];

/** App metadata the fixture keeps per app; only the gateway carries any. */
export const APP_METADATA: Record<
	string,
	{ mcpConfig: Record<string, unknown> }
> = {
	[APP_GATEWAY]: {
		mcpConfig: {
			codeMode: true,
			aggregateTedis: [{ slug: "nova", surface: "full" }],
		},
	},
};

const appTool = (
	appId: string,
	n: number,
	toolId: string,
	title: string,
	description: string,
) => ({
	id: `${appId.slice(0, 8)}-tool-${n}`,
	toolId,
	toolTypeId: "mcp",
	title,
	description,
	inputSchema: { type: "object" as const, properties: {} },
	outputSchema: null,
	adapterScope: null,
	resultStrategy: null,
	outputTemplate: null,
	widgetKey: null,
	widgetRoute: null,
	widgetAccessible: null,
	authRequired: false,
	visibility: "public",
	icons: null,
	executionTaskSupport: null,
	annotations: null,
	meta: null,
	invocationStatus: null,
	fileParams: null,
	widgetDescription: null,
	widgetPrefersBorder: null,
	widgetDomain: null,
	config: null,
	schemaDialect: null,
	schemaSource: null,
	schemaSourceRef: null,
	schemaSourceHash: null,
	schemaSyncedAt: null,
	sortOrder: n,
	enabled: true,
	createdAt: T0,
	updatedAt: T4,
});

export const APP_TOOLS: Record<string, ReturnType<typeof appTool>[]> = {
	[APP_STOREFRONT]: [
		appTool(
			APP_STOREFRONT,
			1,
			"list_orders",
			"List orders",
			"List recent orders with totals",
		),
		appTool(
			APP_STOREFRONT,
			2,
			"get_order",
			"Get order",
			"Fetch one order with line items",
		),
		appTool(
			APP_STOREFRONT,
			3,
			"list_subscriptions",
			"List subscriptions",
			"Active and lapsed subscriptions",
		),
	],
	[APP_SUPPORT]: [
		appTool(
			APP_SUPPORT,
			1,
			"list_tickets",
			"List tickets",
			"Open tickets ordered by SLA risk",
		),
		appTool(
			APP_SUPPORT,
			2,
			"reply_ticket",
			"Reply to ticket",
			"Send a reply on a ticket thread",
		),
	],
	[APP_FINANCE]: [
		appTool(
			APP_FINANCE,
			1,
			"list_invoices",
			"List invoices",
			"Invoices with payment status",
		),
		appTool(
			APP_FINANCE,
			2,
			"create_credit",
			"Create credit",
			"Issue a goodwill credit",
		),
	],
};

export const fullApp = (item: (typeof APPS)[number]) => ({
	id: item.id,
	organizationId: ORG_ID,
	name: item.name,
	slug: item.slug,
	description: item.description,
	primaryDomain: item.domain,
	logoUrl: item.logoUrl,
	inheritedLogoUrl: item.inheritedLogoUrl,
	visibility: item.visibility,
	discoveryStatus: item.discoveryStatus,
	customMcpDomain: null,
	openaiChallengeToken: null,
	openaiAppId: null,
	appStoreStatus: null,
	activeConfigVersionId: null,
	latestConfigVersion: 1,
	metadata: APP_METADATA[item.id] ?? null,
	extractedAt: null,
	aiSearchSyncedAt: null,
	createdAt: item.createdAt,
	updatedAt: item.updatedAt,
});

export const ELIGIBILITY = [
	{
		appId: APP_STOREFRONT,
		appName: "Storefront",
		result: {
			eligible: true,
			degraded: false,
			missing: [],
			availableTools: ["list_orders", "get_order", "list_subscriptions"],
			unavailableTools: [],
		},
		badge: "ready" as const,
	},
	{
		appId: APP_SUPPORT,
		appName: "Support Inbox",
		result: {
			eligible: false,
			degraded: true,
			missing: [
				{
					type: "connector" as const,
					key: "gmail",
					detail: "Support inbox needs the Gmail connection re-authorized",
					resolution: {
						action: "connect" as const,
						label: "Reconnect Gmail",
						href: "/connections",
					},
				},
			],
			availableTools: ["list_tickets"],
			unavailableTools: [
				{
					name: "reply_ticket",
					reason: "Gmail connection expired",
					missing: [{ type: "connector" as const, key: "gmail" }],
				},
			],
		},
		badge: "setup_needed" as const,
	},
	{
		appId: APP_FINANCE,
		appName: "Finance Ledger",
		result: {
			eligible: true,
			degraded: false,
			missing: [],
			availableTools: ["list_invoices", "create_credit"],
			unavailableTools: [],
		},
		badge: "ready" as const,
	},
];

export const CONNECTION_PROVIDERS = [
	{
		appId: "gmail",
		name: "Gmail",
		description: "Google Workspace mail",
		enabled: true,
		availableScopes: ["gmail.readonly", "gmail.send"],
		logoUrl: null,
		connectionType: "oauth" as const,
		registrationMode: "pre_registered" as const,
		accountMode: "multiple" as const,
		availableAccountModes: ["single" as const, "multiple" as const],
		tokenScope: "tenant" as const,
		supportedScopes: ["tenant" as const, "user" as const],
		recommendedScope: "tenant" as const,
		credentialProfile: null,
		referencedByOrg: true,
	},
	{
		appId: "notion",
		name: "Notion",
		description: "Workspace pages and databases",
		enabled: true,
		availableScopes: ["read_content", "update_content"],
		logoUrl: null,
		connectionType: "api_key" as const,
		registrationMode: null,
		accountMode: "single" as const,
		availableAccountModes: ["single" as const],
		tokenScope: "user" as const,
		supportedScopes: ["user" as const],
		recommendedScope: "user" as const,
		credentialProfile: null,
		referencedByOrg: false,
	},
];

/**
 * Account inventory behind /admin/connections and /account/connections: one
 * row per state the shared account list renders (connected, needs attention,
 * a status check the provider refused, several accounts, never connected).
 */
function inventoryProvider(
	appId: string,
	name: string,
	connectionType: "oauth" | "api_key",
	registrationMode: ConnectionProvider["registrationMode"] = connectionType ===
	"oauth"
		? "pre_registered"
		: null,
	scopeGroups?: { id: string; label: string; scopes: string[] }[],
): ConnectionProvider {
	return {
		appId,
		name,
		description: null,
		enabled: true,
		availableScopes: [],
		logoUrl: null,
		connectionType,
		registrationMode,
		accountMode:
			connectionType === "oauth" && registrationMode !== "cimd"
				? "multiple"
				: "single",
		availableAccountModes:
			connectionType === "oauth" && registrationMode !== "cimd"
				? ["single", "multiple"]
				: ["single"],
		tokenScope: "tenant",
		supportedScopes: ["tenant", "user"],
		recommendedScope: "tenant",
		credentialProfile: scopeGroups ? { scopeGroups } : null,
		referencedByOrg: true,
	};
}

const inventoryAppIds = new Map<string, string>();
function inventoryAppId(slug: string): string {
	let id = inventoryAppIds.get(slug);
	if (!id) {
		id = fid("8a", inventoryAppIds.size + 1);
		inventoryAppIds.set(slug, id);
	}
	return id;
}

const INVENTORY_TOOL_CAPABILITIES: Record<
	string,
	NonNullable<ConnectionInventoryRow["toolCapabilities"]>
> = {
	"google-gmail": [
		{ id: "gmail:search", label: "Search messages", riskTier: "read" },
		{
			id: "gmail:draft",
			label: "Create drafts",
			riskTier: "bounded_write",
		},
		{
			id: "gmail:send",
			label: "Send messages",
			riskTier: "external_side_effect",
		},
	],
	github: [
		{ id: "github:read", label: "Read repositories", riskTier: "read" },
		{
			id: "github:edit",
			label: "Create and edit issues",
			riskTier: "bounded_write",
		},
		{
			id: "github:merge",
			label: "Merge pull requests",
			riskTier: "high_impact_write",
		},
	],
	notion: [
		{ id: "notion:read", label: "Read pages", riskTier: "read" },
		{
			id: "notion:edit",
			label: "Create and edit pages",
			riskTier: "bounded_write",
		},
		{
			id: "notion:share",
			label: "Share pages",
			riskTier: "external_side_effect",
		},
	],
};

function inventoryRow(
	provider: ConnectionProvider,
	scope: "tenant" | "user",
	accountState: ConnectionInventoryRow["accountState"],
	apps: [string, string][],
	extra: Partial<ConnectionInventoryRow> & { grantedScopes?: string[] } = {},
): ConnectionInventoryRow {
	const { grantedScopes, ...rest } = extra;
	const connection =
		accountState === "present" || accountState === "expired"
			? {
					appId: provider.appId,
					providerName: provider.name,
					status:
						accountState === "expired"
							? ("expired" as const)
							: ("connected" as const),
					connectedAt: null,
					tokenExpiresAt: null,
					scopes: grantedScopes ?? [],
					tokenScope: scope,
					connectedByEmail: "owner@solstice.example",
				}
			: null;
	const row = {
		provider,
		scope,
		accountState,
		accountLabel: null,
		connection,
		references: apps.map(([appSlug, appName]) => ({
			appId: inventoryAppId(appSlug),
			appSlug,
			appName,
			source: "app" as const,
		})),
		referencesComplete: true,
		toolCapabilities: INVENTORY_TOOL_CAPABILITIES[provider.appId] ?? [],
		toolCapabilitiesComplete: provider.appId in INVENTORY_TOOL_CAPABILITIES,
		access: "not_evaluated" as const,
		health: "not_checked" as const,
		...rest,
	};
	return { ...row, capabilities: projectConnectionCapabilities(row) };
}

const INVENTORY_PROVIDERS = {
	pricewise: inventoryProvider("pricewise-official", "Pricewise", "api_key"),
	alegra: inventoryProvider("alegra-api-key", "Alegra", "api_key"),
	gmail: inventoryProvider("google-gmail", "Google Gmail", "oauth"),
	github: inventoryProvider("github", "GitHub", "oauth"),
	stripe: inventoryProvider("stripe", "Stripe", "oauth"),
	calendar: inventoryProvider("google-calendar", "Google Calendar", "oauth"),
	sheets: inventoryProvider(
		"google-sheets",
		"Google Sheets",
		"oauth",
		"pre_registered",
		[
			{ id: "identity", label: "Identity", scopes: ["openid", "email"] },
			{ id: "sheets", label: "Sheets", scopes: ["sheets"] },
		],
	),
	sentry: inventoryProvider("sentry", "Sentry", "oauth", "cimd"),
	alpic: inventoryProvider("alpic", "Alpic", "oauth"),
	notion: inventoryProvider("notion", "Notion", "oauth"),
};

export const ORGANIZATION_INVENTORY: ConnectionInventoryRow[] = [
	inventoryRow(INVENTORY_PROVIDERS.pricewise, "tenant", "present", [
		["pricewise-official-f9ab445d", "Pricewise pricing"],
	]),
	inventoryRow(INVENTORY_PROVIDERS.alegra, "tenant", "present", [
		["alegra", "Alegra invoices"],
		["alegra-tedix", "Alegra"],
		["tedix-unified", "Tedix gateway"],
	]),
	inventoryRow(INVENTORY_PROVIDERS.gmail, "tenant", "expired", [
		["storefront", "Storefront"],
	]),
	inventoryRow(INVENTORY_PROVIDERS.stripe, "tenant", "restricted", [
		["stripe", "Stripe payments"],
	]),
	inventoryRow(INVENTORY_PROVIDERS.calendar, "tenant", "missing", [
		["google-calendar", "Google Calendar"],
	]),
	inventoryRow(INVENTORY_PROVIDERS.sentry, "tenant", "missing", [
		["sentry", "Sentry issues"],
	]),
];

export const PERSONAL_INVENTORY: ConnectionInventoryRow[] = [
	inventoryRow(INVENTORY_PROVIDERS.calendar, "user", "present", [
		["google-calendar", "Google Calendar"],
	]),
	inventoryRow(INVENTORY_PROVIDERS.calendar, "user", "present", [], {
		connectionInstanceId: "00000000-0000-4000-8000-0000000000c2",
		instanceLabel: "Work",
	}),
	inventoryRow(
		INVENTORY_PROVIDERS.sheets,
		"user",
		"present",
		[["google-sheets", "Google Sheets"]],
		{ grantedScopes: ["sheets"] },
	),
	inventoryRow(INVENTORY_PROVIDERS.notion, "user", "present", [
		["notion", "Notion"],
	]),
	inventoryRow(INVENTORY_PROVIDERS.github, "user", "present", [
		["github", "GitHub"],
	]),
	inventoryRow(INVENTORY_PROVIDERS.stripe, "user", "restricted", [
		["stripe", "Stripe payments"],
	]),
	inventoryRow(INVENTORY_PROVIDERS.alpic, "user", "missing", [
		["alpic", "Alpic"],
	]),
	inventoryRow(INVENTORY_PROVIDERS.gmail, "user", "missing", [
		["google-gmail", "Gmail"],
	]),
];

export const CONNECTIONS = [
	{
		appId: "gmail",
		providerName: "Gmail",
		status: "expired" as const,
		connectedAt: 1_754_000_000,
		tokenExpiresAt: 1_754_900_000,
		scopes: ["gmail.readonly", "gmail.send"],
		tokenScope: "tenant" as const,
		connectedByUserId: "dev-operator",
		connectedByEmail: "owner@solstice.example",
	},
	{
		appId: "notion",
		providerName: "Notion",
		status: "connected" as const,
		connectedAt: 1_754_500_000,
		tokenExpiresAt: null,
		scopes: ["read_content", "update_content"],
		tokenScope: "user" as const,
		connectedByUserId: "dev-operator",
		connectedByEmail: "owner@solstice.example",
	},
];

export const ORG_MEMBERSHIP = {
	member: {
		id: fid("90", 1),
		organizationId: ORG_ID,
		descopeUserId: "dev-operator",
		userId: "dev-operator",
		email: "owner@solstice.example",
		name: "Local Operator",
		avatarUrl: null,
		role: "owner" as const,
		customPermissions: null,
		status: "active" as const,
		invitedAt: null,
		invitedBy: null,
		inviteAcceptedAt: null,
		lastActiveAt: T5,
		createdAt: T0,
		updatedAt: T5,
	},
	organizationId: ORG_ID,
	organizationName: "Solstice Coffee Co.",
	organizationSlug: "solstice",
	organizationLogoUrl: null,
	organizationType: "organization" as const,
	descopeTenantId: null,
	appsCount: 3,
	tediCount: 3,
	mcpGatewaySlug: "solstice",
	mcpGatewayUrl: "https://solstice.mcp.tedix.dev/mcp",
};

/** The members list as the API resolves it: a tedi signs in as its own member. */
export const TEAM_MEMBERS = [
	ORG_MEMBERSHIP.member,
	{
		...ORG_MEMBERSHIP.member,
		id: fid("90", 2),
		descopeUserId: "tedi-nova",
		userId: null,
		email: "nova@solstice.example",
		name: "Nova",
		avatarUrl: NOVA_AVATAR,
		tediId: TEDI_NOVA,
		role: "member" as const,
		lastActiveAt: T5,
	},
	{
		...ORG_MEMBERSHIP.member,
		id: fid("90", 3),
		descopeUserId: "agent-instinct-local",
		userId: "local-browser-agent",
		email: "agent@mail.fictional.example",
		name: "Instinct",
		avatarUrl: AGENT_AVATAR,
		kind: "browser_agent" as const,
		representedUserId: "dev-operator",
		representedUserName: "Local Operator",
		role: "member" as const,
		lastActiveAt: T5,
	},
];

export const localSuspendedAgentSeats = new Set<string>();

/** Org API keys for /admin/api-keys; raw keys never exist in a list read. */
const apiKeyRow = (
	n: number,
	name: string,
	overrides: Partial<{
		status: "active" | "revoked" | "expired";
		environment: "test" | "live";
		scopes: string[];
		lastUsedAt: string | null;
		revokedAt: string | null;
	}> = {},
) => ({
	id: fid("96", n),
	organizationId: ORG_ID,
	name,
	description: null,
	keyPreview: `sk_test_...${(1000 + n).toString(16)}`,
	scopes: overrides.scopes ?? ["apps:read", "analytics:read"],
	descopeClientId: null,
	environment: overrides.environment ?? ("test" as const),
	lastUsedAt: overrides.lastUsedAt ?? null,
	requestsThisMonth: 0,
	totalRequests: 0,
	ipAllowlist: null,
	expiresAt: null,
	status: overrides.status ?? ("active" as const),
	rotatedAt: null,
	rotationScheduleDays: null,
	previousKeyExpiresAt: null,
	revokedAt: overrides.revokedAt ?? null,
	revokedBy: null,
	revokeReason: null,
	metadata: null,
	createdBy: "dev-operator",
	createdAt: T0,
	updatedAt: T1,
});

// 60 keys: the admin page paginates at 25, so the ledger must span three
// pages for the count, Next/Previous, and delete-refresh to be exercisable.
export const API_KEYS = [
	apiKeyRow(1, "CI/CD Pipeline", { environment: "live", lastUsedAt: T4 }),
	apiKeyRow(2, "Analytics export"),
	apiKeyRow(3, "Legacy importer", { status: "revoked", revokedAt: T2 }),
	...Array.from({ length: 57 }, (_, index) =>
		apiKeyRow(index + 4, `Service key ${index + 4}`),
	),
];

export let localApiKeys = [...API_KEYS];

export function setLocalApiKeys(value: typeof localApiKeys): void {
	localApiKeys = value;
}
