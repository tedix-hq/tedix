/**
 * oRPC Apps Router
 * App CRUD, metadata, capabilities, adapters, tools, and MCP configuration management
 *
 * This router uses contract-first development with oRPC.
 * Shared schemas are imported from @tedix/api-contract package.
 */

import { implement } from "@orpc/server";
import { appsContract } from "@tedix/api-contract/contracts/apps";
import type { AppMetadata as ContractAppMetadata } from "@tedix/api-contract/schemas/app";
import {
	buildTedixMcpResourceUri,
	reconcileTedixMcpOwnershipTags,
} from "@tedix/auth/aih-audiences";
import { MCP_GRANULAR_CAPABILITY_SCOPES } from "@tedix/api-contract/schemas/mcp-capability-scopes";
import {
	deleteDescopeMcpServer,
	registerDescopeMcpResource,
} from "@tedix/auth/aih-client";
import { generateScopeManifest } from "@tedix/auth/scope-sync";
import { isPlatformPrincipal } from "@tedix/auth/types";
import type { DbClient } from "@tedix/db/client";
import { getAdaptersByAppId } from "@tedix/db/queries/adapters";
import {
	activateAppConfigVersion,
	createAppConfigVersion,
	listAppConfigVersions,
	publishAppConfigVersion,
} from "@tedix/db/queries/app-config-versions";
import {
	aggregateAppEntryMatches,
	getAggregateAppLinkTargets,
} from "@tedix/db/queries/aggregate-app-links";
import {
	setAppGatewayMembership,
	createApp,
	deleteApp,
	getAppByDomain,
	getAppById,
	getAppByIdWithToolsForOrganization,
	getAppBySlug,
	getAppBySlugWithTools,
	getAppMetadataJson,
	getAppsBySlugsWithTools,
	updateApp,
} from "@tedix/db/queries/app-records";
import { listAppSecrets } from "@tedix/db/queries/app-secrets";
import { getOrganizationAggregatorGateways } from "@tedix/db/queries/organization-members";
import { getAppsByOrganization } from "@tedix/db/queries/apps";
import { getOrganizationById } from "@tedix/db/queries/organizations";
import { getToolsByAppId } from "@tedix/db/queries/tools";
import type { AppMetadata } from "@tedix/db/schema/apps";
import { scrapeBrandingFromUrl } from "../../integrations/browser-run/branding";
import { generateAppSlug, isReservedAppSlug } from "../../utils/app";
import { getDomain } from "../../utils/url-processing";
import { requireOrgId } from "../org-scope";
import {
	AUTHZ,
	withAuthorization,
	type BaseContext,
	createError,
	ErrorCodes,
	skipOutputValidation,
	withAuth,
} from "../orpc";
import { mergeAppMetadataPatch, normalizeAppMetadata } from "./app-metadata";
import { purgeMcpDiscoveryCache } from "./app-discovery-cache";
import {
	backfillAggregateAppIdsProcedure,
	relinkConnectionProviderProcedure,
	renameAppSlugProcedure,
} from "./app-reference-maintenance";

/**
 * Create the contract implementer with base context
 * This enforces type safety between contract and implementation
 */
const appsOs = implement(appsContract).$context<BaseContext>();

/**
 * Create authenticated implementer - ALL procedures inherit auth
 * This ensures all apps endpoints require authentication
 */
const authedAppsOs = appsOs.use(withAuth);

/**
 * MCP-compatible implementer - accepts service token OR regular auth
 * Used for endpoints called by MCP for routing/lookup:
 * - getByDomain, getBySlugWithTools, getByIdWithTools
 */
const mcpAppsOs = appsOs.use(withAuth).use(AUTHZ.appsRead);

// =============================================================================
// CONTRACT-BASED PROCEDURE IMPLEMENTATIONS
// =============================================================================

/**
 * Contract-based list procedure implementation
 * Uses appsContract.list schema enforcement
 */
export const listApps = authedAppsOs.list
	.use(AUTHZ.appsRead)
	.handler(async ({ input, context }) => {
		const { db } = context;
		const { limit = 20, offset = 0, organizationId: targetOrgId } = input || {};

		// Platform-admin principals may pass `organizationId` to list any org's
		// apps (offboarding flows). Scoped callers fall through to their own org.
		const orgId =
			targetOrgId && isPlatformPrincipal(context)
				? targetOrgId
				: requireOrgId(context);

		const apps = await getAppsByOrganization(db, orgId);
		const total = apps.length;
		const pagedApps = apps.slice(offset, offset + limit);

		return {
			data: pagedApps.map(toAppListItem),
			pagination: {
				limit,
				offset,
				total,
				hasMore: offset + limit < total,
			},
		};
	});

/**
 * Contract-based get procedure implementation
 * Uses appsContract.get schema enforcement with appId parameter
 */
export const getApp = authedAppsOs.get
	.use(AUTHZ.appsRead)
	.handler(async ({ input, context }) => {
		const { db } = context;
		const { appId } = input;

		const orgId = requireOrgId(context);
		// Platform-admin principals (User JWT with platform-admin role, or API key
		// with platform:admin scope) can read apps in any org — keeps reads
		// consistent with updateAppProcedure/deleteAppProcedure, which already let
		// a platform principal write any org's app. Scoped callers fall through to
		// the same-org check.
		const app = isPlatformPrincipal(context)
			? ((await getAppById(db, appId)) ??
				(() => {
					throw createError(ErrorCodes.NOT_FOUND, "App not found");
				})())
			: await requireAppForOrg(db, orgId, appId);
		const metadata = normalizeAppMetadata(getAppMetadataJson(app));

		return toAppDto(app, { metadata });
	});

/**
 * Contract-based create procedure implementation
 * Uses appsContract.create schema enforcement (CreateAppInputSchema)
 */
export const createAppProcedure = authedAppsOs.create
	.use(AUTHZ.appsCreate)
	.handler(async ({ input, context }) => {
		const { db } = context;
		const orgId = requireOrgId(context);
		const {
			name,
			slug,
			description,
			primaryDomain,
			logoUrl,
			visibility,
			metadata,
		} = input;

		// Use provided domain or generate a placeholder
		const cleanDomain = primaryDomain ? getDomain(primaryDomain) : null;

		console.log(
			`[Create] Manually creating app: ${name}${cleanDomain ? ` (${cleanDomain})` : ""}`,
		);

		// Auto-generate slug with org prefix to prevent MCP subdomain collisions
		const org = await getOrganizationById(db, orgId);
		const appSlug = slug || generateAppSlug(name, org?.slug ?? undefined);
		// Tenant apps may not claim a platform-routing slug (home/kernel/tedix-unified)
		// — it would shadow the kernel/home aggregate surface. Platform provisioning
		// (provisionAppProcedure) is the only path allowed to create these.
		if (isReservedAppSlug(appSlug)) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				`Slug "${appSlug}" is reserved for platform routing`,
			);
		}
		const existingBySlug = await getAppBySlug(db, appSlug);
		if (existingBySlug) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				`App with slug "${appSlug}" already exists`,
			);
		}

		// Check if domain is already used (if provided)
		if (cleanDomain) {
			const existingByDomain = await getAppByDomain(db, cleanDomain);
			if (existingByDomain) {
				throw createError(
					ErrorCodes.BAD_REQUEST,
					`App with domain "${cleanDomain}" already exists`,
				);
			}
		}

		// Create new app
		const app = await createApp(db, {
			organizationId: orgId,
			name,
			slug: appSlug,
			primaryDomain: cleanDomain,
			description: description || null,
			logoUrl:
				logoUrl ||
				(cleanDomain ? `https://logo.clearbit.com/${cleanDomain}` : null),
			visibility: visibility || "private",
			discoveryStatus: cleanDomain ? "discovered" : "pending",
			metadata: metadata
				? normalizeAppMetadata(metadata)
				: {
						manuallyCreated: true,
						createdAt: new Date().toISOString(),
					},
		});

		if (!app) {
			throw createError(
				ErrorCodes.INTERNAL_SERVER_ERROR,
				"Failed to create app",
			);
		}

		console.log(`[Create] Created app: ${app.name} (${app.id})`);

		const appMetadata = getAppMetadataJson(app);

		return toAppDto(app, { metadata: appMetadata ?? null });
	});

