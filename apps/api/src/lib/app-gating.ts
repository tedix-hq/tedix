/**
 * App Gating Engine
 * Core eligibility checking for MCP apps based on org state.
 *
 * Determines which apps and tools are available to an organization
 * based on plan tier, connectors, scopes, features, and tool dependencies.
 */

import type {
	AppGatingMetadata,
	AppRequirements,
	ConnectorState,
	EligibilityBadge,
	EligibilityResult,
	OrgState,
	PlanTier,
	RequirementMissing,
	RuntimeToolInfo,
} from "@tedix/api-contract/schemas/app-gating";
import {
	AppGatingMetadataSchema,
	PLAN_HIERARCHY,
} from "@tedix/api-contract/schemas/app-gating";
import {
	type JsonValue,
	JsonValueSchema,
} from "@tedix/api-contract/schemas/common";
import { getManagementClient } from "@tedix/auth/client";
import {
	fetchConnectionToken,
	fetchTenantConnectionToken,
} from "@tedix/auth/connections";
import { getOperableApps } from "@tedix/auth/fga";
import type { DescopeEnv } from "@tedix/auth/types";
import { createDbClient } from "@tedix/db/client";
import {
	getAppGatingMetadata,
	getAppsWithGatingByIds,
	getEnabledToolDetailsForApp,
	getEnabledToolIdsForApp,
	getInstalledToolIdsForOrg,
	getOrgAppsWithGating,
	getOrgForGating,
} from "@tedix/db/queries/app-gating";
import {
	getRuntimeEntitlement,
	runtimeEntitlementIsActive,
} from "@tedix/db/queries/runtime-entitlements";

type GatingDescopeEnv = {
	DESCOPE_PROJECT_ID?: string;
	DESCOPE_MANAGEMENT_KEY?: string;
	DESCOPE_BASE_URL?: string;
};

function asJsonRecord(value: unknown): Record<string, JsonValue> {
	const parsed = JsonValueSchema.safeParse(value);
	return parsed.success &&
		parsed.data !== null &&
		typeof parsed.data === "object" &&
		!Array.isArray(parsed.data)
		? parsed.data
		: {};
}

function parseJsonRecord(raw: unknown): Record<string, JsonValue> {
	if (!raw) return {};
	if (typeof raw === "string") {
		const parsed = JSON.parse(raw);
		return asJsonRecord(parsed);
	}
	return asJsonRecord(raw);
}

// =============================================================================
// ORG STATE RESOLUTION
// =============================================================================

/**
 * Map existing org subscription tiers to gating plan tiers.
 *
 * Org tiers: starter | growth | enterprise (+ trial status)
 * Gating tiers: free | starter | pro | enterprise
 */
function mapRuntimeProfileToGatingPlan(
	profileKey: string | null | undefined,
	active: boolean,
): PlanTier {
	if (!active) return "free";

	switch (profileKey) {
		case "starter":
			return "starter";
		case "growth":
		case "business":
			return "pro";
		case "enterprise":
			return "enterprise";
		default:
			return "free";
	}
}

function hasDescopeManagementEnv(
	env: GatingDescopeEnv | undefined,
): env is DescopeEnv {
	return Boolean(env?.DESCOPE_PROJECT_ID && env?.DESCOPE_MANAGEMENT_KEY);
}

async function resolveDescopeConnectors(
	env: GatingDescopeEnv | undefined,
	tenantId: string | null | undefined,
	userId?: string,
): Promise<ConnectorState[]> {
	if (!tenantId || !hasDescopeManagementEnv(env)) return [];

	try {
		const client = getManagementClient(env);
		const response =
			await client.management.outboundApplication.loadAllApplications();
		if (!response.ok || !response.data) return [];

		return Promise.all(
			response.data.map(async (app) => {
				const [tenantToken, userToken] = await Promise.all([
					fetchTenantConnectionToken(client, app.id, tenantId).catch(
						() => null,
					),
					userId
						? fetchConnectionToken(client, app.id, userId, tenantId).catch(
								() => null,
							)
						: Promise.resolve(null),
				]);
				const token = tenantToken ?? userToken;
				const scopes = Array.from(
					new Set([
						...(tenantToken?.scopes ?? []),
						...(userToken?.scopes ?? []),
					]),
				);
				const expiresAt = Math.max(
					tenantToken?.expiresAt ?? 0,
					userToken?.expiresAt ?? 0,
				);

				return {
					provider: app.id,
					active: Boolean(token),
					scopes,
					tokenExpiresAt: expiresAt > 0 ? expiresAt : undefined,
				};
			}),
		);
	} catch (error) {
		console.warn("[AppGating] Descope connector state unavailable:", error);
		return [];
	}
}

