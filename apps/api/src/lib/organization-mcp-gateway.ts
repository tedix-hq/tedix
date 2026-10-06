import { MCP_GRANULAR_CAPABILITY_SCOPES } from "@tedix/api-contract/schemas/mcp-capability-scopes";
import { resolveManagedAssignmentForApp } from "@tedix/auth/app-assignment-policy";
import {
	buildTedixMcpAuthorizationAudiences,
	buildTedixMcpResourceUri,
	reconcileTedixMcpOwnershipTags,
} from "@tedix/auth/aih-audiences";
import {
	type AihEnv,
	hardenDescopeMcpServerRegistration,
	loadAllDescopeMcpServers,
	type McpServerApprovedScopes,
	type McpServerRecord,
	registerDescopeMcpResource,
	updateDescopeMcpServer,
} from "@tedix/auth/aih-client";
import { getManagementClient } from "@tedix/auth/client";
import {
	getAssignedAppRoles,
	grantAppObserver,
	grantAppOperator,
	revokeAppAccess,
} from "@tedix/auth/fga";
import type { DbClient } from "@tedix/db/client";
import {
	createApp,
	getAppBySlug,
	getAppMetadataJson,
	updateApp,
} from "@tedix/db/queries/app-records";
import { getTedisByOrganization } from "@tedix/db/queries/tedis";
import type { AppMetadata } from "@tedix/db/schema/apps";
import { syncTediAihClientForAssignment } from "../services/tedi-mcp-access";

const MCP_SCOPE_DESCRIPTIONS = {
	...MCP_GRANULAR_CAPABILITY_SCOPES,
} as Record<string, string>;
const LEGACY_CAPABILITY_SCOPES = new Set([
	"mcp:tedis",
	"mcp:apps",
	"mcp:memory",
	"mcp:skills",
	"mcp:content",
	"mcp:catalog",
	"mcp:observe",
	"mcp:messaging",
	"mcp:settings",
]);

const DEFAULT_TOOL_SCOPES: Record<string, string[]> = {
	tedis: ["mcp:tedis.write"],
	apps: ["mcp:apps.write"],
	memory: ["mcp:memory.write"],
	skills: ["mcp:skills.write"],
	content: ["mcp:content.write"],
	catalog: ["mcp:catalog.write"],
	observe: ["mcp:observe.write"],
	messaging: ["mcp:messaging.write"],
	work: ["mcp:work.read", "mcp:work.write"],
};

type OrganizationGatewayInput = {
	organizationId: string;
	organizationName: string;
	organizationSlug: string;
	gatewaySlug?: string | null;
};

export type OrganizationGatewayProvisioningResult = {
	appId: string;
	descopeResourceId: string;
	gatewaySlug: string;
	mcpUrl: string;
};

export class OrganizationGatewaySlugConflictError extends Error {
	constructor(slug: string) {
		super(`MCP gateway slug "${slug}" belongs to another organization`);
		this.name = "OrganizationGatewaySlugConflictError";
	}
}

function isCredentialFreeLocalDemo(env: CloudflareEnv): boolean {
	return (
		env.ENVIRONMENT === "development" &&
		env.DESCOPE_PROJECT_ID === "local-development-disabled" &&
		(
			env as CloudflareEnv & {
				TEDIX_LOCAL_DEMO_ENABLED?: string;
			}
		).TEDIX_LOCAL_DEMO_ENABLED === "true"
	);
}

function requireAihEnv(env: CloudflareEnv): AihEnv {
	if (!env.DESCOPE_PROJECT_ID || !env.DESCOPE_MANAGEMENT_KEY) {
		throw new Error("Descope AIH management credentials are not configured");
	}
	return {
		DESCOPE_PROJECT_ID: env.DESCOPE_PROJECT_ID,
		DESCOPE_MANAGEMENT_KEY: env.DESCOPE_MANAGEMENT_KEY,
	};
}

export function organizationGatewaySlug(
	organizationSlug: string,
	organizationId: string,
): string {
	const suffix = "-unified";
	if (organizationSlug.length + suffix.length <= 63) {
		return `${organizationSlug}${suffix}`;
	}
	const uniquenessSuffix = `-${organizationId.slice(0, 8)}${suffix}`;
	return `${organizationSlug.slice(0, 63 - uniquenessSuffix.length).replace(/-+$/, "")}${uniquenessSuffix}`;
}