/**
 * Pattern presets — soft hints for `provisionAppProcedure`. Caller-supplied
 * `mcpConfig` overrides win, so these are starting points, not contracts.
 */
const MCP_SCOPE_DESCRIPTIONS = {
	...MCP_GRANULAR_CAPABILITY_SCOPES,
} as Record<string, string>;

const PROVISION_PATTERN_DEFAULTS = {
	materialized: {
		authMode: "authenticated" as const,
		// Catalog/provider apps are materialized into app_tools rows. This pattern
		// creates the authenticated shell; catalog sync owns the tool rows.
		codeMode: false,
	},
	customer: {
		authMode: "authenticated" as const,
		codeMode: false,
		toolScopes: {} as Record<string, string[]>,
	},
	aggregator: {
		authMode: "authenticated" as const,
		codeMode: true,
		// Granular namespace defaults are a starting point; previewToolScopes
		// should replace them with exact per-tool mappings.
		toolScopes: {
			admin: ["platform:admin"],
			tedis: ["mcp:tedis.write"],
			apps: ["mcp:apps.write"],
			memory: ["mcp:memory.write"],
			skills: ["mcp:skills.write"],
			content: ["mcp:content.write"],
			catalog: ["mcp:catalog.write"],
			observe: ["mcp:observe.write"],
			messaging: ["mcp:messaging.write"],
		} as Record<string, string[]>,
		scopeDescriptions: MCP_SCOPE_DESCRIPTIONS,
	},
};

/**
 * mcpConfig keys that redirect authentication, token scoping, or the upstream
 * proxy target. A tenant must not set these on their own app — doing so could
 * forward query params/credentials, bind another tenant's project-global
 * connection provider or Descope resource, or point the MCP server at an
 * arbitrary upstream. They are computed/managed by the platform. (Audit #6/#7.)
 */
const TENANT_FORBIDDEN_MCP_KEYS = [
	"inactiveAggregateApps",
	"forwardedQueryParams",
	"connectionProviderId",
	"descopeResourceId",
	"upstreamMcpUrl",
] as const;

/**
 * Guard supplied `mcpConfig` on app create/update.
 *
 * For ALL principals (platform included) this rejects a same-zone
 * `upstreamMcpUrl`: pointing the upstream proxy at another `*.mcp.tedix.dev`
 * app loops the request back into the Worker serving it (hard invariant, see
 * CLAUDE.md "MCP Platform" — use D1 tools or `mcpConfig.connectionLabel`
 * instead). Platform principals are otherwise unrestricted. For tenant
 * callers this additionally:
 *   1. rejects the platform-managed keys above, and
 *   2. constrains `aggregateApps` sources to the caller's own org or the tedix
 *      platform org — mirroring `isPreviewSourceAllowed` in mcp-server.ts so a
 *      tenant cannot aggregate another tenant's app tools.
 *
 * Capability-scope gating (platform:admin excluded from the default profile) is the
 * second line of defense for the tedix-platform source; this check stops the
 * cross-tenant case at write time.
 */
export async function assertTenantMcpConfigAllowed(
	db: DbClient,
	context: BaseContext,
	callerOrgId: string,
	opts: {
		mcpConfig?: Record<string, unknown> | null;
		aggregateApps?: unknown;
	},
): Promise<void> {
	const mc = opts.mcpConfig;

	// UPSTREAM_SAME_ZONE — reject-write for every principal: this config is
	// provably broken at serve time, not a policy preference.
	const upstream = mc && typeof mc === "object" ? mc.upstreamMcpUrl : undefined;
	if (typeof upstream === "string" && upstream.length > 0) {
		let hostname: string | null = null;
		try {
			hostname = new URL(upstream).hostname.toLowerCase();
		} catch {
			hostname = null;
		}
		if (
			hostname &&
			(hostname === "mcp.tedix.dev" || hostname.endsWith(".mcp.tedix.dev"))
		) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				`mcpConfig.upstreamMcpUrl points at the same-zone MCP edge (${hostname}) — proxying another *.mcp.tedix.dev app through upstreamMcpUrl loops the request back into this Worker. Use D1 tools or mcpConfig.connectionLabel instead.`,
			);
		}
	}

	if (isPlatformPrincipal(context)) return;

	if (mc && typeof mc === "object") {
		const violated = TENANT_FORBIDDEN_MCP_KEYS.filter(
			(key) => mc[key] !== undefined,
		);
		if (violated.length > 0) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				`These mcpConfig fields are platform-managed and cannot be set by a tenant: ${violated.join(", ")}.`,
			);
		}
	}

	const aggregates =
		opts.aggregateApps ??
		(mc && typeof mc === "object" ? mc.aggregateApps : undefined);
	if (!Array.isArray(aggregates)) return;

	for (const entry of aggregates) {
		const record =
			entry && typeof entry === "object"
				? (entry as Record<string, unknown>)
				: undefined;
		const slug = record?.slug;
		const appId =
			typeof record?.appId === "string" && record.appId.length > 0
				? record.appId
				: undefined;
		if (!appId && (typeof slug !== "string" || slug.length === 0)) continue;

		// The read path resolves an entry by its stable `appId` when present, so
		// that is the link the ownership rule must check.
		const sourceApp = appId
			? await getAppById(db, appId)
			: await getAppBySlug(db, slug as string);
		if (!sourceApp) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				appId
					? `aggregateApps references unknown app id "${appId}".`
					: `aggregateApps references unknown app slug "${slug}".`,
			);
		}
		if (sourceApp.organizationId === callerOrgId) continue;

		const sourceOrg = await getOrganizationById(db, sourceApp.organizationId);
		// Tedix Cloud's own tenant key; an own-account installation never matches this branch.
		const isTedixPlatformOrg =
			sourceOrg?.slug === "tedix" || sourceOrg?.descopeTenantId === "org_tedix";
		if (!isTedixPlatformOrg) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				`aggregateApps cannot reference app "${appId ?? slug}" outside your organization.`,
			);
		}
	}
}

/**
 * Stamp each caller-supplied aggregate entry with the linked app's stable id
 * and current slug. Apps link by id; the slug is kept for display and for
 * entries written before ids were stored. An entry naming an unknown `appId`
 * is rejected; an unknown slug is left as given (the tenant guard rejects it).
 */
export async function linkAggregateAppEntries<T>(
	db: DbClient,
	entries: T[] | undefined,
): Promise<T[] | undefined> {
	if (!Array.isArray(entries) || entries.length === 0) return entries;
	const field = (entry: unknown, key: "appId" | "slug") => {
		const value =
			entry && typeof entry === "object"
				? (entry as Record<string, unknown>)[key]
				: undefined;
		return typeof value === "string" && value.length > 0 ? value : undefined;
	};
	const targets = await getAggregateAppLinkTargets(db, {
		ids: entries.flatMap((entry) => field(entry, "appId") ?? []),
		slugs: entries.flatMap((entry) =>
			field(entry, "appId") ? [] : (field(entry, "slug") ?? []),
		),
	});
	const byId = new Map(targets.map((target) => [target.id, target]));
	const bySlug = new Map(targets.map((target) => [target.slug, target]));
	return entries.map((entry) => {
		const appId = field(entry, "appId");
		const slug = field(entry, "slug");
		const target = appId
			? byId.get(appId)
			: slug
				? bySlug.get(slug)
				: undefined;
		if (appId && !target)
			throw createError(
				ErrorCodes.BAD_REQUEST,
				`aggregateApps references unknown app id "${appId}".`,
			);
		return target ? { ...entry, appId: target.id, slug: target.slug } : entry;
	});
}