/**
 * Build OrgState from database queries.
 * Fetches org plan, active Descope connections, features, and installed tools.
 */
export async function buildOrgState(
	db: D1Database,
	orgId: string,
	env?: GatingDescopeEnv,
	descopeUserId?: string,
): Promise<OrgState> {
	const drizzle = createDbClient(db);

	const [orgResult, entitlement] = await Promise.all([
		getOrgForGating(drizzle, orgId),
		getRuntimeEntitlement(drizzle, orgId),
	]);
	const entitlementActive = Boolean(
		entitlement && runtimeEntitlementIsActive(entitlement, Date.now()),
	);
	const plan = mapRuntimeProfileToGatingPlan(
		entitlement?.profile.key,
		entitlementActive,
	);
	const entitlements = entitlementActive
		? (entitlement?.grants
				.filter((grant) => grant.status === "active")
				.map((grant) => grant.key) ?? [])
		: [];

	// Fetch org features from JSON column
	let features: string[] = [];
	if (orgResult?.features) {
		try {
			const parsed = parseJsonRecord(orgResult.features);
			// Convert feature flags object to array of enabled feature names
			features = Object.entries(parsed)
				.filter(([_, v]) => v === true)
				.map(([k]) => k);
		} catch {
			features = [];
		}
	}

	const connectors = await resolveDescopeConnectors(
		env,
		orgResult?.descopeTenantId,
		descopeUserId,
	);

	// Fetch all tool names from installed apps
	const installedTools = await getInstalledToolIdsForOrg(drizzle, orgId);

	return {
		orgId,
		plan,
		entitlements,
		connectors,
		features,
		installedTools,
	};
}

// =============================================================================
// CORE GATING ENGINE
// =============================================================================

/**
 * Check requirements against org state. Returns list of missing requirements.
 */