function sameStringSet(
	left: readonly string[] | null | undefined,
	right: readonly string[] | null | undefined,
): boolean {
	return (
		JSON.stringify([...(left ?? [])].sort()) ===
		JSON.stringify([...(right ?? [])].sort())
	);
}

function mergeApprovedScopes(
	existing: McpServerApprovedScopes | null | undefined,
): McpServerApprovedScopes {
	const desired = Object.entries(MCP_SCOPE_DESCRIPTIONS).map(
		([name, description]) => ({ name, description, optional: true }),
	);
	const desiredNames = new Set(desired.map((scope) => scope.name));
	const retained = (existing?.connectionsScopes ?? []).filter(
		(scope) =>
			!desiredNames.has(scope.name) &&
			!LEGACY_CAPABILITY_SCOPES.has(scope.name),
	);
	return {
		...existing,
		connectionsScopes: [...retained, ...desired],
	};
}

function hasCanonicalServerShape(
	server: McpServerRecord,
	desired: McpServerRecord,
): boolean {
	return (
		server.name === desired.name &&
		(server.description ?? null) === (desired.description ?? null) &&
		sameStringSet(server.audienceWhitelist, desired.audienceWhitelist) &&
		sameStringSet(server.tags, desired.tags) &&
		JSON.stringify(server.approvedScopes ?? {}) ===
			JSON.stringify(desired.approvedScopes ?? {}) &&
		JSON.stringify(server.dynamicRegistration ?? {}) ===
			JSON.stringify(desired.dynamicRegistration ?? {}) &&
		JSON.stringify(server.cimdSettings ?? {}) ===
			JSON.stringify(desired.cimdSettings ?? {}) &&
		(server.loginPageURL ?? server.loginPageUrl ?? null) ===
			(desired.loginPageURL ?? desired.loginPageUrl ?? null)
	);
}

async function ensureDescopeMcpServer(
	env: AihEnv,
	input: {
		currentResourceId?: string | null;
		description: string;
		gatewaySlug: string;
		name: string;
	},
): Promise<McpServerRecord> {
	const audiences = [buildTedixMcpResourceUri(input.gatewaySlug)];
	const ownershipTag = `app:${input.gatewaySlug}`;
	const servers = await loadAllDescopeMcpServers(env);
	const current = input.currentResourceId
		? servers.find((server) => server.id === input.currentResourceId)
		: undefined;
	const candidates = servers.filter(
		(server) =>
			(server.tags ?? []).includes(ownershipTag) ||
			(server.audienceWhitelist ?? []).some((audience) =>
				audiences.includes(audience),
			),
	);

	let server = current;
	if (!server) {
		if (candidates.length > 1) {
			throw new Error(
				`Multiple Descope MCP servers claim gateway ${input.gatewaySlug}`,
			);
		}
		server = candidates[0];
	}

	if (!server) {
		return registerDescopeMcpResource(env, {
			name: input.name,
			description: input.description,
			audienceWhitelist: [buildTedixMcpResourceUri(input.gatewaySlug)],
			tags: reconcileTedixMcpOwnershipTags([], {
				app: input.gatewaySlug,
			}),
			approvedScopes: mergeApprovedScopes(undefined),
		});
	}

	const desired = hardenDescopeMcpServerRegistration(
		{
			...server,
			name: input.name,
			description: input.description,
			audienceWhitelist: buildTedixMcpAuthorizationAudiences(input.gatewaySlug),
			tags: reconcileTedixMcpOwnershipTags(server.tags, {
				app: input.gatewaySlug,
			}),
			approvedScopes: mergeApprovedScopes(server.approvedScopes),
		},
		env,
	);
	return hasCanonicalServerShape(server, desired)
		? server
		: updateDescopeMcpServer(env, desired);
}

function mergedAggregateTedis(
	existingConfig: Record<string, unknown>,
	firstTedi: { slug: string } | undefined,
) {
	const existing = Array.isArray(existingConfig.aggregateTedis)
		? existingConfig.aggregateTedis.filter(
				(entry): entry is Record<string, unknown> =>
					Boolean(entry) && typeof entry === "object" && !Array.isArray(entry),
			)
		: [];
	if (!firstTedi) return existing;
	if (existing.some((entry) => entry.slug === firstTedi.slug)) return existing;
	return [...existing, { slug: firstTedi.slug, surface: "full" }];
}