/** {@link linkAggregateAppEntries} for both aggregate lists of a metadata patch. */
async function linkMetadataAggregateApps<T>(
	db: DbClient,
	metadata: T,
): Promise<T> {
	const mcpConfig = (metadata as { mcpConfig?: unknown } | null | undefined)
		?.mcpConfig;
	if (!mcpConfig || typeof mcpConfig !== "object") return metadata;
	const config = mcpConfig as {
		aggregateApps?: unknown[];
		inactiveAggregateApps?: unknown[];
	};
	if (
		!Array.isArray(config.aggregateApps) &&
		!Array.isArray(config.inactiveAggregateApps)
	)
		return metadata;
	return {
		...metadata,
		mcpConfig: {
			...config,
			...(Array.isArray(config.aggregateApps)
				? {
						aggregateApps: await linkAggregateAppEntries(
							db,
							config.aggregateApps,
						),
					}
				: {}),
			...(Array.isArray(config.inactiveAggregateApps)
				? {
						inactiveAggregateApps: await linkAggregateAppEntries(
							db,
							config.inactiveAggregateApps,
						),
					}
				: {}),
		},
	};
}

/**
 * Provision an app — D1 row plus optional Descope OAuth Resource registration.
 *
 * Patterns are soft hints; user-supplied `mcpConfig` overrides win. AIH
 * registration is intentionally opt-in so internal platform base apps do not
 * create externally connectable OAuth resources by default. For apps that need
 * their own Tedix-hosted OAuth-protected MCP endpoint, this remains the
 * one-shot replacement for the manual sequence:
 *   1. tedix__create_app
 *   2. POST /v1/mgmt/resource/create  (Descope console)
 *   3. tedix__update_app to backfill descopeResourceId
 */
export const provisionAppProcedure = authedAppsOs.provision
	.use(AUTHZ.appsCreate)
	.handler(async ({ input, context }) => {
		const { db, env } = context;
		const orgId = input.organizationId ?? requireOrgId(context);

		// Cross-org provisioning is gated on platform-principal status.
		// Same-org callers always pass; cross-org callers need either the
		// `platform-admin` user role or the `platform:admin` API key scope.
		if (
			input.organizationId &&
			input.organizationId !== context.organizationId &&
			!isPlatformPrincipal(context)
		) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Organization access denied (cross-org provisioning requires platform-admin authority)",
			);
		}

		const slug = input.slug.toLowerCase();
		const existing = await getAppBySlug(db, slug);
		if (existing) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				`App with slug "${slug}" already exists`,
			);
		}

		// Apps link by id: stamp every aggregate entry with its target's appId.
		const inputAggregateApps = await linkAggregateAppEntries(
			db,
			input.aggregateApps,
		);
		const { mcpConfig: inputMcpConfig } = await linkMetadataAggregateApps(db, {
			mcpConfig: input.mcpConfig,
		});

		// Tenant callers cannot set platform-managed mcpConfig keys or aggregate
		// apps outside their org / the tedix platform org. (Audit #6/#7.)
		await assertTenantMcpConfigAllowed(db, context, orgId, {
			mcpConfig: inputMcpConfig as Record<string, unknown> | undefined,
			aggregateApps: inputAggregateApps,
		});

		const pattern = input.pattern ?? "customer";
		const presets = PROVISION_PATTERN_DEFAULTS[pattern];
		const platformDomain =
			(env as { PLATFORM_DOMAIN?: string }).PLATFORM_DOMAIN ?? "tedix.dev";
		const mcpServerUrl = `https://${slug}.mcp.${platformDomain}/mcp`;

		// Hostname follows our standard MCP routing — see docs/engineering/mcp/runtime.md.
		// Custom domains can be set later via update_app.
		// Register Descope AIH MCP server only when explicitly requested, then
		// stamp its id into the D1 row's mcpConfig for first-read consistency.
		let descopeResourceId: string | null = null;
		if (input.registerDescopeAih === true) {
			try {
				const server = await registerDescopeMcpResource(
					{
						DESCOPE_PROJECT_ID: env.DESCOPE_PROJECT_ID,
						DESCOPE_MANAGEMENT_KEY: env.DESCOPE_MANAGEMENT_KEY,
					},
					{
						name: input.name,
						description: input.description ?? undefined,
						audienceWhitelist: [buildTedixMcpResourceUri(slug)],
						tags: reconcileTedixMcpOwnershipTags([], { app: slug }),
						// For the aggregator pattern, advertise capability scopes
						// so Descope policies and consent screens see them.
						approvedScopes:
							pattern === "aggregator"
								? {
										connectionsScopes: Object.entries(
											MCP_SCOPE_DESCRIPTIONS,
										).map(([name, description]) => ({
											name,
											description,
											optional: true,
										})),
									}
								: undefined,
					},
				);
				descopeResourceId = server.id;
			} catch (error) {
				console.warn(
					"[Apps] Failed to register Descope AIH MCP server (non-blocking, can backfill via update):",
					error,
				);
			}
		}

		// Compose final mcpConfig: pattern defaults < user overrides < computed
		// fields (descopeResourceId, expectedAudience, aggregateApps). Schema
		// defaults (authMode, capabilities, enforcePolicies) get filled in by
		// normalizeAppMetadata downstream.
		const mergedMcpConfig = {
			serverName: input.name,
			...presets,
			...inputMcpConfig,
			expectedAudience: mcpServerUrl,
			...(descopeResourceId ? { descopeResourceId } : {}),
			...(inputAggregateApps && inputAggregateApps.length > 0
				? { aggregateApps: inputAggregateApps }
				: inputMcpConfig?.aggregateApps
					? { aggregateApps: inputMcpConfig.aggregateApps }
					: {}),
		} as ContractAppMetadata["mcpConfig"];

		// Single-source tenant proxies inherit the aggregated base app's logo
		// (which itself came from the catalog), so the proxy AND any Descope
		// connection derived from it are branded instead of blank. Multi-app
		// aggregators keep their own brand logo (set via update_app), so we only
		// auto-inherit for the unambiguous single-aggregate proxy pattern.
		const soleAggregate =
			(inputAggregateApps?.length === 1 ? inputAggregateApps[0] : undefined) ??
			(inputMcpConfig?.aggregateApps?.length === 1
				? inputMcpConfig.aggregateApps[0]
				: undefined);
		const inheritedLogoUrl = soleAggregate?.slug
			? ((await getAppBySlug(db, soleAggregate.slug.toLowerCase()))?.logoUrl ??
				null)
			: null;

		const app = await createApp(db, {
			organizationId: orgId,
			name: input.name,
			slug,
			primaryDomain: null,
			description: input.description ?? null,
			logoUrl: inheritedLogoUrl,
			visibility: "private",
			discoveryStatus: "pending",
			metadata: {
				mcpConfig: mergedMcpConfig as unknown as AppMetadata["mcpConfig"],
			},
		});

		if (!app) {
			throw createError(
				ErrorCodes.INTERNAL_SERVER_ERROR,
				"Failed to create app",
			);
		}

		// Audit cross-org provisioning — platform-admin operation, recorded
		// against the TARGET org (where the app landed), not the caller.
		if (orgId !== context.organizationId) {
			const { emitAuditEvent, auditActor } = await import("../audit-helpers");
			const actor = auditActor(context);
			await emitAuditEvent(db, {
				organizationId: orgId,
				actorId: actor.actorId,
				actorType: actor.actorType,
				action: "app.provisioned_cross_org",
				resourceType: "app",
				resourceId: app.id,
				metadata: {
					...actor.actorMetadata,
					slug,
					pattern,
					descopeResourceId,
					callerOrgId: context.organizationId,
				},
				ipAddress: context.headers.get("CF-Connecting-IP"),
				userAgent: context.headers.get("User-Agent"),
			});
		}

		const appMetadata = getAppMetadataJson(app);
		return {
			app: toAppDto(app, { metadata: appMetadata ?? null }),
			descopeResourceId,
		};
	});