function checkRequirements(
	requires: AppRequirements,
	org: OrgState,
): RequirementMissing[] {
	const missing: RequirementMissing[] = [];

	// 1. Plan check
	if (
		requires.plan &&
		PLAN_HIERARCHY[org.plan] < PLAN_HIERARCHY[requires.plan]
	) {
		missing.push({
			type: "plan",
			key: requires.plan,
			detail: `Requires ${requires.plan} plan, org is on ${org.plan}`,
			resolution: {
				action: "upgrade",
				label: `Upgrade to ${requires.plan}`,
				href: "/settings/billing",
			},
		});
	}

	// 2. Connector checks
	for (const entitlement of requires.entitlements ?? []) {
		if (!org.entitlements.includes(entitlement)) {
			missing.push({
				type: "entitlement",
				key: entitlement,
				detail: `Requires runtime entitlement: ${entitlement}`,
				resolution: {
					action: "enable",
					label: `Enable ${entitlement}`,
					href: "/settings/organization",
				},
			});
		}
	}

	// 3. Connector checks
	for (const connector of requires.connectors ?? []) {
		const state = org.connectors.find(
			(c) => c.provider === connector && c.active,
		);
		if (!state) {
			missing.push({
				type: "connector",
				key: connector,
				detail: `Requires ${connector} connection`,
				resolution: {
					action: "connect",
					label: `Connect ${connector}`,
					href: `/settings/connectors/${connector}`,
				},
			});
		}
	}

	// 4. Scope checks
	// Note: Scopes are currently hardcoded. Read from Descope or connection mappings when available.
	// Until scope data is available, scope checks pass by default to avoid
	// incorrectly blocking apps when connector is present but scopes are unknown.
	const scopeEntries = Object.entries(requires.scopes ?? {}) as [
		string,
		string[],
	][];
	for (const [connector, scopes] of scopeEntries) {
		const state = org.connectors.find(
			(c: ConnectorState) => c.provider === connector && c.active,
		);
		if (!state) continue; // already caught by connector check
		// If no scope data available (empty array), treat as "all scopes granted"
		if (state.scopes.length === 0) continue;
		const missingScopes = scopes.filter(
			(s: string) => !state.scopes.includes(s),
		);
		for (const scope of missingScopes) {
			missing.push({
				type: "scope",
				key: `${connector}.${scope}`,
				detail: `Requires ${scope} scope on ${connector}`,
				resolution: {
					action: "connect",
					label: `Re-authorize ${connector} with ${scope}`,
					href: `/settings/connectors/${connector}?scopes=${scopes.join(",")}`,
				},
			});
		}
	}

	// 5. Feature checks
	for (const feature of requires.features ?? []) {
		if (!org.features.includes(feature)) {
			missing.push({
				type: "feature",
				key: feature,
				detail: `Requires platform feature: ${feature}`,
				resolution: {
					action: "enable",
					label: `Enable ${feature}`,
					href: "/settings/features",
				},
			});
		}
	}

	// 6. Tool dependency checks
	for (const tool of requires.tools ?? []) {
		if (!org.installedTools.includes(tool)) {
			missing.push({
				type: "tool",
				key: tool,
				detail: `Requires tool: ${tool}`,
				resolution: {
					action: "install",
					label: `Install app providing ${tool}`,
					href: `/marketplace?tool=${tool}`,
				},
			});
		}
	}

	return missing;
}

/**
 * Check app eligibility for an organization.
 * Core gating function that determines which tools are available.
 */
export function checkAppEligibility(
	metadata: AppGatingMetadata,
	org: OrgState,
): EligibilityResult {
	const { requires, gating, provides } = metadata.tedix;
	const missing = checkRequirements(requires, org);
	const allToolNames = provides.tools.map((t) => t.name);

	// All requirements met
	if (missing.length === 0) {
		return {
			eligible: true,
			degraded: false,
			missing: [],
			availableTools: allToolNames,
			unavailableTools: [],
		};
	}

	// Strict mode — all or nothing
	if (gating.mode === "strict") {
		return {
			eligible: false,
			degraded: false,
			missing,
			availableTools: [],
			unavailableTools: allToolNames.map((name) => ({
				name,
				reason: "App requirements not met",
				missing,
			})),
		};
	}

	// Degraded mode — partial functionality
	const degradedSet = new Set(gating.degradedTools ?? []);
	return {
		eligible: true,
		degraded: true,
		missing,
		availableTools: allToolNames.filter((t) => degradedSet.has(t)),
		unavailableTools: allToolNames
			.filter((t) => !degradedSet.has(t))
			.map((name) => ({
				name,
				reason: "Missing requirements for full access",
				missing,
			})),
	};
}

/**
 * Compute eligibility badge for marketplace display.
 */
export function getEligibilityBadge(
	result: EligibilityResult,
): EligibilityBadge {
	if (result.eligible && !result.degraded) return "ready";
	if (result.missing.some((m) => m.type === "plan")) return "plan_upgrade";
	return "setup_needed";
}

// =============================================================================
// HIGH-LEVEL FUNCTIONS (used by API routes)
// =============================================================================

/**
 * Check eligibility for a single app.
 * Fetches app gating metadata from D1 and org state, then runs check.
 */