function mergedToolScopes(existingConfig: Record<string, unknown>) {
	const existing =
		existingConfig.toolScopes &&
		typeof existingConfig.toolScopes === "object" &&
		!Array.isArray(existingConfig.toolScopes)
			? (existingConfig.toolScopes as Record<string, unknown>)
			: DEFAULT_TOOL_SCOPES;
	const work = Array.isArray(existing.work)
		? existing.work.filter(
				(scope): scope is string => typeof scope === "string",
			)
		: [];
	return {
		...existing,
		work: [...new Set([...work, "mcp:work.read", "mcp:work.write"])],
	};
}

/**
 * Move an existing unified gateway onto the organization's new handle.
 *
 * The handle is an address, not an identity: people read and paste
 * `<handle>-unified.mcp.tedix.dev/mcp`, so a corrected handle has to take the
 * gateway with it. Renaming the app row BEFORE {@link
 * ensureOrganizationUnifiedGateway} is what makes that a move instead of a
 * second gateway — `ensure` resolves by slug, so on a fresh slug it would
 * create a new shell and strand the old one, still holding the AIH resource.
 *
 * Returns null when there is nothing to move; the caller's later `ensure`
 * creates the gateway on the new handle.
 */
export async function renameOrganizationUnifiedGateway(
	db: DbClient,
	env: CloudflareEnv,
	input: {
		organizationId: string;
		organizationName: string;
		currentGatewaySlug: string | null | undefined;
		nextOrganizationSlug: string;
	},
): Promise<OrganizationGatewayProvisioningResult | null> {
	const nextGatewaySlug = organizationGatewaySlug(
		input.nextOrganizationSlug,
		input.organizationId,
	).toLowerCase();
	if (!input.currentGatewaySlug) return null;
	const current = await getAppBySlug(db, input.currentGatewaySlug);
	if (!current || current.organizationId !== input.organizationId) return null;
	if (current.slug !== nextGatewaySlug) {
		// Refuse before any write when the destination belongs to someone else.
		const occupant = await getAppBySlug(db, nextGatewaySlug);
		if (occupant && occupant.id !== current.id)
			throw new OrganizationGatewaySlugConflictError(nextGatewaySlug);
		await updateApp(db, current.id, { slug: nextGatewaySlug });
	}
	// Converges name, expectedAudience and the AIH resource on the new handle,
	// updating the resource in place because the app carries its id.
	return ensureOrganizationUnifiedGateway(db, env, {
		organizationId: input.organizationId,
		organizationName: input.organizationName,
		organizationSlug: input.nextOrganizationSlug,
		gatewaySlug: nextGatewaySlug,
	});
}

/**
 * Ensure the organization has one externally connectable Code Mode gateway.
 *
 * The D1 shell is created before the external Descope mutation, but it is not
 * discoverable as a gateway until the AIH resource id is persisted. If a call
 * stops after either mutation, the next call reuses the shell and the
 * ownership-tagged AIH server instead of creating another resource.
 */