/** Resolve the same tenant gateway used by the organization directory. */
async function gatewayMembershipContext(
	db: DbClient,
	orgId: string,
	appId: string,
) {
	const [records, gateways] = await Promise.all([
		getAppsByOrganization(db, orgId),
		getOrganizationAggregatorGateways(db, [orgId]),
	]);
	const app = records.find((record) => record.id === appId);
	if (!app)
		throw createError(
			ErrorCodes.NOT_FOUND,
			"App not found in this organization",
		);
	const gateway = records.find(
		(record) => record.slug === gateways.get(orgId)?.slug,
	);
	// Reject a tenant graph that already reaches the gateway. Catalog base apps
	// live outside this tenant; their installation is an existing trust boundary.
	const visited = new Set<string>();
	const reachesGateway = (slug: string): boolean => {
		if (slug === gateway?.slug) return true;
		if (visited.has(slug)) return false;
		visited.add(slug);
		const members = records.find((record) => record.slug === slug)?.metadata
			?.mcpConfig?.aggregateApps;
		return (
			Array.isArray(members) &&
			members.some(
				(entry) =>
					typeof entry?.slug === "string" && reachesGateway(entry.slug),
			)
		);
	};
	const createsCycle = gateway && reachesGateway(app.slug);
	const unavailableReason = !gateway
		? "This organization has no unified gateway yet."
		: app.id === gateway.id
			? "This app is the unified gateway. Manage availability from an installed app."
			: createsCycle
				? "This app already references the gateway. Remove that reference first."
				: !app.catalogAppId || !app.sourceAppId
					? "Gateway availability is managed here for installed catalog apps."
					: app.visibility === "disabled"
						? "Enable this app before adding it to the gateway."
						: null;
	const members = gateway?.metadata?.mcpConfig?.aggregateApps;
	const enabled =
		Array.isArray(members) &&
		members.some((entry) =>
			aggregateAppEntryMatches(entry, { appId: app.id, slug: app.slug }),
		);
	return { app, gateway, enabled, unavailableReason };
}

export const getGatewayMembership = authedAppsOs.getGatewayMembership
	.use(AUTHZ.appsRead)
	.handler(async ({ input, context }) => {
		const state = await gatewayMembershipContext(
			context.db,
			requireOrgId(context),
			input.appId,
		);
		return {
			gateway: state.gateway
				? {
						id: state.gateway.id,
						name: state.gateway.name,
						slug: state.gateway.slug,
					}
				: null,
			enabled: state.enabled,
			unavailableReason: state.unavailableReason,
		};
	});

export const listGatewayMemberships = authedAppsOs.listGatewayMemberships
	.use(AUTHZ.appsRead)
	.handler(async ({ context }: { context: BaseContext }) => {
		const orgId = requireOrgId(context);
		const [records, gateways] = await Promise.all([
			getAppsByOrganization(context.db, orgId),
			getOrganizationAggregatorGateways(context.db, [orgId]),
		]);
		const gateway = records.find(
			(record) => record.slug === gateways.get(orgId)?.slug,
		);
		const gatewayMembers = gateway?.metadata?.mcpConfig?.aggregateApps;
		const members: unknown[] = Array.isArray(gatewayMembers)
			? gatewayMembers
			: [];
		return {
			gateway: gateway
				? { id: gateway.id, name: gateway.name, slug: gateway.slug }
				: null,
			memberships: records.map((record) => ({
				appId: record.id,
				enabled: members.some((entry) =>
					aggregateAppEntryMatches(entry, {
						appId: record.id,
						slug: record.slug,
					}),
				),
			})),
		};
	});

export const setGatewayMembership = authedAppsOs.setGatewayMembership
	.use(AUTHZ.appsWrite)
	.handler(
		async ({
			input,
			context,
		}: {
			input: { appId: string; enabled: boolean };
			context: BaseContext;
		}) => {
			const orgId = requireOrgId(context);
			const state = await gatewayMembershipContext(
				context.db,
				orgId,
				input.appId,
			);
			if (
				!state.gateway ||
				(input.enabled && state.unavailableReason) ||
				state.app.id === state.gateway.id
			)
				throw createError(
					ErrorCodes.BAD_REQUEST,
					state.unavailableReason ?? "Gateway is unavailable",
				);
			const changed = await setAppGatewayMembership(
				context.db,
				orgId,
				state.gateway.id,
				{ appId: state.app.id, slug: state.app.slug },
				input.enabled,
			);
			if (!changed.length)
				throw createError(
					ErrorCodes.CONFLICT,
					"Gateway changed. Refresh and try again.",
				);
			await purgeMcpDiscoveryCache(context.env, state.gateway.id, [
				state.gateway,
			]);
			return { success: true };
		},
	);

/**
 * Contract-based update procedure implementation
 * Uses appsContract.update schema enforcement with appId parameter
 */
export const updateAppProcedure = authedAppsOs.update
	.use(AUTHZ.appsWrite)
	.handler(async ({ input, context }) => {
		const { db } = context;
		const {
			appId,
			openaiChallengeToken,
			name,
			slug,
			description,
			primaryDomain,
			logoUrl,
			visibility,
			metadata,
		} = input;

		const orgId = requireOrgId(context);
		// Platform-admin principals (User JWT with platform-admin role, or API key
		// with platform:admin scope) can update apps in any org — needed to
		// configure a customer's aggregator (e.g. provision a tenant's skills
		// surface) during onboarding. Scoped callers fall through to the same-org
		// check. Mirrors deleteAppProcedure. The tenant mcpConfig guard below is
		// already skipped for platform principals.
		const existingApp = isPlatformPrincipal(context)
			? ((await getAppById(db, appId)) ??
				(() => {
					throw createError(ErrorCodes.NOT_FOUND, "App not found");
				})())
			: await requireAppForOrg(db, orgId, appId);

		// Build update payload with only provided fields
		const updatePayload: Partial<{
			openaiChallengeToken: string | null;
			name: string;
			slug: string;
			description: string | null;
			primaryDomain: string | null;
			logoUrl: string | null;
			visibility: "public" | "private" | "disabled";
			metadata: AppMetadata;
		}> = {};

		if (openaiChallengeToken !== undefined) {
			updatePayload.openaiChallengeToken = openaiChallengeToken;
		}
		if (name !== undefined) updatePayload.name = name;
		if (slug !== undefined) {
			// Check if new slug is available
			if (slug !== existingApp.slug) {
				const existingBySlug = await getAppBySlug(db, slug);
				if (existingBySlug) {
					throw createError(
						ErrorCodes.BAD_REQUEST,
						`App with slug "${slug}" already exists`,
					);
				}
			}
			updatePayload.slug = slug;
		}
		if (description !== undefined) updatePayload.description = description;
		if (primaryDomain !== undefined) {
			updatePayload.primaryDomain = primaryDomain
				? getDomain(primaryDomain)
				: null;
		}
		if (logoUrl !== undefined) updatePayload.logoUrl = logoUrl;
		if (visibility !== undefined) updatePayload.visibility = visibility;
		let mcpConfigChanged = false;
		if (metadata !== undefined) {
			// Deep-merge metadata so partial updates (e.g. { mcpConfig: { codeMode: true } })
			// don't wipe existing fields. Top-level keys are shallow-merged; mcpConfig and blogConfig are deep-merged.
			//
			// `connectionProviderId: null` is the one supported removal sentinel;
			// mergeAppMetadataPatch consumes it and clears the complete binding.
			// Other keys keep ordinary merge semantics and never infer deletion.
			const existing = getAppMetadataJson(existingApp) ?? {};
			// Apps link by id: stamp every aggregate entry with its target's appId.
			const linkedMetadata = await linkMetadataAggregateApps(db, metadata);
			const incoming = normalizeAppMetadata(linkedMetadata);
			mcpConfigChanged = incoming.mcpConfig !== undefined;
			// Tenant callers cannot set platform-managed mcpConfig keys or aggregate
			// apps outside their org / the tedix platform org. (Audit #6/#7.)
			await assertTenantMcpConfigAllowed(db, context, orgId, {
				mcpConfig: incoming.mcpConfig as Record<string, unknown> | undefined,
			});
			const mergedMetadata = mergeAppMetadataPatch(existing, linkedMetadata);
			warnGuidanceSkillAppsMismatch(
				mergedMetadata,
				`${existingApp.slug} (${existingApp.id})`,
			);
			updatePayload.metadata = mergedMetadata;
		}

		const updatedApp = await updateApp(db, appId, updatePayload);

		if (!updatedApp) {
			throw createError(
				ErrorCodes.INTERNAL_SERVER_ERROR,
				"Failed to update app",
			);
		}

		console.log(`[Update] Updated app: ${updatedApp.name} (${appId})`);

		if (mcpConfigChanged) {
			await purgeMcpDiscoveryCache(context.env, appId, [
				existingApp,
				updatedApp,
			]);
		}

		const appMetadata = getAppMetadataJson(updatedApp);

		return toAppDto(updatedApp, { metadata: appMetadata ?? null });
	});