export async function checkAppEligibilityById(
	db: D1Database,
	appId: string,
	orgId: string,
	env?: GatingDescopeEnv,
	descopeUserId?: string,
): Promise<EligibilityResult> {
	const drizzle = createDbClient(db);

	// Fetch app's gating metadata from the gating_metadata JSON column
	const app = await getAppGatingMetadata(drizzle, appId);

	if (!app?.gatingMetadata) {
		// No gating metadata = app is always eligible (all tools available)
		const toolIds = await getEnabledToolIdsForApp(drizzle, appId);
		return {
			eligible: true,
			degraded: false,
			missing: [],
			availableTools: toolIds,
			unavailableTools: [],
		};
	}

	let parsed: unknown;
	try {
		parsed = parseJsonRecord(app.gatingMetadata);
	} catch {
		// Invalid JSON — fail closed, never grant access on malformed metadata
		return {
			eligible: false,
			missing: [
				{
					type: "feature",
					key: "valid_gating_metadata",
					detail: "Invalid app gating metadata: failed to parse JSON",
				},
			],
			degraded: false,
			availableTools: [],
			unavailableTools: [],
		};
	}

	const validated = AppGatingMetadataSchema.safeParse(parsed);
	if (!validated.success) {
		// Malformed but valid JSON — fail closed
		return {
			eligible: false,
			missing: [
				{
					type: "feature",
					key: "valid_gating_metadata",
					detail: `Invalid app gating metadata: ${validated.error.message}`,
				},
			],
			degraded: false,
			availableTools: [],
			unavailableTools: [],
		};
	}

	const orgState = await buildOrgState(db, orgId, env, descopeUserId);
	return checkAppEligibility(validated.data, orgState);
}

/**
 * Check eligibility for all installed apps of an org.
 * Used by tedi on session start.
 */
export async function checkInstalledAppsEligibility(
	db: D1Database,
	orgId: string,
	env?: GatingDescopeEnv,
	descopeUserId?: string,
): Promise<
	Array<{ appId: string; appName: string; result: EligibilityResult }>
> {
	const drizzle = createDbClient(db);
	const orgState = await buildOrgState(db, orgId, env, descopeUserId);

	// Fetch all apps for org with gating metadata
	const appsResult = await getOrgAppsWithGating(drizzle, orgId);

	const results: Array<{
		appId: string;
		appName: string;
		result: EligibilityResult;
	}> = [];

	for (const app of appsResult) {
		if (!app.gatingMetadata) {
			// No gating metadata — always eligible
			const toolIds = await getEnabledToolIdsForApp(drizzle, app.id);
			results.push({
				appId: app.id,
				appName: app.name,
				result: {
					eligible: true,
					degraded: false,
					missing: [],
					availableTools: toolIds,
					unavailableTools: [],
				},
			});
			continue;
		}

		try {
			const raw = parseJsonRecord(app.gatingMetadata);
			const parsed = AppGatingMetadataSchema.safeParse(raw);
			if (!parsed.success) {
				results.push({
					appId: app.id,
					appName: app.name,
					result: {
						eligible: false,
						missing: [
							{
								type: "feature",
								key: "valid_gating_metadata",
								detail: `Invalid app gating metadata: ${parsed.error.message}`,
							},
						],
						degraded: false,
						availableTools: [],
						unavailableTools: [],
					},
				});
				continue;
			}
			const metadata: AppGatingMetadata = parsed.data;
			results.push({
				appId: app.id,
				appName: app.name,
				result: checkAppEligibility(metadata, orgState),
			});
		} catch {
			// Invalid metadata — fail closed, never grant access on malformed metadata
			results.push({
				appId: app.id,
				appName: app.name,
				result: {
					eligible: false,
					missing: [
						{
							type: "feature",
							key: "valid_gating_metadata",
							detail: "Invalid app gating metadata: failed to parse JSON",
						},
					],
					degraded: false,
					availableTools: [],
					unavailableTools: [],
				},
			});
		}
	}

	return results;
}

/**
 * Get runtime tools for a tedi session.
 * Returns flat list of tools with availability status.
 */