export async function ensureOrganizationUnifiedGateway(
	db: DbClient,
	env: CloudflareEnv,
	input: OrganizationGatewayInput,
): Promise<OrganizationGatewayProvisioningResult> {
	const gatewaySlug = (
		input.gatewaySlug ??
		organizationGatewaySlug(input.organizationSlug, input.organizationId)
	).toLowerCase();
	const gatewayName = `${input.organizationName} Unified MCP`;
	const gatewayDescription = `Unified MCP gateway for ${input.organizationName}.`;
	const localDemo = isCredentialFreeLocalDemo(env);
	const mcpUrl = localDemo
		? env.MCP_URL
		: `https://${gatewaySlug}.mcp.tedix.dev/mcp`;

	let app = await getAppBySlug(db, gatewaySlug);
	if (app && app.organizationId !== input.organizationId) {
		throw new OrganizationGatewaySlugConflictError(gatewaySlug);
	}

	if (!app) {
		try {
			app = await createApp(db, {
				organizationId: input.organizationId,
				name: gatewayName,
				slug: gatewaySlug,
				primaryDomain: null,
				description: gatewayDescription,
				logoUrl: null,
				visibility: "private",
				discoveryStatus: "pending",
				metadata: {
					mcpConfig: {
						serverName: gatewayName,
						expectedAudience: mcpUrl,
						provisioningStatus: "pending",
					},
				} as AppMetadata,
			});
		} catch (error) {
			// A concurrent retry may have won the unique slug insert. Reload and
			// continue only when it created the same organization's gateway shell.
			app = await getAppBySlug(db, gatewaySlug);
			if (!app) throw error;
		}
	}
	if (!app || app.organizationId !== input.organizationId) {
		throw new OrganizationGatewaySlugConflictError(gatewaySlug);
	}

	const currentMetadata = getAppMetadataJson(app) ?? {};
	const currentConfig =
		currentMetadata.mcpConfig && typeof currentMetadata.mcpConfig === "object"
			? (currentMetadata.mcpConfig as Record<string, unknown>)
			: {};
	const currentResourceId =
		typeof currentConfig.descopeResourceId === "string"
			? currentConfig.descopeResourceId
			: null;
	const descopeResourceId = localDemo
		? `local-${gatewaySlug}`
		: (
				await ensureDescopeMcpServer(requireAihEnv(env), {
					currentResourceId,
					description: gatewayDescription,
					gatewaySlug,
					name: gatewayName,
				})
			).id;

	if (localDemo) {
		// A fresh local database has no shared platform catalog. Project the
		// canonical workspace tools into this tenant's own gateway instead.
		const { runToolSchemaSync, OS_TOOL_ID_OVERRIDES, OS_KIND_OVERRIDES } =
			await import("../services/tool-schema-sync");
		const result = await runToolSchemaSync(db, {
			appId: app.id,
			mode: "projection",
			router: "osWorkspaces",
			includeInternal: false,
			apply: true,
			toolIdOverrides: OS_TOOL_ID_OVERRIDES,
			kindOverrides: OS_KIND_OVERRIDES,
		});
		if (result.failed > 0 || result.total === 0) {
			throw new Error("Failed to provision local workspace tools");
		}
	}

	const [firstTedi] = await getTedisByOrganization(db, input.organizationId);
	const finalMetadata: AppMetadata = {
		...currentMetadata,
		mcpConfig: {
			...currentConfig,
			serverName: gatewayName,
			authMode: "authenticated",
			codeMode: true,
			// The first tedi predates this app; later tedis use this same managed policy.
			assignmentConfig: currentConfig.assignmentConfig ?? {
				mode: "profile-default",
				role: "operator",
			},
			expectedAudience: mcpUrl,
			descopeResourceId,
			toolScopes: mergedToolScopes(currentConfig),
			scopeDescriptions: {
				...MCP_SCOPE_DESCRIPTIONS,
				...(currentConfig.scopeDescriptions &&
				typeof currentConfig.scopeDescriptions === "object"
					? (currentConfig.scopeDescriptions as Record<string, string>)
					: {}),
			},
			aggregateTedis: mergedAggregateTedis(currentConfig, firstTedi),
			provisioningStatus: "ready",
		},
	};
	const updated = await updateApp(db, app.id, {
		name: gatewayName,
		description: gatewayDescription,
		metadata: finalMetadata,
	});
	if (!updated) {
		throw new Error(`Failed to finalize MCP gateway ${gatewaySlug}`);
	}
	// A ready gateway is unusable to its first tedi until both FGA and the AIH
	// client exist. Converge those effects on every onboarding retry.
	if (firstTedi && !localDemo) {
		const assignment = resolveManagedAssignmentForApp(
			{
				id: updated.id,
				name: updated.name,
				slug: updated.slug,
				metadata: getAppMetadataJson(updated),
			},
			firstTedi,
		);
		if (assignment) {
			if (!firstTedi.descopeUserId) {
				throw new Error(`First tedi ${firstTedi.id} has no Descope identity`);
			}
			const mgmt = getManagementClient(env);
			const currentRole = (
				await getAssignedAppRoles(mgmt, firstTedi.descopeUserId, [updated.id])
			)[updated.id];
			if (currentRole !== assignment.role) {
				if (currentRole) {
					await revokeAppAccess(mgmt, firstTedi.descopeUserId, updated.id);
				}
				await (assignment.role === "operator"
					? grantAppOperator(mgmt, firstTedi.descopeUserId, updated.id)
					: grantAppObserver(mgmt, firstTedi.descopeUserId, updated.id));
			}
			const synced = await syncTediAihClientForAssignment({
				db,
				env,
				tedi: firstTedi,
				app: updated,
				role: assignment.role,
			});
			if (synced.status === "skipped") {
				throw new Error(
					`First tedi MCP access was not provisioned for ${gatewaySlug}: ${synced.reason ?? "AIH client sync skipped"}`,
				);
			}
		}
	}

	return {
		appId: app.id,
		descopeResourceId,
		gatewaySlug,
		mcpUrl,
	};
}