// UUID pattern used to distinguish ID from slug
const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve an app by UUID or slug, scoped to the caller's org.
 * Throws NOT_FOUND or FORBIDDEN if the app cannot be accessed.
 */
async function requireAppByIdOrSlug(
	db: DbClient,
	orgId: string,
	appIdOrSlug: string,
) {
	const app = UUID_RE.test(appIdOrSlug)
		? await getAppById(db, appIdOrSlug)
		: await getAppBySlug(db, appIdOrSlug);

	if (!app) {
		throw createError(ErrorCodes.NOT_FOUND, "App not found");
	}
	if (!app.organizationId || app.organizationId !== orgId) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"You do not have access to this app",
		);
	}
	return app;
}

/**
 * Get app by ID or slug — MCP/Code Mode friendly variant of getApp.
 * Accepts a UUID or a human-readable slug so tedis can call get_app without
 * the ToolHandler security override corrupting the lookup.
 */
export const getByIdOrSlugProcedure = authedAppsOs.getByIdOrSlug
	.use(AUTHZ.appsRead)
	.handler(async ({ input, context }) => {
		const { db } = context;
		const { appIdOrSlug } = input;
		const orgId = requireOrgId(context);

		const app = await requireAppByIdOrSlug(db, orgId, appIdOrSlug);
		const metadata = normalizeAppMetadata(getAppMetadataJson(app));

		return toAppDto(app, { metadata });
	});

/**
 * Update app by ID or slug — MCP/Code Mode friendly variant of updateAppProcedure.
 * Resolves the app by UUID or slug first, then applies the same update logic.
 */
export const updateByIdOrSlugProcedure = authedAppsOs.updateByIdOrSlug
	.use(AUTHZ.appsWrite)
	.handler(async ({ input, context }) => {
		const { db } = context;
		const {
			appIdOrSlug,
			openaiChallengeToken,
			name,
			slug,
			description,
			primaryDomain,
			logoUrl,
			visibility,
			metadata,
		} = input;

		const orgId = requireOrgId(context);
		const existingApp = await requireAppByIdOrSlug(db, orgId, appIdOrSlug);
		const appId = existingApp.id;

		const updatePayload: Partial<{
			openaiChallengeToken: string | null;
			name: string;
			slug: string;
			description: string | null;
			primaryDomain: string | null;
			logoUrl: string | null;
			visibility: "public" | "private" | "disabled";
			metadata: AppMetadata;
		}> = {};

		if (openaiChallengeToken !== undefined) {
			updatePayload.openaiChallengeToken = openaiChallengeToken;
		}
		if (name !== undefined) updatePayload.name = name;
		if (slug !== undefined) {
			if (slug !== existingApp.slug) {
				const existingBySlug = await getAppBySlug(db, slug);
				if (existingBySlug) {
					throw createError(
						ErrorCodes.BAD_REQUEST,
						`App with slug "${slug}" already exists`,
					);
				}
			}
			updatePayload.slug = slug;
		}
		if (description !== undefined) updatePayload.description = description;
		if (primaryDomain !== undefined) {
			updatePayload.primaryDomain = primaryDomain
				? getDomain(primaryDomain)
				: null;
		}
		if (logoUrl !== undefined) updatePayload.logoUrl = logoUrl;
		if (visibility !== undefined) updatePayload.visibility = visibility;
		let mcpConfigChanged = false;
		if (metadata !== undefined) {
			const existing = getAppMetadataJson(existingApp) ?? {};
			// Apps link by id: stamp every aggregate entry with its target's appId.
			const linkedMetadata = await linkMetadataAggregateApps(db, metadata);
			const incoming = normalizeAppMetadata(linkedMetadata);
			mcpConfigChanged = incoming.mcpConfig !== undefined;
			// Tenant callers cannot set platform-managed mcpConfig keys or aggregate
			// apps outside their org / the tedix platform org. (Audit #6/#7.)
			await assertTenantMcpConfigAllowed(db, context, orgId, {
				mcpConfig: incoming.mcpConfig as Record<string, unknown> | undefined,
			});
			const mergedMetadata = mergeAppMetadataPatch(existing, linkedMetadata);
			warnGuidanceSkillAppsMismatch(
				mergedMetadata,
				`${existingApp.slug} (${existingApp.id})`,
			);
			updatePayload.metadata = mergedMetadata;
		}

		const updatedApp = await updateApp(db, appId, updatePayload);

		if (!updatedApp) {
			throw createError(
				ErrorCodes.INTERNAL_SERVER_ERROR,
				"Failed to update app",
			);
		}

		console.log(`[Update] Updated app: ${updatedApp.name} (${appId})`);

		if (mcpConfigChanged) {
			await purgeMcpDiscoveryCache(context.env, appId, [
				existingApp,
				updatedApp,
			]);
		}

		const appMetadata = getAppMetadataJson(updatedApp);

		return toAppDto(updatedApp, { metadata: appMetadata ?? null });
	});

/**
 * Contract-based delete procedure implementation
 * Uses appsContract.delete schema enforcement with appId parameter
 */
export const deleteAppProcedure = authedAppsOs.delete
	.use(withAuthorization("apps:delete", "apps:delete"))
	.handler(async ({ input, context }) => {
		const { db } = context;
		const { appId } = input;

		// Deleting an app cascades its tools, assignments and AIH MCP server.
		// The OS asks for its exact name; authorization and tenant ownership
		// remain enforced here for every caller.
		// Platform-admin principals (User JWT with platform-admin role, or API key
		// with platform:admin scope) can delete apps in any org. Scoped callers
		// fall through to the same-org check.
		const app = isPlatformPrincipal(context)
			? ((await getAppById(db, appId)) ??
				(() => {
					throw createError(ErrorCodes.NOT_FOUND, "App not found");
				})())
			: await requireAppForOrg(db, requireOrgId(context), appId);
		// Cascade-delete the AIH MCP server (if registered) so we don't leak
		// Descope resources on offboarding. Non-blocking — D1 deletion proceeds
		// regardless. Backfill via admin if needed.
		const descopeResourceId =
			(
				getAppMetadataJson(app) as {
					mcpConfig?: { descopeResourceId?: string };
				} | null
			)?.mcpConfig?.descopeResourceId ?? null;
		if (descopeResourceId) {
			try {
				await deleteDescopeMcpServer(
					{
						DESCOPE_PROJECT_ID: context.env.DESCOPE_PROJECT_ID,
						DESCOPE_MANAGEMENT_KEY: context.env.DESCOPE_MANAGEMENT_KEY,
					},
					descopeResourceId,
				);
			} catch (error) {
				console.warn(
					`[Delete] Failed to delete Descope AIH MCP server ${descopeResourceId} (non-blocking):`,
					error,
				);
			}
		}

		const deleted = await deleteApp(db, appId);
		if (!deleted) {
			throw createError(
				ErrorCodes.INTERNAL_SERVER_ERROR,
				"Failed to delete app",
			);
		}

		console.log(`[Delete] Removed app: ${app.name} (${appId})`);

		// Audit cross-org app deletion — platform-admin operation against the
		// TARGET org. Same-org deletes are routine and skip audit (already
		// covered by request logs).
		if (app.organizationId && app.organizationId !== context.organizationId) {
			const { emitAuditEvent, auditActor } = await import("../audit-helpers");
			const actor = auditActor(context);
			await emitAuditEvent(db, {
				organizationId: app.organizationId,
				actorId: actor.actorId,
				actorType: actor.actorType,
				action: "app.deleted_cross_org",
				resourceType: "app",
				resourceId: appId,
				metadata: {
					...actor.actorMetadata,
					slug: app.slug,
					name: app.name,
					descopeResourceId,
					callerOrgId: context.organizationId,
				},
				ipAddress: context.headers.get("CF-Connecting-IP"),
				userAgent: context.headers.get("User-Agent"),
			});
		}

		return {
			success: true as const,
			message: `App "${app.name}" deleted successfully`,
		};
	});