export async function getRuntimeTools(
	db: D1Database,
	_tediId: string,
	orgId: string,
	env?: {
		DESCOPE_PROJECT_ID?: string;
		DESCOPE_MANAGEMENT_KEY?: string;
		DESCOPE_BASE_URL?: string;
	},
	descopeUserId?: string,
): Promise<RuntimeToolInfo[]> {
	const drizzle = createDbClient(db);
	const orgState = await buildOrgState(db, orgId, env, descopeUserId);

	// Get apps assigned to this tedi via FGA
	let appIds: string[] = [];
	if (descopeUserId && env?.DESCOPE_MANAGEMENT_KEY) {
		const mgmt = getManagementClient({
			DESCOPE_PROJECT_ID: env.DESCOPE_PROJECT_ID ?? "",
			DESCOPE_MANAGEMENT_KEY: env.DESCOPE_MANAGEMENT_KEY,
			DESCOPE_BASE_URL: env.DESCOPE_BASE_URL,
		} satisfies DescopeEnv);
		const orgApps = await getOrgAppsWithGating(drizzle, orgId);
		appIds = await getOperableApps(
			mgmt,
			descopeUserId,
			orgApps.map((a) => a.id),
		);
	}
	const assignmentsResult = await getAppsWithGatingByIds(
		drizzle,
		appIds,
		orgId,
	);

	const tools: RuntimeToolInfo[] = [];

	function parseToolInputSchema(raw: unknown): Record<string, JsonValue> {
		try {
			if (!raw) return {};
			return parseJsonRecord(raw);
		} catch {
			return {};
		}
	}

	for (const app of assignmentsResult) {
		// Fetch actual tools from DB
		const appToolsResult = await getEnabledToolDetailsForApp(drizzle, app.id);

		if (!app.gatingMetadata) {
			// No gating — all tools available
			for (const tool of appToolsResult) {
				const inputSchema = parseToolInputSchema(tool.inputSchema);
				tools.push({
					name: tool.toolId,
					description: tool.description ?? tool.title,
					inputSchema,
					available: true,
				});
			}
			continue;
		}

		try {
			const raw = parseJsonRecord(app.gatingMetadata);
			const parsed = AppGatingMetadataSchema.safeParse(raw);
			if (!parsed.success) {
				// Invalid metadata — fail closed, mark all tools unavailable
				for (const tool of appToolsResult) {
					const inputSchema = parseToolInputSchema(tool.inputSchema);
					tools.push({
						name: tool.toolId,
						description: tool.description ?? tool.title,
						inputSchema,
						available: false,
						unavailableReason: `Invalid app gating metadata: ${parsed.error.message}`,
					});
				}
				continue;
			}
			const metadata: AppGatingMetadata = parsed.data;
			const result = checkAppEligibility(metadata, orgState);
			const availableSet = new Set(result.availableTools);

			for (const tool of appToolsResult) {
				const inputSchema = parseToolInputSchema(tool.inputSchema);
				tools.push({
					name: tool.toolId,
					description: tool.description ?? tool.title,
					inputSchema,
					available: availableSet.has(tool.toolId),
					unavailableReason: availableSet.has(tool.toolId)
						? undefined
						: result.unavailableTools.find((t) => t.name === tool.toolId)
								?.reason,
				});
			}
		} catch {
			// Invalid metadata — fail closed, mark all tools unavailable
			for (const tool of appToolsResult) {
				const inputSchema = parseToolInputSchema(tool.inputSchema);
				tools.push({
					name: tool.toolId,
					description: tool.description ?? tool.title,
					inputSchema,
					available: false,
					unavailableReason: "Invalid app gating metadata",
				});
			}
		}
	}

	return tools;
}

/**
 * Install-time eligibility check with setup guidance.
 * Returns eligibility result plus actionable steps.
 */
export async function checkInstallEligibility(
	db: D1Database,
	appId: string,
	orgId: string,
	env?: GatingDescopeEnv,
	descopeUserId?: string,
): Promise<EligibilityResult & { installable: boolean }> {
	const result = await checkAppEligibilityById(
		db,
		appId,
		orgId,
		env,
		descopeUserId,
	);

	// Apps can always be installed (tools just won't activate until requirements are met)
	// But we flag plan-gated apps as not installable
	const planBlocked = result.missing.some((m) => m.type === "plan");

	return {
		...result,
		installable: !planBlocked,
	};
}