/**
 * Contract-based getBySlug procedure implementation
 * Uses appsContract.getBySlug schema enforcement with slug parameter
 */
export const getAppBySlugProcedure = authedAppsOs.getBySlug
	.use(AUTHZ.appsRead)
	.handler(async ({ input, context }) => {
		const { db } = context;
		const { slug } = input;

		const app = await getAppBySlug(db, slug);

		if (!app) {
			throw createError(ErrorCodes.NOT_FOUND, "App not found");
		}

		// Platform-admin principals can read apps in any org (offboarding scripts).
		// Scoped callers must match the app's org.
		if (!isPlatformPrincipal(context)) {
			const orgId = requireOrgId(context);
			if (!app.organizationId || app.organizationId !== orgId) {
				throw createError(
					ErrorCodes.FORBIDDEN,
					"You do not have access to this app",
				);
			}
		}

		const metadata = normalizeAppMetadata(getAppMetadataJson(app));

		return {
			id: app.id,
			organizationId: app.organizationId,
			name: app.name,
			slug: app.slug,
			description: app.description,
			primaryDomain: app.primaryDomain,
			logoUrl: app.logoUrl,
			visibility: app.visibility,
			discoveryStatus: app.discoveryStatus,
			customMcpDomain: app.customMcpDomain,
			openaiChallengeToken: app.openaiChallengeToken,
			openaiAppId: app.openaiAppId,
			appStoreStatus: app.appStoreStatus,
			metadata: metadata ?? null,
			extractedAt: app.extractedAt,
			aiSearchSyncedAt: app.aiSearchSyncedAt,
			createdAt: app.createdAt,
			activeConfigVersionId: app.activeConfigVersionId ?? null,
			latestConfigVersion: app.latestConfigVersion ?? null,
			updatedAt: app.updatedAt,
		};
	});

/**
 * Contract-based isSlugAvailable procedure implementation
 * Checks if a slug is available for use
 */
export const isSlugAvailableProcedure = authedAppsOs.isSlugAvailable
	.use(AUTHZ.appsRead)
	.handler(async ({ input, context }) => {
		const { db } = context;
		const { slug } = input;

		const existingApp = await getAppBySlug(db, slug);

		return {
			available: !existingApp,
		};
	});

// =============================================================================
// MCP-SPECIFIC ENDPOINTS
// =============================================================================

/**
 * Get app by domain (for MCP server domain routing)
 * Used to lookup apps by customMcpDomain or primaryDomain
 */
export const getByDomainProcedure = mcpAppsOs.getByDomain.handler(
	async ({ input, context }) => {
		const { db } = context;
		const { domain } = input;

		const app = await getAppByDomain(db, domain);

		if (!app) {
			return { app: null };
		}

		return {
			app: {
				id: app.id,
				organizationId: app.organizationId,
				name: app.name,
				visibility: app.visibility ?? "private",
				slug: app.slug,
				domain: app.primaryDomain,
			},
		};
	},
);

/**
 * Get app with tools by slug (for MCP server tool loading)
 */
export const getBySlugWithToolsProcedure = mcpAppsOs.getBySlugWithTools.handler(
	async ({ input, context }) => {
		const { db } = context;
		const { slug, endpointPrefixes, toolIds } = input;

		const result = await getAppBySlugWithTools(db, slug, {
			endpointPrefixes,
			toolIds,
		});

		if (!result) {
			return { app: null, tools: [] };
		}

		const {
			app,
			tools,
			catalogMcp,
			catalogResources,
			catalogResourceTemplates,
			catalogPrompts,
		} = result;
		const metadata = normalizeAppMetadata(getAppMetadataJson(app));

		return {
			app: toAppDto(app, { metadata: metadata ?? null }),
			tools: tools.map(toAppToolDto),
			catalogMcp,
			catalogResources: catalogResources.map(toCatalogMcpSurfaceDto),
			catalogResourceTemplates: catalogResourceTemplates.map(
				toCatalogMcpSurfaceDto,
			),
			catalogPrompts: catalogPrompts.map(toCatalogMcpSurfaceDto),
		};
	},
);

/**
 * Batched `getBySlugWithTools` (for the MCP aggregate rebuild).
 *
 * Fanning out one `getBySlugWithTools` per aggregate app makes most entries
 * miss the gateway's per-entry deadline and degrades the surface, because each
 * invocation pays seconds of CPU evaluating the `worker-app` graph in a fresh
 * isolate. One batched call avoids that.
 *
 * Two-plane authz by construction (`lint:authz --strict` is shrink-only, so a new
 * single-plane procedure is a hard fail). Neither plane can break the caller
 * that motivated this endpoint: `` waves through service-binding
 * principals, and `hasRequiredScope()` short-circuits true for them too.
 */
export const getBySlugsWithToolsProcedure =
	mcpAppsOs.getBySlugsWithTools.handler(async ({ input, context }) => {
		const { db } = context;

		const surfaces = await getAppsBySlugsWithTools(db, input.apps);

		// Positionally parallel to input.apps — an absent index is impossible, so a
		// caller can always tell "no tools" from "not resolved".
		return {
			results: surfaces.map((result, index) => {
				const slug = input.apps[index]?.slug ?? "";
				if (!result) return { slug, app: null, tools: [] };
				const {
					app,
					tools,
					catalogMcp,
					catalogResources,
					catalogResourceTemplates,
					catalogPrompts,
				} = result;
				const metadata = normalizeAppMetadata(getAppMetadataJson(app));
				return {
					slug,
					app: toAppDto(app, { metadata: metadata ?? null }),
					tools: tools.map(toAppToolDto),
					catalogMcp,
					catalogResources: catalogResources.map(toCatalogMcpSurfaceDto),
					catalogResourceTemplates: catalogResourceTemplates.map(
						toCatalogMcpSurfaceDto,
					),
					catalogPrompts: catalogPrompts.map(toCatalogMcpSurfaceDto),
				};
			}),
		};
	});

/**
 * Get app with tools by ID (for MCP server tool loading)
 */
export const getByIdWithToolsProcedure = mcpAppsOs.getByIdWithTools.handler(
	async ({ input, context }) => {
		const { db } = context;
		const { appId } = input;
		const orgId = requireOrgId(context);

		const result = await getAppByIdWithToolsForOrganization(db, appId, orgId);

		if (!result) {
			return { app: null, tools: [] };
		}

		const {
			app,
			tools,
			catalogMcp,
			catalogResources,
			catalogResourceTemplates,
			catalogPrompts,
		} = result;
		const metadata = normalizeAppMetadata(getAppMetadataJson(app));

		return {
			app: toAppDto(app, { metadata: metadata ?? null }),
			tools: tools.map(toAppToolDto),
			catalogMcp,
			catalogResources: catalogResources.map(toCatalogMcpSurfaceDto),
			catalogResourceTemplates: catalogResourceTemplates.map(
				toCatalogMcpSurfaceDto,
			),
			catalogPrompts: catalogPrompts.map(toCatalogMcpSurfaceDto),
		};
	},
);

/**
 * Refresh app branding by scraping homepage
 */
export const refreshBrandingProcedure = authedAppsOs.refreshBranding
	.use(AUTHZ.appsWrite)
	.handler(async ({ input, context }) => {
		const { db } = context;
		const { appId, url } = input;

		const orgId = requireOrgId(context);
		const app = await requireAppForOrg(db, orgId, appId);

		const target = url || app.primaryDomain;
		if (!target) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"App has no primary domain and no URL was provided",
			);
		}

		const scrape = await scrapeBrandingFromUrl(
			{ url: target },
			context.env.BROWSER,
		);

		if (!scrape.success) {
			throw createError(
				ErrorCodes.INTERNAL_SERVER_ERROR,
				scrape.error || "Failed to refresh branding",
			);
		}

		const brandingExtractedAt = new Date().toISOString();
		const existingMetadata = getAppMetadataJson(app) || {};
		const updatedMetadata = {
			...existingMetadata,
			branding: scrape.branding,
			brandingExtractedAt,
		};

		const updatedApp = await updateApp(db, appId, {
			metadata: updatedMetadata,
			logoUrl:
				scrape.branding?.logo || scrape.branding?.images?.logo || app.logoUrl,
		});

		if (!updatedApp) {
			throw createError(
				ErrorCodes.INTERNAL_SERVER_ERROR,
				"Failed to update app branding",
			);
		}

		const appMetadata = getAppMetadataJson(updatedApp);

		return {
			success: true as const,
			app: toAppDto(updatedApp, { metadata: appMetadata ?? null }),
			branding: appMetadata?.branding ?? null,
			brandingExtractedAt: appMetadata?.brandingExtractedAt ?? null,
		};
	});

/**
 * Get app integrations (aggregate endpoint for Tedix OS)
 * Reduces round-trips by fetching tools, adapters, CSP domains, secrets, and capabilities
 */
export const getIntegrationsProcedure = authedAppsOs.getIntegrations
	.use(AUTHZ.appsRead)
	.handler(async ({ input, context }) => {
		const { db } = context;
		const { appId } = input;

		const orgId = requireOrgId(context);
		const app = await requireAppForOrg(db, orgId, appId);

		// Fetch all integration data in parallel
		const [tools, adapters, secrets] = await Promise.all([
			getToolsByAppId(db, appId),
			getAdaptersByAppId(db, appId),
			listAppSecrets(db, appId),
		]);

		// Extract capabilities from app metadata
		const metadata = normalizeAppMetadata(getAppMetadataJson(app));
		const capabilities = metadata?.capabilities ?? null;

		return {
			tools: tools.map((tool: (typeof tools)[number]) => ({
				id: tool.id,
				toolId: tool.toolId,
				title: tool.title,
				description: tool.description,
				enabled: tool.enabled ?? false,
				widgetKey: tool.widgetKey,
				sortOrder: tool.sortOrder ?? 0,
			})),
			adapters: adapters.map((adapter) => ({
				id: adapter.id,
				name: adapter.name,
				adapterType: adapter.adapterType,
				enabled: adapter.enabled ?? false,
				priority: adapter.priority ?? 0,
			})),
			secrets: secrets.map((secret) => ({
				id: secret.id,
				name: secret.name,
				hint: secret.hint,
				createdAt: secret.createdAt,
			})),
			capabilities,
		};
	});

/**
 * Generate scope manifest for an app's MCP server
 * Used by operators to configure Descope policies in the console
 */
export const getScopeManifestProcedure = authedAppsOs.getScopeManifest
	.use(AUTHZ.appsRead)
	.handler(async ({ input, context }) => {
		const { db } = context;
		const { appId } = input;

		const orgId = requireOrgId(context);
		const app = await requireAppForOrg(db, orgId, appId);

		// Fetch tools for this app
		const tools = await getToolsByAppId(db, appId);

		const metadata = normalizeAppMetadata(getAppMetadataJson(app));
		const mcpConfig = (metadata as ContractAppMetadata | null)?.mcpConfig;

		const descopeResourceId = mcpConfig?.descopeResourceId ?? "";
		const serverUrl = `https://${app.slug}.mcp.tedix.dev`;

		const manifest = generateScopeManifest({
			serverUrl,
			descopeResourceId,
			// The full auth shape, not just the name: the resolver promotes
			// destructive/private/auth-required tools above their namespace
			// fallback, so dropping these fields would under-report the scopes the
			// edge actually demands. Disabled rows are still listed — they report
			// the scope they WOULD require once enabled.
			tools: tools.map((t) => ({
				name: t.toolId,
				description: t.description ?? undefined,
				toolTypeId: t.toolTypeId,
				config: t.config,
				annotations: t.annotations as never,
				writeCapability: t.writeCapability as never,
				authRequired: t.authRequired ?? undefined,
				visibility: t.visibility ?? undefined,
			})),
			mcpConfig: mcpConfig as Record<string, unknown> | undefined,
			scopeDescriptions: mcpConfig?.scopeDescriptions ?? undefined,
		});

		return manifest;
	});

// =============================================================================
// CONFIG VERSION PROCEDURES
// =============================================================================

export const listConfigVersionsProcedure = authedAppsOs.listConfigVersions
	.use(AUTHZ.appsRead)
	.handler(async ({ input, context }) => {
		const { db } = context;
		const { appId } = input;
		const orgId = requireOrgId(context);
		await requireAppForOrg(db, orgId, appId);
		return listAppConfigVersions(db, appId);
	});

export const createConfigVersionProcedure = authedAppsOs.createConfigVersion
	.use(AUTHZ.appsWrite)
	.handler(async ({ input, context }) => {
		const { db } = context;
		const orgId = requireOrgId(context);
		await requireAppForOrg(db, orgId, input.appId);
		return createAppConfigVersion(db, input);
	});

export const publishConfigVersionProcedure = authedAppsOs.publishConfigVersion
	.use(AUTHZ.appsWrite)
	.handler(async ({ input, context }) => {
		const { db } = context;
		const orgId = requireOrgId(context);
		await requireAppForOrg(db, orgId, input.appId);
		return publishAppConfigVersion(db, input);
	});

export const activateConfigVersionProcedure = authedAppsOs.activateConfigVersion
	.use(AUTHZ.appsWrite)
	.handler(async ({ input, context }) => {
		const { db } = context;
		const orgId = requireOrgId(context);
		await requireAppForOrg(db, orgId, input.appId);
		return activateAppConfigVersion(db, input);
	});

/**
 * Contract-based router using os.router() pattern
 * This enforces that all procedures match the contract
 */
export const appsContractRouter = appsOs.router({
	list: skipOutputValidation(listApps),
	get: skipOutputValidation(getApp),
	getBySlug: skipOutputValidation(getAppBySlugProcedure),
	create: createAppProcedure,
	provision: provisionAppProcedure,
	getGatewayMembership,
	listGatewayMemberships,
	setGatewayMembership,
	update: updateAppProcedure,
	delete: deleteAppProcedure,
	isSlugAvailable: skipOutputValidation(isSlugAvailableProcedure),
	refreshBranding: refreshBrandingProcedure,
	getIntegrations: skipOutputValidation(getIntegrationsProcedure),
	getScopeManifest: skipOutputValidation(getScopeManifestProcedure),
	// Config versioning
	listConfigVersions: skipOutputValidation(listConfigVersionsProcedure),
	createConfigVersion: createConfigVersionProcedure,
	publishConfigVersion: publishConfigVersionProcedure,
	activateConfigVersion: activateConfigVersionProcedure,
	// MCP-specific endpoints
	getByDomain: skipOutputValidation(getByDomainProcedure),
	getBySlugWithTools: skipOutputValidation(getBySlugWithToolsProcedure),
	getBySlugsWithTools: skipOutputValidation(getBySlugsWithToolsProcedure),
	getByIdWithTools: skipOutputValidation(getByIdWithToolsProcedure),
	// MCP/Code Mode friendly endpoints (accept UUID or slug)
	getByIdOrSlug: skipOutputValidation(getByIdOrSlugProcedure),
	updateByIdOrSlug: updateByIdOrSlugProcedure,
	// Platform-admin cross-organization reference repair (dry run by default)
	backfillAggregateAppIds: backfillAggregateAppIdsProcedure,
	renameSlug: renameAppSlugProcedure,
	relinkConnectionProvider: relinkConnectionProviderProcedure,
});

// =============================================================================
// HELPERS
// =============================================================================

function normalizeNullableBoolean(value: unknown): boolean | null {
	if (value == null) return null;
	if (typeof value === "boolean") return value;
	if (typeof value === "number") return value !== 0;
	return null;
}

type AppRecord = NonNullable<Awaited<ReturnType<typeof getAppById>>>;
type AppWithToolsResult = NonNullable<
	Awaited<ReturnType<typeof getAppByIdWithToolsForOrganization>>
>;
type AppToolRecord = AppWithToolsResult["tools"][number];

function toAppListItem(app: AppRecord) {
	return {
		id: app.id,
		name: app.name,
		slug: app.slug,
		domain: app.primaryDomain,
		description: app.description,
		logoUrl: app.logoUrl,
		visibility: app.visibility ?? "private",
		discoveryStatus: app.discoveryStatus,
		customMcpDomain: app.customMcpDomain,
		appStoreStatus: app.appStoreStatus,
		createdAt: app.createdAt,
		updatedAt: app.updatedAt,
	};
}

function toAppDto(
	app: AppRecord,
	options?: {
		metadata?: ContractAppMetadata | AppMetadata | null;
	},
) {
	return {
		id: app.id,
		organizationId: app.organizationId,
		name: app.name,
		slug: app.slug,
		description: app.description,
		primaryDomain: app.primaryDomain,
		logoUrl: app.logoUrl,
		visibility: app.visibility ?? "private",
		discoveryStatus: app.discoveryStatus,
		customMcpDomain: app.customMcpDomain,
		openaiChallengeToken: app.openaiChallengeToken,
		openaiAppId: app.openaiAppId,
		appStoreStatus: app.appStoreStatus,
		metadata: options?.metadata ?? null,
		extractedAt: app.extractedAt,
		aiSearchSyncedAt: app.aiSearchSyncedAt,
		createdAt: app.createdAt,
		activeConfigVersionId: app.activeConfigVersionId ?? null,
		latestConfigVersion: app.latestConfigVersion ?? null,
		updatedAt: app.updatedAt,
	};
}

function toAppToolDto(tool: AppToolRecord) {
	return {
		id: tool.id,
		toolId: tool.toolId,
		toolTypeId: tool.toolTypeId,
		title: tool.title,
		description: tool.description,
		inputSchema: tool.inputSchema,
		outputSchema: tool.outputSchema,
		adapterScope: tool.adapterScope,
		resultStrategy: tool.resultStrategy,
		outputTemplate: tool.outputTemplate,
		widgetKey: tool.widgetKey,
		widgetRoute: tool.widgetRoute,
		widgetAccessible: normalizeNullableBoolean(tool.widgetAccessible),
		authRequired: tool.authRequired ?? false,
		visibility: tool.visibility,
		icons: tool.icons,
		executionTaskSupport: tool.executionTaskSupport,
		annotations: tool.annotations,
		// apps/mcp folds this onto the wire annotations, so omitting it here would
		// leave every declared-but-unannotated tool UNDECLARED at the gates.
		writeCapability: tool.writeCapability,
		meta: tool.meta,
		invocationStatus: tool.invocationStatus,
		fileParams: tool.fileParams,
		widgetDescription: tool.widgetDescription,
		widgetPrefersBorder: normalizeNullableBoolean(tool.widgetPrefersBorder),
		widgetDomain: tool.widgetDomain,
		config: tool.config,
		schemaDialect: tool.schemaDialect,
		schemaSource: tool.schemaSource,
		schemaSourceRef: tool.schemaSourceRef,
		schemaSourceHash: tool.schemaSourceHash,
		schemaSyncedAt: tool.schemaSyncedAt,
		sortOrder: tool.sortOrder,
		enabled: normalizeNullableBoolean(tool.enabled),
		createdAt: tool.createdAt,
		updatedAt: tool.updatedAt,
		toolCspDomains: normalizeToolCspDomains(tool.toolCspDomains),
	};
}

export function toCatalogMcpSurfaceDto<T extends { catalogAppId: string }>(
	row: T,
): Omit<T, "catalogAppId"> {
	const { catalogAppId: _catalogAppId, ...dto } = row;
	return dto;
}

/**
 * Warn (don't reject) if guidanceSkillApps contains a slug that doesn't match
 * any aggregateApps entry. Materialized project apps should be referenced by
 * their explicit aggregate slug (for example "firecrawl-tedix").
 */
function warnGuidanceSkillAppsMismatch(
	metadata: unknown,
	appLabel: string,
): void {
	if (!metadata || typeof metadata !== "object") return;
	const mcpConfig = (metadata as Record<string, unknown>).mcpConfig;
	if (!mcpConfig || typeof mcpConfig !== "object") return;
	const mc = mcpConfig as Record<string, unknown>;
	const guidance = mc.guidanceSkillApps;
	const aggregates = mc.aggregateApps;
	if (!Array.isArray(guidance) || guidance.length === 0) return;
	if (!Array.isArray(aggregates) || aggregates.length === 0) return;

	const aggregateSlugs = new Set<string>();
	for (const entry of aggregates) {
		if (entry && typeof entry === "object") {
			const slug = (entry as Record<string, unknown>).slug;
			if (typeof slug === "string") aggregateSlugs.add(slug);
		}
	}

	const unknown: string[] = [];
	for (const g of guidance) {
		if (typeof g !== "string") continue;
		if (aggregateSlugs.has(g)) continue;
		// Tolerate base-slug form: any aggregate slug that contains g as a hyphen-bounded segment.
		const matchesBase = [...aggregateSlugs].some(
			(s) =>
				s === g ||
				s.startsWith(`${g}-`) ||
				s.endsWith(`-${g}`) ||
				s.includes(`-${g}-`),
		);
		if (!matchesBase) unknown.push(g);
	}

	if (unknown.length > 0) {
		console.warn(
			`[apps.update] guidanceSkillApps for ${appLabel} contains slugs not present in aggregateApps: ` +
				`${unknown.join(", ")}. Valid aggregateApps slugs: ${[...aggregateSlugs].join(", ")}. ` +
				`Operators should align guidanceSkillApps with explicit aggregateApps slugs.`,
		);
	}
}

type CspDomainType =
	| "connect"
	| "resource"
	| "img"
	| "script"
	| "style"
	| "frame"
	| "redirect";
const TOOL_CSP_DOMAIN_TYPES: Set<CspDomainType> = new Set([
	"connect",
	"resource",
	"img",
	"script",
	"style",
	"frame",
	"redirect",
] as const);

function normalizeToolCspDomains(
	domains:
		| Array<{
				toolId: string;
				domainType: string;
				domainUrl: string;
				active: boolean;
		  }>
		| null
		| undefined,
) {
	return (domains ?? []).map((d) => ({
		toolId: d.toolId,
		domainUrl: d.domainUrl,
		domainType: TOOL_CSP_DOMAIN_TYPES.has(d.domainType as CspDomainType)
			? (d.domainType as CspDomainType)
			: "connect",
		active: d.active,
	}));
}

async function requireAppForOrg(db: DbClient, orgId: string, appId: string) {
	const app = await getAppById(db, appId);
	if (!app) {
		throw createError(ErrorCodes.NOT_FOUND, "App not found");
	}
	if (!app.organizationId || app.organizationId !== orgId) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"You do not have access to this app",
		);
	}
	return app;
}

// =============================================================================
// TYPE EXPORT
// =============================================================================
