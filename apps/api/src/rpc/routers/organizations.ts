import { validateEmbeddedTediSelection } from "../../services/embedded-tedi-selection";
/**
 * oRPC Organizations Router
 * Organization CRUD and membership management
 *
 * This router uses contract-first development with oRPC.
 * Contract imported from @tedix/api-contract package.
 */

import { implement } from "@orpc/server";
import { organizationsContract } from "@tedix/api-contract/contracts/organizations";
import type { CreateOrganizationInput } from "@tedix/api-contract/schemas/organization";
import { PLATFORM_ONLY_API_KEY_SCOPES } from "@tedix/api-contract/schemas/organization";
import type { OrganizationPermission } from "@tedix/api-contract/schemas/user-settings";
import { deleteAllAppRelations } from "@tedix/auth/fga";
import { descopeIssuer } from "@tedix/auth/principal-identity";
import { isTenantGrantablePermission } from "@tedix/auth/rbac";
import type { JWTPayload } from "@tedix/auth/types";
import {
	getTenantId,
	getTenantRoles,
	isPlatformPrincipal,
} from "@tedix/auth/types";
import {
	createApiKey as createApiKeyDb,
	deleteApiKey as deleteApiKeyDb,
	getApiKeyById,
	getApiKeysByOrganization,
	getExpiringKeys as getExpiringKeysDb,
	revokeApiKey as revokeApiKeyDb,
	rotateApiKey as rotateApiKeyDb,
} from "@tedix/db/queries/api-keys";
import { getAppsByOrganization } from "@tedix/db/queries/apps";
import { getBillingEntitlement } from "@tedix/db/queries/billing/plans";
import {
	addMember,
	getMemberByCanonicalUserId,
	getMemberByUserId,
	getOrganizationAggregatorGateways,
	getUserOrganizationMemberships,
	getUserOsMemberships,
	updateMember,
} from "@tedix/db/queries/organization-members";
import {
	ensureOrgAndMember,
	ensurePersonalOrg,
} from "@tedix/db/queries/organization-sync";
import {
	bindOrganizationExternalIdentity,
	canCreateApp as canCreateAppDb,
	isSlugAvailable as checkSlugAvailable,
	createOrganization,
	generateUniqueSlug,
	getOrganizationByDescopeId,
	getOrganizationByExternalIdentity,
	getOrganizationById,
	getOrganizationBySlug,
	getOrganizationFeatures,
	listOrganizations as listOrganizationsDb,
	retireOrganization,
	updateOrganization,
} from "@tedix/db/queries/organizations";
import { upsertUserForExternalIdentity } from "@tedix/db/queries/users";
import { DEFAULT_ORGANIZATION_FEATURES_BY_PLAN } from "@tedix/db/schema/organizations";
import { parseJsonField } from "@tedix/db/utils/json";
import {
	resolveBillingSettlementMode,
	resolveInstallationEntitlementGrants,
} from "../../lib/billing-settlement-mode";
import {
	ensureOrganizationUnifiedGateway,
	OrganizationGatewaySlugConflictError,
	renameOrganizationUnifiedGateway,
} from "../../lib/organization-mcp-gateway";
import { autoProvisionFirstTedi } from "../../lib/tedi-provisioning";
import {
	listHumanMcpAuthorizations,
	disableHumanMcpAuthorization,
	revokeHumanMcpConsent,
	stageHumanMcpConsent,
	verifyHumanMcpGrant,
} from "../../lib/mcp-grant";
import {
	AUTHZ,
	type BaseContext,
	createError,
	ErrorCodes,
	withAuth,
	withAuthorization,
	withServiceAuth,
} from "../orpc";
import { requireStepUp } from "../step-up";

import {
	descopeTenantRolesForMemberRole,
	ensurePersonalDescopeTenantMembership,
	getDescopeManagement,
	memberRoleFromTenantRoles,
	normalizeMemberRole,
} from "./organizations-descope-membership";

/**
 * Create the contract implementer with base context
 * This enforces type safety between contract and implementation
 */
const organizationsOs = implement(
	organizationsContract,
).$context<BaseContext>();

/**
 * Create authenticated implementer - ALL procedures inherit auth
 * This ensures all organization endpoints require authentication
 */
const authedOrganizationsOs = organizationsOs.use(withAuth);

export const listMcpAuthorizationsContract =
	authedOrganizationsOs.listMcpAuthorizations
		.use(
			withAuthorization(
				{
					handlerOwnedUserAuthorization:
						"Lists only the authenticated human subject's Connect authorizations.",
				},
				"mcp:apps.read",
			),
		)
		.handler(async ({ input, context }) => {
			if (context.authType !== "user" || !context.user?.sub)
				throw createError(ErrorCodes.FORBIDDEN, "Human sign-in required");
			return listHumanMcpAuthorizations(
				context.db,
				context.env,
				context.user.sub,
				input,
			);
		});
export const disableMcpAuthorizationContract =
	authedOrganizationsOs.disableMcpAuthorization
		.use(
			withAuthorization(
				{
					handlerOwnedUserAuthorization:
						"Disables only the authenticated human subject's exact stored Connect revision.",
				},
				"mcp:apps.write",
			),
		)
		.handler(async ({ input, context }) => {
			if (context.authType !== "user" || !context.user?.sub)
				throw createError(ErrorCodes.FORBIDDEN, "Human sign-in required");
			const revision = await disableHumanMcpAuthorization(
				context.db,
				context.env,
				context.user.sub,
				input,
			);
			if (!revision)
				throw createError(
					ErrorCodes.CONFLICT,
					"Authorization changed or unavailable. Refresh and try again.",
				);
			return { revision };
		});

export const stageHumanMcpConsentContract =
	authedOrganizationsOs.stageMultiOrgMcpConsent
		.use(
			withAuthorization(
				{
					handlerOwnedUserAuthorization:
						"The handler binds this consent decision to the authenticated human subject and verified Connect client.",
				},
				"mcp:apps.write",
			),
		)
		.handler(async ({ input, context }) => {
			if (context.authType !== "user" || !context.user?.sub) {
				throw createError(ErrorCodes.FORBIDDEN, "Human sign-in required");
			}
			let revision: string | null;
			try {
				revision = await stageHumanMcpConsent(
					context.db,
					context.env,
					context.user.sub,
					input,
				);
			} catch {
				throw createError(
					ErrorCodes.SERVICE_UNAVAILABLE,
					"Consent verification is temporarily unavailable",
				);
			}
			if (!revision)
				throw createError(ErrorCodes.FORBIDDEN, "Consent selection invalid");
			return { revision };
		});

export const revokeHumanMcpConsentContract =
	authedOrganizationsOs.revokeMultiOrgMcpConsent
		.use(
			withAuthorization(
				{
					handlerOwnedUserAuthorization:
						"The handler revokes only the authenticated human subject's current Connect consent selection.",
				},
				"mcp:apps.write",
			),
		)
		.handler(async ({ input, context }) => {
			if (context.authType !== "user" || !context.user?.sub) {
				throw createError(ErrorCodes.FORBIDDEN, "Human sign-in required");
			}
			let revision: string | null;
			try {
				revision = await revokeHumanMcpConsent(
					context.db,
					context.env,
					context.user.sub,
					input,
				);
			} catch {
				throw createError(
					ErrorCodes.SERVICE_UNAVAILABLE,
					"Consent revocation is temporarily unavailable",
				);
			}
			if (!revision)
				throw createError(ErrorCodes.FORBIDDEN, "Connect client invalid");
			return { revision };
		});

/** Internal authorization read used only after the MCP edge validates OAuth. */
export const verifyHumanMcpGrantContract =
	organizationsOs.verifyMultiOrgMcpGrant
		.use(withServiceAuth)
		.handler(async ({ input, context }) =>
			verifyHumanMcpGrant(context.db, context.env, input),
		);

function mcpDomainForEnvironment(environment: string | undefined): string {
	return environment === "production" ? "mcp.tedix.dev" : "mcp.tedix.tech";
}

function gatewayUrl(
	gateway: { slug: string; customMcpDomain: string | null },
	environment: string | undefined,
	mcpOrigin?: string,
): string {
	if (!gateway.customMcpDomain && environment !== "production" && mcpOrigin) {
		try {
			const local = new URL(mcpOrigin);
			if (
				local.protocol === "http:" &&
				(local.hostname === "localhost" || local.hostname === "127.0.0.1")
			) {
				return `http://${gateway.slug}.localhost${local.port ? `:${local.port}` : ""}/mcp`;
			}
		} catch {
			// An invalid optional origin cannot replace the normal Cloud endpoint.
		}
	}
	const host =
		gateway.customMcpDomain ??
		`${gateway.slug}.${mcpDomainForEnvironment(environment)}`;
	return `https://${host}/mcp`;
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Cross-check D1 org memberships against the user's LIVE Descope tenant
 * grants — a defense against drift between D1 (Tedix's local membership
 * cache) and Descope (identity source of truth). Tedix JWTs only carry the
 * current tenant's claims, so this can no longer be answered from the token;
 * it queries the Descope Management API directly instead, which is also
 * strictly more correct than the old JWT-snapshot check (immune to the
 * "switched to org A, still see org B" stale-token class of bug).
 */
async function filterMembershipsByLiveDescopeTenants<
	T extends {
		organizationType: "personal" | "organization";
		descopeTenantId: string | null;
	},
>(memberships: T[], descopeUserId: string, env: CloudflareEnv): Promise<T[]> {
	const personalTenantId = `personal_${descopeUserId}`;
	const mgmt = getDescopeManagement(env);
	let liveTenantIds: Set<string> | null = null;
	if (mgmt) {
		try {
			const resp = await mgmt.management.user.loadByUserId(descopeUserId);
			liveTenantIds = new Set(
				(resp.data?.userTenants ?? []).map((t) => t.tenantId),
			);
		} catch (error) {
			console.warn(
				"[organizations.listMine] Failed to load live Descope tenants — trusting D1 membership instead:",
				error,
			);
		}
	}

	// No management key configured, or the live check errored: trust D1 alone
	// rather than hiding every non-personal org on a transient failure.
	if (!liveTenantIds) return memberships;

	return memberships.filter((membership) => {
		const tenantId = membership.descopeTenantId;
		if (!tenantId) return false;
		if (tenantId === personalTenantId) return true;
		if (membership.organizationType === "personal") return false;
		return liveTenantIds.has(tenantId);
	});
}

/**
 * Map DB organization to contract shape.
 * Contract uses `descopeTenantId` directly.
 */
function mapOrgToContract(
	org: Record<string, unknown> & {
		id: string;
		name: string;
		slug: string;
		type?: string | null;
		descopeTenantId?: string | null;
		logoUrl?: string | null;
		description?: string | null;
		appsCount?: number | null;
		features?: unknown;
		metadata?: unknown;
		createdAt: string | null;
		updatedAt: string | null;
	},
) {
	return {
		id: org.id,
		name: org.name,
		slug: org.slug,
		type: (org.type ?? "organization") as "personal" | "organization",
		descopeTenantId: org.descopeTenantId ?? null,
		logoUrl: org.logoUrl ?? null,
		description: org.description ?? null,
		appsCount: org.appsCount ?? null,
		features: (org.features ?? null) as Record<string, unknown> | null,
		metadata: (org.metadata ?? null) as Record<string, unknown> | null,
		createdAt: org.createdAt,
		updatedAt: org.updatedAt,
	};
}

// =============================================================================
// CONTRACT-BASED PROCEDURE IMPLEMENTATIONS
// =============================================================================

/**
 * Public, exact-slug bootstrap for CLI OAuth.
 *
 * The response is deliberately limited to the organization's public name/slug
 * and public MCP resource URL. It does not reveal membership, internal ids, or
 * the Descope tenant id, and OAuth plus the gateway still enforce membership.
 */
export const resolveCliWorkspaceContract =
	organizationsOs.resolveCliWorkspace.handler(async ({ input, context }) => {
		const org = await getOrganizationBySlug(context.db, input.slug);
		if (!org) {
			throw createError(ErrorCodes.NOT_FOUND, "Organization not found");
		}
		const gateways = await getOrganizationAggregatorGateways(context.db, [
			org.id,
		]);
		const gateway = gateways.get(org.id);
		if (!gateway) {
			throw createError(
				ErrorCodes.NOT_FOUND,
				"Organization MCP gateway is not provisioned",
			);
		}
		return {
			slug: org.slug,
			name: org.name,
			gatewayUrl: gatewayUrl(
				gateway,
				context.env.ENVIRONMENT,
				context.env.MCP_URL,
			),
		};
	});

/**
 * Contract-based list procedure implementation
 *
 * SECURITY: This endpoint lists ALL organizations in the database.
 * Restricted to platform-admin user JWTs. Machine principals and ordinary
 * tenant users are blocked to prevent cross-organization enumeration.
 */
export const listOrganizations = authedOrganizationsOs.list
	.use(AUTHZ.platformAdmin)
	.handler(async ({ input, context }) => {
		// Block API keys and M2M tokens - only allow user JWT
		if (context.authType !== "user") {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"This endpoint requires user authentication. Use /organizations/listMine for API key access.",
			);
		}

		const { db } = context;
		const { limit = 50, offset = 0 } = input;

		const orgs = await listOrganizationsDb(db, {
			limit,
			offset,
		});

		// Note: Uses items.length for total — add a proper COUNT query for pagination accuracy
		const total = orgs.length;

		return {
			data: orgs.map((org) => ({
				id: org.id,
				name: org.name,
				slug: org.slug,
				logoUrl: org.logoUrl,
				appsCount: org.appsCount,
				createdAt: org.createdAt,
			})),
			pagination: {
				limit,
				offset,
				total,
				hasMore: offset + orgs.length < total,
			},
		};
	});

/**
 * Contract-based get procedure implementation
 */
export const getOrganization = authedOrganizationsOs.get
	.use(AUTHZ.appsRead)
	.handler(async ({ input, context }) => {
		const { db } = context;
		const { organizationId } = input;

		requireOrganizationAccess(context, organizationId);

		const org = await getOrganizationById(db, organizationId);
		if (!org) {
			throw createError(ErrorCodes.NOT_FOUND, "Organization not found");
		}

		return mapOrgToContract(org);
	});

/**
 * Contract-based getBySlug procedure implementation
 */
export const getOrganizationBySlugContract = authedOrganizationsOs.getBySlug
	.use(AUTHZ.appsRead)
	.handler(async ({ input, context }) => {
		const { db } = context;
		const { slug } = input;

		const org = await getOrganizationBySlug(db, slug);
		if (!org) {
			throw createError(ErrorCodes.NOT_FOUND, "Organization not found");
		}
		requireOrganizationAccess(context, org.id);

		return mapOrgToContract(org);
	});

/**
 * Contract-based create procedure implementation
 */
export const createOrganizationContract = authedOrganizationsOs.create
	.use(
		withAuthorization(
			{
				handlerOwnedUserAuthorization:
					"The handler permits a signed-in human to create their own organization and separately verifies platform machine authority.",
			},
			"platform:admin",
		),
	)
	.handler(({ input, context }) => createOrganizationResources(context, input));

/** Internal provider onboarding; its caller owns provider authorization and defaults. */
export function createOrganizationForProvider(
	context: BaseContext,
	input: CreateOrganizationInput,
) {
	if (
		!input.metadata?.providerCustomerKey ||
		!input.ownerUserId ||
		!input.ownerEmail
	)
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"Provider customer identity and owner are required",
		);
	return createOrganizationResources(context, input, true);
}

async function createOrganizationResources(
	context: BaseContext,
	input: CreateOrganizationInput,
	providerAuthorized = false,
) {
	if (
		((input.metadata?.providerCustomerKey && !providerAuthorized) ||
			(input.metadata && "providerOnboarding" in input.metadata)) &&
		!isPlatformPrincipal(context)
	) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Only platform authority can bind provider customer identity",
		);
	}

	const { db, user } = context as BaseContext & {
		user?: JWTPayload;
	};

	// Two valid creator paths:
	// 1. User JWT — creator = user.sub (normal Tedix OS signup flow)
	// 2. Platform principal — API key / M2M / a `platform_admin` tedi (whose
	//    `platform:admin` capability scope the MCP edge forwards). Creator =
	//    ownerUserId + ownerEmail from input. Used by skill workflows,
	//    onboarding scripts, and tedis creating an org on a human's behalf.
	//    A tedi never lands on path 1 (`withAuth` deliberately leaves
	//    `context.user` unset for tedi callers), so it cannot make ITSELF the
	//    owner — it must name a human explicitly.
	let userId: string;
	let memberEmail: string | undefined;
	let memberName: string | null = null;
	if (user?.sub && !providerAuthorized) {
		userId = user.sub;
		memberEmail = user.email;
		memberName = user.name ?? null;
	} else if (providerAuthorized || isPlatformPrincipal(context)) {
		if (!input.ownerEmail || !input.ownerUserId) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Platform-admin org creation requires ownerEmail + ownerUserId in input",
			);
		}
		userId = input.ownerUserId;
		memberEmail = input.ownerEmail;
		memberName = null;
	} else {
		throw createError(
			ErrorCodes.UNAUTHORIZED,
			"Authentication required to create organization",
		);
	}

	// Provider re-entry resolves on the deterministic tenant id, never on the
	// handle: the handle is a human address derived from an editable name, so a
	// retry must find the same organization even after it was renamed, and must
	// not mint a second one just because `generateUniqueSlug` avoided the taken
	// handle it created on the first pass.
	const providerKey = input.metadata?.providerCustomerKey;
	let existingProviderOrg = providerKey
		? await getOrganizationByDescopeId(db, `org_${providerKey}`)
		: undefined;

	// An existing organization keeps its handle; a new one derives it from the
	// display name (slugify → suffix on collision → uuid suffix).
	const slug =
		input.slug ??
		existingProviderOrg?.slug ??
		(await generateUniqueSlug(db, input.name));

	// Check slug availability
	const available = await checkSlugAvailable(db, slug);
	if (
		!available &&
		(!providerKey ||
			existingProviderOrg?.metadata?.providerCustomerKey !== providerKey)
	) {
		throw createError(ErrorCodes.CONFLICT, `Slug "${slug}" is already taken`);
	}

	if (!memberEmail) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"Unable to resolve user email for organization creation",
		);
	}

	// A usable organization needs a Descope tenant. Automatic provider setup
	// uses its platform-owned opaque key so cross-request retries converge on
	// the same external identity; ordinary organizations receive a UUID.
	// Neither identity depends on an editable display name or tenant slug.

	let descopeTenantId = existingProviderOrg?.descopeTenantId ?? undefined;
	const mgmt = getDescopeManagement(context.env);
	if (mgmt && !descopeTenantId) {
		const desiredTenantId = `org_${input.metadata?.providerCustomerKey ?? crypto.randomUUID()}`;
		const adoptIfExists = async () => {
			try {
				const existing = await mgmt.management.tenant.load(desiredTenantId);
				if (existing.ok && existing.data) descopeTenantId = desiredTenantId;
			} catch {
				// leave descopeTenantId undefined → fail-fast below
			}
		};
		try {
			const tenantResult = await mgmt.management.tenant.createWithId(
				desiredTenantId,
				input.name,
				[],
			);
			if (tenantResult.ok) {
				descopeTenantId = desiredTenantId;
				// Set default role for SSO/SCIM-provisioned users so newly federated
				// employees land on `member` automatically. Project-level roles are
				// reusable across tenants — see docs/engineering/platform/auth.md (RBAC).
				try {
					await mgmt.management.tenant.updateDefaultRoles(desiredTenantId, [
						"member",
					]);
				} catch (error) {
					console.warn(
						"[Organizations] Failed to set default tenant role (non-blocking):",
						error,
					);
				}
			} else {
				// Not ok — may be a replay where the tenant already exists.
				await adoptIfExists();
			}
		} catch (error) {
			console.warn("[Organizations] Failed to create Descope tenant:", error);
			await adoptIfExists();
		}
	}

	// Fail fast: never persist an unusable org. A null descopeTenantId (no mgmt
	// key, or a genuine Descope create failure) would 403 every org-scoped call
	// via the orpc tenant map — the tenant-drift class. (1.3b)
	if (!descopeTenantId) {
		throw createError(
			ErrorCodes.SERVICE_UNAVAILABLE,
			"Organization creation requires Descope tenant provisioning, which is currently unavailable. No organization was created — please retry.",
		);
	}

	// Create organization in D1
	try {
		existingProviderOrg ??= await createOrganization(
			db,
			{
				name: input.name,
				slug,
				logoUrl: input.logoUrl,
				description: input.description,
				metadata: input.metadata,
				descopeTenantId: descopeTenantId,
			},
			{
				settlementMode: resolveBillingSettlementMode(context.env),
				runtimeEntitlementGrants: resolveInstallationEntitlementGrants(
					context.env,
				),
			},
		);
	} catch (error) {
		// Only this platform-owned operation may adopt a concurrent create. The
		// racing writer may have won a different handle, so adopt on tenant id.
		const winner = providerKey
			? await getOrganizationByDescopeId(db, `org_${providerKey}`)
			: undefined;
		if (!winner || winner.metadata?.providerCustomerKey !== providerKey)
			throw error;
		existingProviderOrg = winner;
	}
	const org = existingProviderOrg;
	if (org.descopeTenantId !== descopeTenantId) {
		throw createError(
			ErrorCodes.CONFLICT,
			"Provider customer tenant identity has changed",
		);
	}
	const identityIssuer = descopeIssuer(
		context.env.DESCOPE_PROJECT_ID,
		context.env.DESCOPE_BASE_URL,
	);
	const canonicalUser = await upsertUserForExternalIdentity(db, {
		identity: {
			provider: "descope",
			issuer: identityIssuer,
			subject: userId,
		},
		email: memberEmail,
		name: memberName,
	});
	await bindOrganizationExternalIdentity(db, org.id, {
		provider: "descope",
		issuer: identityIssuer,
		subject: descopeTenantId,
	});

	// Add creator as owner in D1
	const owner = await getMemberByUserId(db, org.id, userId);
	if (owner && (owner.role !== "owner" || owner.status !== "active")) {
		throw createError(
			ErrorCodes.CONFLICT,
			"Provider customer owner membership has changed",
		);
	}
	if (!owner)
		try {
			await addMember(db, {
				organizationId: org.id,
				userId: canonicalUser.id,
				descopeUserId: userId,
				email: memberEmail,
				name: memberName,
				avatarUrl: null,
				role: "owner",
				status: "active",
			});
		} catch (error) {
			const winner = providerKey
				? await getMemberByUserId(db, org.id, userId)
				: undefined;
			if (!winner || winner.role !== "owner" || winner.status !== "active")
				throw error;
		}

	// Sync creator's roles to Descope so JWT tenants[descopeTenantId].roles
	// is populated. Two roles needed:
	//   - "owner": our project-level RBAC role for human `withPermission()`
	//     checks (see docs/engineering/platform/auth.md, RBAC).
	//   - "admin": Descope admin capability required to connect
	//     outbound OAuth applications at tenant scope. Without it, the first
	//     time a creator tries to connect any org-level OAuth provider they
	//     hit Descope error E152002 "User session validation failed, user is
	//     not tenant admin".
	// Non-blocking: D1 is authoritative for membership; Descope sync is best-effort.
	if (mgmt && descopeTenantId) {
		try {
			await mgmt.management.user.addTenantRoles(
				userId,
				descopeTenantId,
				descopeTenantRolesForMemberRole("owner"),
			);
		} catch (error) {
			console.warn(
				"[Organizations] Failed to sync creator owner role to Descope (non-blocking):",
				error,
			);
		}
	}

	// Organization creation is not complete until its accountable default worker
	// exists. This covers API/provider-created organizations as well as the OS
	// onboarding path below; retries converge because provisioning is guarded by
	// the organization's existing tedi inventory.
	try {
		await autoProvisionFirstTedi(db, context.env, org.id, memberName, userId);
	} catch (error) {
		console.error("[Organizations] Default tedi provisioning failed:", error);
		throw createError(
			ErrorCodes.SERVICE_UNAVAILABLE,
			"Organization tedi provisioning is incomplete. Please retry creation.",
		);
	}

	return mapOrgToContract(org);
}

/**
 * Contract-based update procedure implementation
 */
export const updateOrganizationContract = authedOrganizationsOs.update
	.use(AUTHZ.settingsWrite)
	.handler(async ({ input, context }) => {
		if (
			(input.metadata?.providerCustomerKey !== undefined ||
				(input.metadata && "providerOnboarding" in input.metadata)) &&
			!isPlatformPrincipal(context)
		) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Only platform authority can bind provider customer identity",
			);
		}

		const { db } = context;
		const { organizationId, ...updates } = input;

		requireOrganizationAccess(context, organizationId);
		requireAdminOrOwner(context);

		const existing = await getOrganizationById(db, organizationId);
		if (!existing) {
			throw createError(ErrorCodes.NOT_FOUND, "Organization not found");
		}

		// Check slug availability if changing
		if (updates.slug && updates.slug !== existing.slug) {
			const available = await checkSlugAvailable(
				db,
				updates.slug,
				organizationId,
			);
			if (!available) {
				throw createError(
					ErrorCodes.CONFLICT,
					`Slug "${updates.slug}" is already taken`,
				);
			}
			// The handle is the address of the org's MCP gateway too. Move it
			// before the row changes, so a refused move leaves both consistent
			// instead of renaming the org away from a gateway it still owns.
			const existingGateway = (
				await getOrganizationAggregatorGateways(db, [organizationId])
			).get(organizationId);
			try {
				await renameOrganizationUnifiedGateway(db, context.env, {
					organizationId,
					organizationName: updates.name ?? existing.name,
					currentGatewaySlug: existingGateway?.slug,
					nextOrganizationSlug: updates.slug,
				});
			} catch (error) {
				if (error instanceof OrganizationGatewaySlugConflictError) {
					throw createError(ErrorCodes.CONFLICT, error.message);
				}
				console.error(
					"[Organizations] Unified MCP gateway rename failed:",
					error,
				);
				throw createError(
					ErrorCodes.SERVICE_UNAVAILABLE,
					"Workspace gateway rename is incomplete. Please retry.",
				);
			}
		}

		// MERGE metadata rather than replace it. `metadata` is one JSON column
		// holding both profile fields and browser enforcement config
		// (`browserEgress` allow/deny hostnames, read straight from D1 by the runtime). The
		// contract schema lists only the profile fields, so zod strips the rest
		// off the input, and a wholesale write would drop enforcement with no
		// error and no audit event — the org profile form sends just
		// `{website, contactEmail}` and would erase everything else.
		//
		// Shallow is sufficient: callers only ever send whole leaf profile
		// fields. Inference admission policy is stored in explicit billing-policy
		// rows and never passes through this profile update path.
		if (updates.metadata?.tediWidget?.tediSelection)
			await validateEmbeddedTediSelection(
				context,
				organizationId,
				updates.metadata.tediWidget.tediSelection,
			);
		const updated = await updateOrganization(db, organizationId, {
			...updates,
			...(updates.metadata
				? { metadata: { ...(existing.metadata ?? {}), ...updates.metadata } }
				: {}),
		});

		// Sync name to Descope tenant (non-blocking)
		if (existing.descopeTenantId && updates.name) {
			const mgmt = getDescopeManagement(context.env);
			if (mgmt) {
				try {
					await mgmt.management.tenant.update(
						existing.descopeTenantId,
						updates.name ?? existing.name,
					);
				} catch (error) {
					console.warn(
						"[Organizations] Failed to sync Descope tenant update:",
						error,
					);
				}
			}
		}

		return mapOrgToContract(updated);
	});

/**
 * Contract-based listApiKeys procedure implementation
 */
export const listApiKeysContract = authedOrganizationsOs.listApiKeys
	.use(AUTHZ.apiKeysAdmin)
	.handler(async ({ input, context }) => {
		const { db } = context;
		const { organizationId, status, environment, limit, offset } = input;

		requireOrganizationAccess(context, organizationId);

		const org = await getOrganizationById(db, organizationId);
		if (!org) {
			throw createError(ErrorCodes.NOT_FOUND, "Organization not found");
		}

		const keys = await getApiKeysByOrganization(db, organizationId, {
			status: status as "active" | "revoked" | "expired" | undefined,
			environment: environment as "test" | "live" | undefined,
			limit,
			offset,
		});

		// Valid scopes from the contract schema
		const validScopes = [
			"apps:read",
			"apps:write",
			"apps:delete",
			"tools:read",
			"tools:write",
			"analytics:read",
			"adapters:read",
			"adapters:write",
			"billing:read",
			"team:read",
			"*",
		] as const;
		type ValidScope = (typeof validScopes)[number];

		// Helper to filter scopes to only valid values
		// Handles both parsed arrays and JSON strings (D1 sometimes returns text)
		const filterScopes = (scopes: unknown): ValidScope[] | null => {
			let parsed: unknown[] | null = null;

			if (Array.isArray(scopes)) {
				parsed = scopes;
			} else if (typeof scopes === "string") {
				const result = parseJsonField<unknown[]>(scopes);
				if (Array.isArray(result)) parsed = result;
				else return null;
			}

			if (!parsed) return null;
			const filtered = parsed.filter((s): s is ValidScope =>
				validScopes.includes(s as ValidScope),
			);
			return filtered.length > 0 ? filtered : null;
		};

		// Helper to convert string to valid enum or null
		const toValidEnvironment = (
			env: string | null | undefined,
		): "test" | "live" | null => {
			if (env === "test" || env === "live") return env;
			return null;
		};

		const toValidStatus = (
			s: string | null | undefined,
		): "active" | "revoked" | "expired" | null => {
			if (s === "active" || s === "revoked" || s === "expired") return s;
			return null;
		};

		// Helper to ensure string or null (not undefined), serializing Date objects
		const toStringOrNull = (v: unknown): string | null => {
			if (typeof v === "string") return v;
			if (v instanceof Date) return v.toISOString();
			return null;
		};

		// Helper to ensure number or null (not undefined)
		const toNumberOrNull = (v: unknown): number | null => {
			if (typeof v === "number") return v;
			return null;
		};

		// Helper to parse array from JSON string or return array directly
		const toStringArrayOrNull = (v: unknown): string[] | null => {
			if (Array.isArray(v)) return v.filter((x) => typeof x === "string");
			if (typeof v === "string") {
				const result = parseJsonField<unknown[]>(v);
				if (Array.isArray(result))
					return result.filter((x) => typeof x === "string");
				return null;
			}
			return null;
		};

		// Helper to parse object from JSON string or return object directly
		const toRecordOrNull = (v: unknown): Record<string, unknown> | null => {
			if (v && typeof v === "object" && !Array.isArray(v))
				return v as Record<string, unknown>;
			if (typeof v === "string") {
				const result = parseJsonField<Record<string, unknown>>(v);
				if (result && typeof result === "object" && !Array.isArray(result))
					return result;
				return null;
			}
			return null;
		};

		// Helper to validate UUID format
		const isValidUuid = (id: string): boolean => {
			const uuidRegex =
				/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
			return uuidRegex.test(id);
		};

		// Filter out keys with invalid UUIDs (legacy keys with old ID format)
		const validKeys = keys.filter((key) => isValidUuid(key.id));

		const mappedKeys = validKeys.map((key) => ({
			id: key.id,
			organizationId: key.organizationId,
			name: key.name,
			description: toStringOrNull(key.description),
			keyPreview: key.keyPreview,
			scopes: filterScopes(key.scopes),
			descopeClientId: null as string | null,
			environment: toValidEnvironment(key.environment),
			lastUsedAt: toStringOrNull(key.lastUsedAt),
			requestsThisMonth: toNumberOrNull(key.requestsThisMonth),
			totalRequests: toNumberOrNull(key.totalRequests),
			ipAllowlist: toStringArrayOrNull(key.ipAllowlist),
			expiresAt: toStringOrNull(key.expiresAt),
			status: toValidStatus(key.status),
			rotatedAt: toStringOrNull(key.rotatedAt),
			rotationScheduleDays: toNumberOrNull(key.rotationScheduleDays),
			previousKeyExpiresAt: toStringOrNull(key.previousKeyExpiresAt),
			revokedAt: toStringOrNull(key.revokedAt),
			revokedBy: toStringOrNull(key.revokedBy),
			revokeReason: toStringOrNull(key.revokeReason),
			metadata: toRecordOrNull(key.metadata),
			createdBy: toStringOrNull(key.createdBy),
			createdAt: toStringOrNull(key.createdAt),
			updatedAt: toStringOrNull(key.updatedAt),
		}));

		return {
			data: mappedKeys,
			pagination: {
				limit,
				offset,
				total: mappedKeys.length, // Use filtered count for accurate pagination
				hasMore: false, // Since we're filtering, pagination logic needs adjustment
			},
		};
	});

/**
 * Contract-based createApiKey procedure implementation
 */
export const createApiKeyContract = authedOrganizationsOs.createApiKey
	.use(AUTHZ.apiKeysAdmin)
	.handler(async ({ input, context }) => {
		const { db, user } = context as BaseContext & {
			user?: JWTPayload;
		};
		const { organizationId, ...keyData } = input;

		requireOrganizationAccess(context, organizationId);
		requireAdminOrOwner(context);
		// Creation follows the Cloudflare-style dashboard boundary: the active
		// authenticated admin session, explicit least-privilege scope selection,
		// and a client-side review step authorize issuance. Rotation remains
		// step-up gated because it replaces an already-deployed credential.

		const org = await getOrganizationById(db, organizationId);
		if (!org) {
			throw createError(ErrorCodes.NOT_FOUND, "Organization not found");
		}

		assertDelegatableApiKeyScopes(context, keyData.scopes ?? []);

		// API keys are pure D1 — no external provider integration needed
		const result = await createApiKeyDb(db, {
			organizationId,
			name: keyData.name,
			description: keyData.description,
			scopes: keyData.scopes,
			environment: keyData.environment as "test" | "live" | undefined,
			ipAllowlist: keyData.ipAllowlist,
			expiresAt: keyData.expiresAt,
			rotationScheduleDays: keyData.rotationScheduleDays,
			createdBy: user?.sub,
		});

		return {
			rawKey: result.rawKey,
			apiKey: {
				id: result.apiKey.id,
				organizationId: result.apiKey.organizationId,
				name: result.apiKey.name,
				description: result.apiKey.description,
				keyPreview: result.apiKey.keyPreview,
				scopes: result.apiKey.scopes,
				descopeClientId: null,
				environment: result.apiKey.environment,
				lastUsedAt: result.apiKey.lastUsedAt,
				requestsThisMonth: result.apiKey.requestsThisMonth,
				totalRequests: result.apiKey.totalRequests,
				ipAllowlist: result.apiKey.ipAllowlist,
				expiresAt: result.apiKey.expiresAt,
				status: result.apiKey.status,
				rotatedAt: result.apiKey.rotatedAt ?? null,
				rotationScheduleDays: result.apiKey.rotationScheduleDays ?? null,
				previousKeyExpiresAt: result.apiKey.previousKeyExpiresAt ?? null,
				revokedAt: result.apiKey.revokedAt,
				revokedBy: result.apiKey.revokedBy,
				revokeReason: result.apiKey.revokeReason,
				metadata: result.apiKey.metadata as Record<string, unknown> | null,
				createdBy: result.apiKey.createdBy,
				createdAt: result.apiKey.createdAt,
				updatedAt: result.apiKey.updatedAt,
			},
		};
	});

/**
 * Contract-based revokeApiKey procedure implementation
 */
export const revokeApiKeyContract = authedOrganizationsOs.revokeApiKey
	.use(AUTHZ.apiKeysAdmin)
	.handler(async ({ input, context }) => {
		const { db, user } = context as BaseContext & {
			user?: JWTPayload;
		};
		const { organizationId, keyId, reason } = input;

		requireOrganizationAccess(context, organizationId);
		requireAdminOrOwner(context);

		const org = await getOrganizationById(db, organizationId);
		if (!org) {
			throw createError(ErrorCodes.NOT_FOUND, "Organization not found");
		}

		const apiKey = await getApiKeyById(db, keyId);
		if (!apiKey) {
			throw createError(ErrorCodes.NOT_FOUND, "API key not found");
		}

		if (apiKey.organizationId !== organizationId) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"API key does not belong to this organization",
			);
		}

		const revoked = await revokeApiKeyDb(db, keyId, user?.sub, reason);

		return {
			id: revoked.id,
			organizationId: revoked.organizationId,
			name: revoked.name,
			description: revoked.description,
			keyPreview: revoked.keyPreview,
			scopes: revoked.scopes,
			descopeClientId: null,
			environment: revoked.environment,
			lastUsedAt: revoked.lastUsedAt,
			requestsThisMonth: revoked.requestsThisMonth,
			totalRequests: revoked.totalRequests,
			ipAllowlist: revoked.ipAllowlist,
			expiresAt: revoked.expiresAt,
			status: revoked.status,
			rotatedAt: revoked.rotatedAt ?? null,
			rotationScheduleDays: revoked.rotationScheduleDays ?? null,
			previousKeyExpiresAt: revoked.previousKeyExpiresAt ?? null,
			revokedAt: revoked.revokedAt,
			revokedBy: revoked.revokedBy,
			revokeReason: revoked.revokeReason,
			metadata: revoked.metadata as Record<string, unknown> | null,
			createdBy: revoked.createdBy,
			createdAt: revoked.createdAt,
			updatedAt: revoked.updatedAt,
		};
	});

/**
 * Contract-based deleteApiKey procedure implementation
 */
export const deleteApiKeyContract = authedOrganizationsOs.deleteApiKey
	.use(AUTHZ.apiKeysAdmin)
	.handler(async ({ input, context }) => {
		const { db } = context;
		const { organizationId, keyId } = input;

		requireOrganizationAccess(context, organizationId);

		// Require owner for hard delete
		const role = context.userRole;
		if (role !== "owner") {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Only organization owners can delete API keys. Use revoke instead.",
			);
		}

		const org = await getOrganizationById(db, organizationId);
		if (!org) {
			throw createError(ErrorCodes.NOT_FOUND, "Organization not found");
		}

		const apiKey = await getApiKeyById(db, keyId);
		if (!apiKey) {
			throw createError(ErrorCodes.NOT_FOUND, "API key not found");
		}

		if (apiKey.organizationId !== organizationId) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"API key does not belong to this organization",
			);
		}

		await deleteApiKeyDb(db, keyId);

		return { success: true as const };
	});

/**
 * Contract-based rotateApiKey procedure implementation
 * Generates a new key with 24-hour grace period for the old key
 *
 * Step-up gated. Rotation mints a live credential for the organization, so a
 * hijacked session can use it to issue itself a key the real owner never sees
 * — the grace period on the old key limits the disruption, not the theft.
 */
export const rotateApiKeyContract = authedOrganizationsOs.rotateApiKey
	.use(AUTHZ.apiKeysAdmin)
	.handler(async ({ input, context }) => {
		const { db } = context;
		const { organizationId, keyId } = input;

		requireOrganizationAccess(context, organizationId);
		requireAdminOrOwner(context);
		requireStepUp(context, "Rotating an API key");

		const org = await getOrganizationById(db, organizationId);
		if (!org) {
			throw createError(ErrorCodes.NOT_FOUND, "Organization not found");
		}

		const apiKey = await getApiKeyById(db, keyId);
		if (!apiKey) {
			throw createError(ErrorCodes.NOT_FOUND, "API key not found");
		}

		if (apiKey.organizationId !== organizationId) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"API key does not belong to this organization",
			);
		}

		if (apiKey.status !== "active") {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				`Cannot rotate a ${apiKey.status} API key`,
			);
		}

		const result = await rotateApiKeyDb(db, keyId);

		return {
			rawKey: result.rawKey,
			apiKey: {
				id: result.apiKey.id,
				organizationId: result.apiKey.organizationId,
				name: result.apiKey.name,
				description: result.apiKey.description ?? null,
				keyPreview: result.apiKey.keyPreview,
				scopes: result.apiKey.scopes,
				descopeClientId: null,
				environment: result.apiKey.environment,
				lastUsedAt: result.apiKey.lastUsedAt ?? null,
				requestsThisMonth: result.apiKey.requestsThisMonth ?? null,
				totalRequests: result.apiKey.totalRequests ?? null,
				ipAllowlist: result.apiKey.ipAllowlist ?? null,
				expiresAt: result.apiKey.expiresAt ?? null,
				status: result.apiKey.status,
				rotatedAt: result.apiKey.rotatedAt ?? null,
				rotationScheduleDays: result.apiKey.rotationScheduleDays ?? null,
				previousKeyExpiresAt: result.apiKey.previousKeyExpiresAt ?? null,
				revokedAt: result.apiKey.revokedAt ?? null,
				revokedBy: result.apiKey.revokedBy ?? null,
				revokeReason: result.apiKey.revokeReason ?? null,
				metadata: (result.apiKey.metadata as Record<string, unknown>) ?? null,
				createdBy: result.apiKey.createdBy ?? null,
				createdAt: result.apiKey.createdAt ?? null,
				updatedAt: result.apiKey.updatedAt ?? null,
			},
		};
	});

/**
 * Contract-based getExpiringKeys procedure implementation
 * Returns keys approaching expiry or overdue for rotation
 */
export const getExpiringKeysContract = authedOrganizationsOs.getExpiringKeys
	.use(AUTHZ.apiKeysAdmin)
	.handler(async ({ input, context }) => {
		const { db } = context;
		const { organizationId, withinDays } = input;

		requireOrganizationAccess(context, organizationId);

		const org = await getOrganizationById(db, organizationId);
		if (!org) {
			throw createError(ErrorCodes.NOT_FOUND, "Organization not found");
		}

		const keys = await getExpiringKeysDb(db, organizationId, withinDays);

		return {
			data: keys.map((key) => ({
				id: key.id,
				organizationId: key.organizationId,
				name: key.name,
				description: key.description ?? null,
				keyPreview: key.keyPreview,
				scopes: key.scopes,
				descopeClientId: null as string | null,
				environment: key.environment,
				lastUsedAt: key.lastUsedAt ?? null,
				requestsThisMonth: key.requestsThisMonth ?? null,
				totalRequests: key.totalRequests ?? null,
				ipAllowlist: key.ipAllowlist ?? null,
				expiresAt: key.expiresAt ?? null,
				status: key.status,
				rotatedAt: key.rotatedAt ?? null,
				rotationScheduleDays: key.rotationScheduleDays ?? null,
				previousKeyExpiresAt: key.previousKeyExpiresAt ?? null,
				revokedAt: key.revokedAt ?? null,
				revokedBy: key.revokedBy ?? null,
				revokeReason: key.revokeReason ?? null,
				metadata: (key.metadata as Record<string, unknown>) ?? null,
				createdBy: key.createdBy ?? null,
				createdAt: key.createdAt ?? null,
				updatedAt: key.updatedAt ?? null,
				warningType: key.warningType,
			})),
		};
	});

/**
 * Contract-based listMine procedure implementation
 * Lists all organizations the current user is a member of
 */
export const listMineContract = authedOrganizationsOs.listMine
	.use(
		withAuthorization(
			{
				handlerOwnedUserAuthorization:
					"The handler requires a human subject and returns only that subject's organization memberships.",
			},
			"apps:read",
		),
	)
	.handler(async ({ input, context }) => {
		const { db, user } = context as BaseContext & { user?: JWTPayload };
		const { activeOnly, limit = 50, offset = 0 } = input;

		if (!user?.sub) {
			throw createError(
				ErrorCodes.UNAUTHORIZED,
				"User authentication required",
			);
		}

		const memberships = await filterMembershipsByLiveDescopeTenants(
			await getUserOrganizationMemberships(db, user.sub, {
				activeOnly,
			}),
			user.sub,
			context.env,
		);

		// Apply pagination manually since getUserOrganizationMemberships doesn't support it yet
		const paginatedMemberships = memberships.slice(offset, offset + limit);
		const total = memberships.length;

		return {
			data: paginatedMemberships.map((m) => ({
				member: {
					id: m.member.id,
					organizationId: m.member.organizationId,
					descopeUserId: m.member.descopeUserId,
					email: m.member.email,
					name: m.member.name,
					avatarUrl: m.member.avatarUrl,
					role: normalizeMemberRole(m.member.role),
					customPermissions: filterGrantableOverrides(
						m.member.customPermissions,
					),
					status: m.member.status,
					invitedAt: m.member.invitedAt,
					invitedBy: m.member.invitedBy,
					inviteAcceptedAt: m.member.inviteAcceptedAt,
					lastActiveAt: m.member.lastActiveAt,
					createdAt: m.member.createdAt,
					updatedAt: m.member.updatedAt,
				},
				organizationId: m.organizationId,
				organizationName: m.organizationName,
				organizationSlug: m.organizationSlug,
				organizationLogoUrl: m.organizationLogoUrl,
				organizationType: m.organizationType,
				descopeTenantId: m.descopeTenantId,
				appsCount: m.appsCount,
				tediCount: m.tediCount,
			})),
			pagination: {
				limit,
				offset,
				total,
				hasMore: offset + paginatedMemberships.length < total,
			},
		};
	});

/**
 * Contract-based listAllMine procedure implementation.
 *
 * DECISION (org-enumeration authority): unlike listMine, this does NOT filter by
 * the JWT's current `tenants` claim — it returns every organization the
 * authenticated user is a D1 member of (authority = D1 membership), each with its
 * resolved unified MCP gateway URL. Deliberate and bounded: READ-ONLY enumeration
 * of the caller's OWN memberships (gated on a user JWT with a verified `sub`), so
 * it exposes nothing the user can't already see in Tedix OS and grants NO cross-org
 * tool access (each gateway still enforces its own per-tenant consent). It lets a
 * per-gateway CLI login discover the user's other orgs without a second
 * account-level browser session.
 */
export const listAllMineContract = authedOrganizationsOs.listAllMine
	.use(
		withAuthorization(
			{
				handlerOwnedUserAuthorization:
					"The handler requires a human subject and enumerates only that subject's organization memberships.",
			},
			"apps:read",
		),
	)
	.handler(async ({ input, context }) => {
		const { db, user } = context as BaseContext & { user?: JWTPayload };
		const { activeOnly, limit = 50, offset = 0 } = input;

		if (!user?.sub) {
			throw createError(
				ErrorCodes.UNAUTHORIZED,
				"User authentication required",
			);
		}

		const memberships = await getUserOrganizationMemberships(db, user.sub, {
			activeOnly,
		});
		const gateways = await getOrganizationAggregatorGateways(
			db,
			memberships.map((m) => m.organizationId),
		);
		const gatewayFor = (
			organizationId: string,
		): { mcpGatewaySlug: string | null; mcpGatewayUrl: string | null } => {
			const gw = gateways.get(organizationId);
			if (!gw) return { mcpGatewaySlug: null, mcpGatewayUrl: null };
			return {
				mcpGatewaySlug: gw.slug,
				mcpGatewayUrl: gatewayUrl(
					gw,
					context.env.ENVIRONMENT,
					context.env.MCP_URL,
				),
			};
		};

		const paginatedMemberships = memberships.slice(offset, offset + limit);
		const total = memberships.length;

		return {
			data: paginatedMemberships.map((m) => ({
				member: {
					id: m.member.id,
					organizationId: m.member.organizationId,
					descopeUserId: m.member.descopeUserId,
					email: m.member.email,
					name: m.member.name,
					avatarUrl: m.member.avatarUrl,
					role: normalizeMemberRole(m.member.role),
					customPermissions: filterGrantableOverrides(
						m.member.customPermissions,
					),
					status: m.member.status,
					invitedAt: m.member.invitedAt,
					invitedBy: m.member.invitedBy,
					inviteAcceptedAt: m.member.inviteAcceptedAt,
					lastActiveAt: m.member.lastActiveAt,
					createdAt: m.member.createdAt,
					updatedAt: m.member.updatedAt,
				},
				organizationId: m.organizationId,
				organizationName: m.organizationName,
				organizationSlug: m.organizationSlug,
				organizationLogoUrl: m.organizationLogoUrl,
				organizationType: m.organizationType,
				descopeTenantId: m.descopeTenantId,
				appsCount: m.appsCount,
				tediCount: m.tediCount,
				...gatewayFor(m.organizationId),
			})),
			pagination: {
				limit,
				offset,
				total,
				hasMore: offset + paginatedMemberships.length < total,
			},
		};
	});

/**
 * Tenant-neutral apex launcher inventory. D1 membership is the authority and
 * the query owner applies both active-membership and features.os gates,
 * so the browser never receives non-launchable organizations to filter.
 */
export const listOsMineContract = authedOrganizationsOs.listOsMine
	.use(
		withAuthorization(
			{
				handlerOwnedUserAuthorization:
					"The handler requires a human subject and returns only that subject's active OS-provisioned memberships.",
			},
			"apps:read",
		),
	)
	.handler(async ({ input, context }) => {
		const { db, user } = context as BaseContext & { user?: JWTPayload };
		const { limit = 50, offset = 0 } = input;
		if (!user?.sub) {
			throw createError(
				ErrorCodes.UNAUTHORIZED,
				"User authentication required",
			);
		}

		const memberships = await getUserOsMemberships(db, user.sub);
		const data = memberships.slice(offset, offset + limit);
		return {
			data,
			pagination: {
				limit,
				offset,
				total: memberships.length,
				hasMore: offset + data.length < memberships.length,
			},
		};
	});

/**
 * Contract-based getMyOrganization procedure implementation
 * User-authenticated endpoint that ensures organization and member exist.
 * Used by the Tedix OS launcher bootstrap instead of syncFromDescope (no
 * service token needed).
 */
export const getMyOrganizationContract = authedOrganizationsOs.getMyOrganization
	// Any signed-in human may bootstrap their own organization. The handler
	// below rejects machine principals because they have no `user.sub`.
	.use(
		withAuthorization(
			{
				handlerOwnedUserAuthorization:
					"The handler binds organization bootstrap authority to the authenticated human subject.",
			},
			"apps:read",
		),
	)
	.handler(async ({ context }) => {
		const { db, user } = context as BaseContext & { user?: JWTPayload };

		// Require user JWT with Descope claims
		if (!user?.sub) {
			throw createError(
				ErrorCodes.UNAUTHORIZED,
				"User authentication required",
			);
		}

		if (!user.email) {
			throw createError(ErrorCodes.BAD_REQUEST, "Email claim missing from JWT");
		}

		const tenantId = getTenantId(user);

		// Ensure personal org exists for this user (bootstrap for new users,
		// idempotent for returning users)
		const personalResult = await ensurePersonalOrg(
			db,
			user.sub,
			user.name ?? undefined,
			user.email,
			user.iss,
			{
				settlementMode: resolveBillingSettlementMode(context.env),
				runtimeEntitlementGrants: resolveInstallationEntitlementGrants(
					context.env,
				),
			},
		);

		// If user has a tenant claim, sync org/member from the Descope tenant.
		// Otherwise, fall back to the personal org (new user bootstrap).
		let orgResult: {
			organization: typeof personalResult.organization;
			member: typeof personalResult.member;
		};
		let createdFlags = { organization: false, member: false };

		if (tenantId) {
			// Resolve the real Descope tenant name so a freshly-synced org gets a
			// meaningful name instead of one derived from the email domain (the
			// "Tedix" default-name drift class). Mirrors the syncFromDescope path.
			let tenantName: string | null = null;
			const mgmt = getDescopeManagement(context.env);
			if (mgmt) {
				try {
					const loaded = await mgmt.management.tenant.load(tenantId);
					if (loaded.ok && loaded.data?.name) {
						tenantName = loaded.data.name;
					}
				} catch (error) {
					console.warn(
						"[Organizations] Failed to load Descope tenant name (non-blocking):",
						error,
					);
				}
			}

			// Standard flow: user belongs to a Descope tenant, sync to D1
			const syncResult = await ensureOrgAndMember(db, {
				settlementMode: resolveBillingSettlementMode(context.env),
				runtimeEntitlementGrants: resolveInstallationEntitlementGrants(
					context.env,
				),
				descopeTenantId: tenantId,
				identityIssuer: user.iss,
				descopeUserId: user.sub,
				email: user.email,
				name: user.name ?? undefined,
				organizationName: tenantName ?? undefined,
				// First member is owner, others default to member
				role: memberRoleFromTenantRoles(getTenantRoles(user)),
			});
			orgResult = syncResult;
			createdFlags = syncResult.created;
		} else {
			// No tenant claim — new user, use personal org as primary
			orgResult = personalResult;
			createdFlags = {
				organization: personalResult.created,
				member: personalResult.created,
			};
		}

		// Always ensure the personal Descope tenant exists and the user is a
		// tenant member. This repairs partial D1-first signup attempts as well as
		// provisioning a brand-new identity.
		// This is idempotent — safe to run on every call, not just creation.
		// Fixes cases where D1 org exists but Descope tenant/association was lost
		// (e.g., initial signup failed due to CORS, network error, etc.)
		{
			const mgmt = getDescopeManagement(context.env);
			if (mgmt) {
				const personalTenantId = `personal_${user.sub}`;
				const personalName = user.name
					? `${user.name}'s Workspace`
					: "Personal Workspace";

				try {
					await ensurePersonalDescopeTenantMembership(mgmt, {
						fallbackLoginId: user.email,
						name: personalName,
						tenantId: personalTenantId,
						userId: user.sub,
					});
				} catch (error) {
					console.error(
						"[Organizations] Personal Descope membership provisioning failed:",
						error,
					);
					throw createError(
						ErrorCodes.SERVICE_UNAVAILABLE,
						"Personal workspace identity provisioning is incomplete. Please retry sign-in.",
					);
				}
			}
		}

		// Every workspace starts with one accountable worker. Keep this synchronous:
		// Home delegation, approved writes, and unified-gateway assignment all rely
		// on the default tedi being visible in the same launcher request cycle.
		let defaultTediCreated = false;
		try {
			defaultTediCreated = Boolean(
				await autoProvisionFirstTedi(
					db,
					context.env,
					orgResult.organization.id,
					user.name,
					user.sub,
				),
			);
		} catch (error) {
			console.error("[Organizations] Default tedi provisioning failed:", error);
			throw createError(
				ErrorCodes.SERVICE_UNAVAILABLE,
				"Workspace tedi provisioning is incomplete. Please retry sign-in.",
			);
		}

		// Repair organizations created before the default-tedi invariant. Their
		// unified gateway already exists, but its aggregateTedis projection was
		// finalized while the organization had no worker. Re-running the idempotent
		// gateway reconciler only when this request created the missing tedi keeps
		// ordinary launcher reads cheap while making the repair immediately usable.
		if (defaultTediCreated && orgResult.organization.features?.os === true) {
			const existingGateway = (
				await getOrganizationAggregatorGateways(db, [orgResult.organization.id])
			).get(orgResult.organization.id);
			try {
				await ensureOrganizationUnifiedGateway(db, context.env, {
					organizationId: orgResult.organization.id,
					organizationName: orgResult.organization.name,
					organizationSlug: orgResult.organization.slug,
					gatewaySlug: existingGateway?.slug,
				});
			} catch (error) {
				console.error(
					"[Organizations] Default tedi gateway repair failed:",
					error,
				);
				throw createError(
					ErrorCodes.SERVICE_UNAVAILABLE,
					"Workspace gateway assignment is incomplete. Please retry sign-in.",
				);
			}
		}

		return {
			organization: {
				id: orgResult.organization.id,
				name: orgResult.organization.name,
				slug: orgResult.organization.slug,
				type: (orgResult.organization.type ?? "organization") as
					| "personal"
					| "organization",
				descopeTenantId: orgResult.organization.descopeTenantId,
				logoUrl: orgResult.organization.logoUrl,
				description: orgResult.organization.description,
				appsCount: orgResult.organization.appsCount ?? null,
				features: orgResult.organization.features ?? null,
				metadata: orgResult.organization.metadata ?? null,
				createdAt: orgResult.organization.createdAt,
				updatedAt: orgResult.organization.updatedAt,
			},
			member: {
				id: orgResult.member.id,
				organizationId: orgResult.member.organizationId,
				descopeUserId: orgResult.member.descopeUserId,
				email: orgResult.member.email,
				name: orgResult.member.name,
				avatarUrl: orgResult.member.avatarUrl,
				role: normalizeMemberRole(orgResult.member.role),
				customPermissions: filterGrantableOverrides(
					orgResult.member.customPermissions,
				),
				status: orgResult.member.status,
				invitedAt: orgResult.member.invitedAt,
				invitedBy: orgResult.member.invitedBy,
				inviteAcceptedAt: orgResult.member.inviteAcceptedAt,
				lastActiveAt: orgResult.member.lastActiveAt,
				createdAt: orgResult.member.createdAt,
				updatedAt: orgResult.member.updatedAt,
			},
			created: createdFlags,
		};
	});

/**
 * Finish the account-level first run before a tenant OS origin exists.
 *
 * The apex launcher intentionally has no selected organization, so ordinary
 * `organizations.update` cannot authorize this call through context.orgId.
 * This procedure instead binds the write to the signed-in human's active D1
 * owner membership. It can only enable an organization the caller already
 * owns; hostname routing remains fail-closed until this write succeeds.
 */
export const completeOsOnboardingContract =
	authedOrganizationsOs.completeOsOnboarding
		.use(
			withAuthorization(
				{
					handlerOwnedUserAuthorization:
						"The handler proves active organization ownership from the signed-in human subject before enabling its OS origin.",
				},
				"apps:write",
			),
		)
		.handler(async ({ input, context }) => {
			const { db, user } = context as BaseContext & { user?: JWTPayload };
			if (!user?.sub || context.authType !== "user") {
				throw createError(
					ErrorCodes.UNAUTHORIZED,
					"User authentication required",
				);
			}

			const existing = await getOrganizationById(db, input.organizationId);
			if (!existing) {
				throw createError(ErrorCodes.NOT_FOUND, "Organization not found");
			}
			const membership = await getMemberByUserId(
				db,
				input.organizationId,
				user.sub,
			);
			if (membership?.status !== "active" || membership.role !== "owner") {
				throw createError(
					ErrorCodes.FORBIDDEN,
					"Only an active organization owner can complete Tedix OS onboarding",
				);
			}
			if (!existing.descopeTenantId) {
				throw createError(
					ErrorCodes.SERVICE_UNAVAILABLE,
					"Organization identity provisioning is incomplete. Retry onboarding after the Descope tenant is available.",
				);
			}

			// The gateway assignment created below is tedi-backed. Provision the
			// organization's default worker first so a brand-new tenant can delegate
			// and park Home write approvals immediately after onboarding.
			try {
				await autoProvisionFirstTedi(
					db,
					context.env,
					input.organizationId,
					user.name,
					user.sub,
				);
			} catch (error) {
				console.error(
					"[Organizations] OS onboarding default tedi provisioning failed:",
					error,
				);
				throw createError(
					ErrorCodes.SERVICE_UNAVAILABLE,
					"Workspace tedi provisioning is incomplete. Please retry onboarding.",
				);
			}

			if (input.slug !== existing.slug) {
				const available = await checkSlugAvailable(
					db,
					input.slug,
					input.organizationId,
				);
				if (!available) {
					throw createError(
						ErrorCodes.CONFLICT,
						`Workspace URL "${input.slug}.os.tedix.dev" is already taken`,
					);
				}
			}

			const existingGateway = (
				await getOrganizationAggregatorGateways(db, [input.organizationId])
			).get(input.organizationId);
			let gateway;
			try {
				// Onboarding is also a rename path: pinning the existing gateway
				// slug here is what used to leave a corrected handle pointing at
				// the old MCP address forever.
				gateway =
					(await renameOrganizationUnifiedGateway(db, context.env, {
						organizationId: input.organizationId,
						organizationName: input.name,
						currentGatewaySlug: existingGateway?.slug,
						nextOrganizationSlug: input.slug,
					})) ??
					(await ensureOrganizationUnifiedGateway(db, context.env, {
						organizationId: input.organizationId,
						organizationName: input.name,
						organizationSlug: input.slug,
					}));
			} catch (error) {
				if (error instanceof OrganizationGatewaySlugConflictError) {
					throw createError(ErrorCodes.CONFLICT, error.message);
				}
				console.error(
					"[Organizations] Unified MCP gateway provisioning failed:",
					error,
				);
				throw createError(
					ErrorCodes.SERVICE_UNAVAILABLE,
					"Workspace gateway provisioning is incomplete. Please retry onboarding.",
				);
			}

			const updated = await updateOrganization(db, input.organizationId, {
				name: input.name,
				slug: input.slug,
				features: {
					...existing.features,
					os: true,
				},
			});

			const mgmt = getDescopeManagement(context.env);
			if (mgmt) {
				try {
					await mgmt.management.tenant.update(
						existing.descopeTenantId,
						input.name,
					);
				} catch (error) {
					console.warn(
						"[Organizations] Failed to sync OS onboarding name to Descope:",
						error,
					);
				}
			}

			const { emitAuditEvent, auditActor } = await import("../audit-helpers");
			const actor = auditActor(context);
			await emitAuditEvent(db, {
				organizationId: input.organizationId,
				actorId: actor.actorId,
				actorType: actor.actorType,
				action: "organization.os_onboarding_completed",
				resourceType: "organization",
				resourceId: input.organizationId,
				metadata: {
					...actor.actorMetadata,
					name: input.name,
					slug: input.slug,
					gatewayAppId: gateway.appId,
					gatewaySlug: gateway.gatewaySlug,
					descopeResourceId: gateway.descopeResourceId,
				},
				ipAddress: context.headers.get("CF-Connecting-IP"),
				userAgent: context.headers.get("User-Agent"),
			});

			return mapOrgToContract(updated);
		});

/**
 * Contract-based delete procedure implementation
 */
/**
 * Phase 1 of two-phase offboarding — mark org cancelled.
 *
 * Reversible until phase 2 (retirement) fires. Stamps `metadata.cancelledAt` so
 * the retirement handler can compute grace-period elapsed time without a new
 * column. Audits as a platform-admin op when invoked cross-org.
 */
export const cancelOrganizationContract = authedOrganizationsOs.cancel
	.use(
		withAuthorization(
			{
				handlerOwnedUserAuthorization:
					"The handler requires tenant ownership or platform authority before cancelling an organization.",
			},
			"platform:admin",
		),
	)
	.handler(async ({ input, context }) => {
		const { db } = context;
		const { organizationId, reason } = input;

		if (!isPlatformPrincipal(context)) {
			requireOrganizationAccess(context, organizationId);
			const role = context.userRole;
			if (role !== "owner") {
				throw createError(
					ErrorCodes.FORBIDDEN,
					"Only organization owners can cancel organizations",
				);
			}
		}

		const org = await getOrganizationById(db, organizationId);
		if (!org) {
			throw createError(ErrorCodes.NOT_FOUND, "Organization not found");
		}

		const now = new Date().toISOString();
		const existingMetadata =
			(org.metadata as Record<string, unknown> | null) ?? {};
		const updated = await updateOrganization(db, organizationId, {
			metadata: {
				...existingMetadata,
				cancelledAt: now,
				cancelReason: reason ?? null,
			} as typeof org.metadata,
		});

		const { emitAuditEvent, auditActor } = await import("../audit-helpers");
		const actor = auditActor(context);
		await emitAuditEvent(db, {
			organizationId,
			actorId: actor.actorId,
			actorType: actor.actorType,
			action: "organization.cancelled",
			resourceType: "organization",
			resourceId: organizationId,
			metadata: { ...actor.actorMetadata, reason, cancelledAt: now },
			ipAddress: context.headers.get("CF-Connecting-IP"),
			userAgent: context.headers.get("User-Agent"),
		});

		return mapOrgToContract(updated);
	});

const ORG_OFFBOARDING_GRACE_DAYS = 14;

export const deleteOrganizationContract = authedOrganizationsOs.delete
	.use(
		withAuthorization(
			{
				handlerOwnedUserAuthorization:
					"The handler requires platform authority or tenant ownership, with step-up for tenant retirement.",
			},
			"platform:admin",
		),
	)
	.handler(async ({ input, context }) => {
		const { db } = context;
		const { organizationId, force } = input;

		requireForceDeleteAuthority(context, force);

		// Platform-admin principals (User JWT with platform-admin role, or API key
		// with platform:admin scope) can retire any org. Required for offboarding
		// scripts that wind down a customer org from a Tedix-org automation key.
		if (!isPlatformPrincipal(context)) {
			requireOrganizationAccess(context, organizationId);

			// Require owner for retirement (scoped callers only — platform-admin bypasses)
			const role = context.userRole;
			if (role !== "owner") {
				throw createError(
					ErrorCodes.FORBIDDEN,
					"Only organization owners can retire organizations",
				);
			}

			requireStepUp(context, "Retiring an organization");
		}

		const org = await getOrganizationById(db, organizationId);
		if (!org) {
			throw createError(ErrorCodes.NOT_FOUND, "Organization not found");
		}
		if ((org.metadata as { retiredAt?: string } | null)?.retiredAt) {
			return { success: true as const };
		}

		// Two-phase offboarding: require force=true OR org cancelled >= grace period.
		// Without this gate, a single mis-clicked offboard removes tenant access.
		if (!force) {
			const cancelledAt = (org.metadata as { cancelledAt?: string } | null)
				?.cancelledAt;
			if (!cancelledAt) {
				throw createError(
					ErrorCodes.BAD_REQUEST,
					`Organization must be cancelled first (call /organizations/${organizationId}/cancel) or pass force=true.`,
				);
			}
			const cancelledDate = new Date(cancelledAt);
			const graceMs = ORG_OFFBOARDING_GRACE_DAYS * 24 * 60 * 60 * 1000;
			if (Date.now() - cancelledDate.getTime() < graceMs) {
				const remainingDays = Math.ceil(
					(graceMs - (Date.now() - cancelledDate.getTime())) /
						(24 * 60 * 60 * 1000),
				);
				throw createError(
					ErrorCodes.BAD_REQUEST,
					`Grace period not elapsed — ${remainingDays} day(s) remaining. Pass force=true to override.`,
				);
			}
		}

		const { emitAuditEvent, auditActor } = await import("../audit-helpers");
		const actor = auditActor(context);

		// FGA cleanup: delete every app's relation rows in Descope FGA before D1
		// retirement. FGA isn't tenant-scoped, so a tenant retirement leaves grants
		// pointing at dead UUIDs — they pollute the FGA cache and confuse audit
		// queries. Non-blocking; D1 retirement proceeds even if FGA cleanup fails.
		const orgApps = await getAppsByOrganization(db, organizationId).catch(
			() => [] as Array<{ id: string }>,
		);
		const appIds = orgApps.map((a) => a.id);
		if (appIds.length > 0) {
			const mgmt = getDescopeManagement(context.env);
			if (mgmt) {
				try {
					await deleteAllAppRelations(mgmt, appIds);
				} catch (error) {
					console.warn(
						"[Organizations] Failed to clean FGA relations on retirement (non-blocking):",
						error,
					);
				}
			}
		}

		const retiredAt = new Date().toISOString();
		const retired = await retireOrganization(db, {
			id: organizationId,
			retiredAt,
			retiredBy: actor.actorId,
			features: { ...org.features, os: false },
			metadata: {
				...((org.metadata as Record<string, unknown> | null) ?? {}),
				retiredAt,
				retiredSlug: org.slug,
				memoryRetained: true,
			},
		});
		if (!retired) {
			throw createError(
				ErrorCodes.CONFLICT,
				"Organization was retired concurrently by another request",
			);
		}

		await emitAuditEvent(db, {
			organizationId,
			actorId: actor.actorId,
			actorType: actor.actorType,
			action: "organization.retired",
			resourceType: "organization",
			resourceId: organizationId,
			metadata: {
				...actor.actorMetadata,
				force,
				disabledAppCount: appIds.length,
				descopeTenantId: org.descopeTenantId ?? null,
				retiredAt,
				retiredSlug: org.slug,
				memoryRetained: true,
			},
			ipAddress: context.headers.get("CF-Connecting-IP"),
			userAgent: context.headers.get("User-Agent"),
		});

		// Delete Descope tenant if linked (non-blocking)
		if (org.descopeTenantId) {
			const mgmt = getDescopeManagement(context.env);
			if (mgmt) {
				try {
					await mgmt.management.tenant.delete(org.descopeTenantId);
				} catch (error) {
					console.warn(
						"[Organizations] Failed to delete Descope tenant:",
						error,
					);
				}
			}
		}

		return { success: true as const };
	});

/**
 * Contract-based syncFromDescope procedure implementation
 * Uses service auth for MCP/platform synchronization callers.
 *
 * Input fields use descopeTenantId/descopeUserId directly.
 *
 * SECURITY: Protected by withServiceAuth
 * This prevents unauthorized access even though it's tagged as 'internal'
 */
export const syncFromDescopeContract = organizationsOs.syncFromDescope
	.use(withServiceAuth)
	.handler(async ({ input, context }) => {
		const { db } = context;
		const {
			descopeTenantId,
			descopeUserId,
			email,
			name,
			role = "member",
		} = input;
		const identityIssuer = descopeIssuer(
			context.env.DESCOPE_PROJECT_ID,
			context.env.DESCOPE_BASE_URL,
		);
		const tenantIdentity = {
			provider: "descope",
			issuer: identityIssuer,
			subject: descopeTenantId,
		};

		// Find or create organization by Descope tenant ID
		let org =
			(await getOrganizationByExternalIdentity(db, tenantIdentity)) ??
			(await getOrganizationByDescopeId(db, descopeTenantId));

		if (!org) {
			// Resolve the real Descope tenant name so the new org gets a meaningful
			// name/slug instead of one derived from the opaque tenant id. The SDK
			// client already honors DESCOPE_BASE_URL, so no raw fetch is needed.
			let tenantName: string | null = null;
			const mgmt = getDescopeManagement(context.env);
			if (mgmt) {
				try {
					const loaded = await mgmt.management.tenant.load(descopeTenantId);
					if (loaded.ok && loaded.data?.name) {
						tenantName = loaded.data.name;
					}
				} catch (error) {
					console.warn(
						"[Organizations] Failed to load Descope tenant name (non-blocking):",
						error,
					);
				}
			}

			// Create organization with Descope tenant ID
			const slug = await generateUniqueSlug(db, tenantName ?? descopeTenantId);
			org = await createOrganization(
				db,
				{
					name: tenantName ?? `Organization ${descopeTenantId.slice(-8)}`,
					slug,
					descopeTenantId,
				},
				{
					settlementMode: resolveBillingSettlementMode(context.env),
					runtimeEntitlementGrants: resolveInstallationEntitlementGrants(
						context.env,
					),
				},
			);
		}
		await bindOrganizationExternalIdentity(db, org.id, tenantIdentity);

		// Upsert user record
		const canonicalUser = await upsertUserForExternalIdentity(db, {
			identity: {
				provider: "descope",
				issuer: identityIssuer,
				subject: descopeUserId,
			},
			email,
			name: name ?? email.split("@")[0],
		});

		// Find or create member
		let member =
			(await getMemberByCanonicalUserId(db, org.id, canonicalUser.id)) ??
			(await getMemberByUserId(db, org.id, descopeUserId));

		if (!member) {
			// Add member to organization
			member = await addMember(db, {
				organizationId: org.id,
				userId: canonicalUser.id,
				descopeUserId,
				email,
				name: name ?? email.split("@")[0],
				role: role as "owner" | "admin" | "member" | "viewer",
				status: "active",
				invitedAt: new Date().toISOString(),
				inviteAcceptedAt: new Date().toISOString(),
			});
		} else {
			// Sync member info: propagate name/email changes and reactivate if needed
			const memberName = name ?? email.split("@")[0];
			const updates: Record<string, string> = {};
			if (memberName && memberName !== member.name) updates.name = memberName;
			if (email && email !== member.email) updates.email = email;
			if (member.status !== "active") {
				updates.status = "active";
				updates.inviteAcceptedAt = new Date().toISOString();
			}
			if (member.userId !== canonicalUser.id) {
				updates.userId = canonicalUser.id;
			}
			if (Object.keys(updates).length > 0) {
				member = await updateMember(db, member.id, updates);
			}
		}

		return {
			organization: {
				id: org.id,
				name: org.name,
				slug: org.slug,
				descopeTenantId: org.descopeTenantId,
				logoUrl: org.logoUrl,
				description: org.description,
				appsCount: null, // Not available during sync
				features: null, // Not available during sync
				metadata: null, // Not available during sync
				createdAt: org.createdAt,
				updatedAt: org.updatedAt,
			},
			member: {
				id: member.id,
				organizationId: member.organizationId,
				descopeUserId: member.descopeUserId,
				email: member.email,
				name: member.name,
				avatarUrl: member.avatarUrl,
				role: member.role,
				customPermissions: filterGrantableOverrides(member.customPermissions),
				status: member.status,
				invitedAt: member.invitedAt,
				invitedBy: member.invitedBy,
				inviteAcceptedAt: member.inviteAcceptedAt,
				lastActiveAt: member.lastActiveAt,
				createdAt: member.createdAt,
				updatedAt: member.updatedAt,
			},
		};
	});

/**
 * Contract-based getFeatures procedure implementation
 */
export const getFeaturesContract = authedOrganizationsOs.getFeatures
	.use(AUTHZ.appsRead)
	.handler(async ({ input, context }) => {
		const { db } = context;
		const { organizationId } = input;

		requireOrganizationAccess(context, organizationId);

		const features = await getOrganizationFeatures(db, organizationId);
		if (!features) {
			throw createError(ErrorCodes.NOT_FOUND, "Organization not found");
		}

		return features;
	});

export const repairCmsDomainEntitlementContract =
	authedOrganizationsOs.repairCmsDomainEntitlement
		.use(
			withAuthorization(
				{
					handlerOwnedUserAuthorization:
						"The handler requires platform authority before changing another organization's plan feature snapshot.",
				},
				"platform:admin",
			),
		)
		.handler(async ({ input, context }) => {
			if (!isPlatformPrincipal(context))
				throw createError(ErrorCodes.FORBIDDEN, "Platform authority required");

			const { organizationId } = input;
			const [organization, entitlement] = await Promise.all([
				getOrganizationById(context.db, organizationId),
				getBillingEntitlement(context.db, organizationId),
			]);
			if (!organization || !entitlement)
				throw createError(
					ErrorCodes.NOT_FOUND,
					"Organization or billing plan not found",
				);
			if (
				entitlement.account.status !== "active" ||
				!DEFAULT_ORGANIZATION_FEATURES_BY_PLAN[entitlement.plan.planKey]
					?.customDomain
			)
				throw createError(
					ErrorCodes.FORBIDDEN,
					"The active billing plan does not include custom domains",
				);

			// Remove the stale Starter snapshot value instead of pinning `true`.
			// The billing plan then remains authoritative after a later downgrade.
			const repaired = organization.features?.customDomain === false;
			if (repaired) {
				const features = { ...organization.features };
				delete features.customDomain;
				await updateOrganization(context.db, organizationId, { features });
				const { emitAuditEvent, auditActor } = await import("../audit-helpers");
				const actor = auditActor(context);
				await emitAuditEvent(context.db, {
					organizationId,
					actorId: actor.actorId,
					actorType: actor.actorType,
					action: "organization.cms_domain_entitlement_repaired",
					resourceType: "organization",
					resourceId: organizationId,
					metadata: {
						...actor.actorMetadata,
						planKey: entitlement.plan.planKey,
						previousValue: organization.features?.customDomain ?? null,
					},
					ipAddress: context.headers.get("CF-Connecting-IP"),
					userAgent: context.headers.get("User-Agent"),
				});
			}

			return {
				organizationId,
				planKey: entitlement.plan.planKey as "business" | "enterprise",
				customDomain: true as const,
				repaired,
			};
		});

/**
 * Contract-based canCreateApp procedure implementation
 */
export const canCreateAppContract = authedOrganizationsOs.canCreateApp
	.use(AUTHZ.appsRead)
	.handler(async ({ input, context }) => {
		const { db } = context;
		const { organizationId } = input;

		requireOrganizationAccess(context, organizationId);

		return canCreateAppDb(db, organizationId);
	});

/**
 * Contract-based isSlugAvailable procedure implementation
 */
export const isSlugAvailableContract = authedOrganizationsOs.isSlugAvailable
	// Availability is safe for every signed-in user; machine callers must at
	// least carry the ordinary organization-read scope.
	.use(
		withAuthorization(
			{
				handlerOwnedUserAuthorization:
					"Slug availability is intentionally role-free metadata for authenticated human users.",
			},
			"apps:read",
		),
	)
	.handler(async ({ input, context }) => {
		const { db } = context;
		const { slug } = input;

		const available = await checkSlugAvailable(db, slug);
		return { available };
	});

// =============================================================================
// SSO (DESCOPE S4) PROCEDURES
// =============================================================================

const SSO_AUTH_TYPES = new Set(["none", "saml", "oidc"]);

function normalizeAuthType(value: unknown): "none" | "saml" | "oidc" | null {
	if (typeof value === "string" && SSO_AUTH_TYPES.has(value)) {
		return value as "none" | "saml" | "oidc";
	}
	return null;
}

async function loadSsoStatus(
	context: BaseContext,
	descopeTenantId: string,
): Promise<{
	enabled: boolean;
	authType: "none" | "saml" | "oidc" | null;
	disabledFeatures: Record<string, boolean | undefined> | null;
	styleId: string | null;
}> {
	const mgmt = getDescopeManagement(context.env);
	if (!mgmt) {
		throw createError(
			ErrorCodes.INTERNAL_SERVER_ERROR,
			"Descope management API unavailable",
		);
	}
	const result = await mgmt.management.tenant.getSettings(descopeTenantId);
	if (!result.ok || !result.data) {
		throw createError(
			ErrorCodes.INTERNAL_SERVER_ERROR,
			result.error?.errorMessage ?? "Failed to load Descope tenant settings",
		);
	}
	const settings = result.data as Record<string, unknown>;
	const sso = settings.ssoSetupSuiteSettings as
		| Record<string, unknown>
		| undefined;
	return {
		enabled: Boolean(sso?.enabled),
		authType: normalizeAuthType(settings.authType),
		disabledFeatures:
			(sso?.disabledFeatures as Record<string, boolean | undefined>) ?? null,
		styleId: typeof sso?.styleId === "string" ? sso.styleId : null,
	};
}

async function getOrgWithDescopeTenant(
	context: BaseContext,
	organizationId: string,
): Promise<{ tenantId: string }> {
	requireOrganizationAccess(context, organizationId);
	requireAdminOrOwner(context);

	const org = await getOrganizationById(context.db, organizationId);
	if (!org) {
		throw createError(ErrorCodes.NOT_FOUND, "Organization not found");
	}
	if (!org.descopeTenantId) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"Organization has no Descope tenant — SSO requires a synced tenant",
		);
	}
	return { tenantId: org.descopeTenantId };
}

export const getSsoStatusContract = authedOrganizationsOs.getSsoStatus
	.use(withAuthorization("settings:manage", "platform:admin"))
	.handler(async ({ input, context }) => {
		const { tenantId } = await getOrgWithDescopeTenant(
			context,
			input.organizationId,
		);
		return loadSsoStatus(context, tenantId);
	});

export const configureSsoContract = authedOrganizationsOs.configureSso
	.use(withAuthorization("settings:manage", "platform:admin"))
	.handler(async ({ input, context }) => {
		const { tenantId } = await getOrgWithDescopeTenant(
			context,
			input.organizationId,
		);
		const mgmt = getDescopeManagement(context.env);
		if (!mgmt) {
			throw createError(
				ErrorCodes.INTERNAL_SERVER_ERROR,
				"Descope management API unavailable",
			);
		}

		// Read current settings so we don't clobber unrelated TenantSettings
		// fields when writing the SSO subsection.
		const current = await mgmt.management.tenant.getSettings(tenantId);
		if (!current.ok || !current.data) {
			throw createError(
				ErrorCodes.INTERNAL_SERVER_ERROR,
				current.error?.errorMessage ??
					"Failed to load existing tenant settings before SSO update",
			);
		}

		const currentRecord = current.data as Record<string, unknown>;
		const existingSso =
			(currentRecord.ssoSetupSuiteSettings as Record<string, unknown>) ?? {};
		const merged = {
			...currentRecord,
			ssoSetupSuiteSettings: {
				...existingSso,
				...input.settings,
			},
		};

		const update = await mgmt.management.tenant.configureSettings(
			tenantId,
			merged as Parameters<typeof mgmt.management.tenant.configureSettings>[1],
		);
		if (!update.ok) {
			throw createError(
				ErrorCodes.INTERNAL_SERVER_ERROR,
				update.error?.errorMessage ?? "Failed to configure SSO settings",
			);
		}

		return loadSsoStatus(context, tenantId);
	});

export const generateSsoSetupLinkContract =
	authedOrganizationsOs.generateSsoSetupLink
		.use(withAuthorization("settings:manage", "platform:admin"))
		.handler(async ({ input, context }) => {
			const { tenantId } = await getOrgWithDescopeTenant(
				context,
				input.organizationId,
			);
			const mgmt = getDescopeManagement(context.env);
			if (!mgmt) {
				throw createError(
					ErrorCodes.INTERNAL_SERVER_ERROR,
					"Descope management API unavailable",
				);
			}

			const result = await mgmt.management.tenant.generateSSOConfigurationLink(
				tenantId,
				input.expireDuration,
				undefined,
				input.email,
			);
			if (!result.ok || !result.data?.adminSSOConfigurationLink) {
				throw createError(
					ErrorCodes.INTERNAL_SERVER_ERROR,
					result.error?.errorMessage ?? "Failed to generate SSO setup link",
				);
			}
			return { url: result.data.adminSSOConfigurationLink };
		});

/**
 * Contract-based router using os.router() pattern
 * This enforces that all procedures match the contract
 *
 * Note: Uses base implementer (organizationsOs) to allow mixed auth:
 * - Most procedures use authedOrganizationsOs (user auth)
 * - syncFromDescope uses service auth
 */
export const organizationsContractRouter = organizationsOs.router({
	listMcpAuthorizations: listMcpAuthorizationsContract,
	disableMcpAuthorization: disableMcpAuthorizationContract,
	stageMultiOrgMcpConsent: stageHumanMcpConsentContract,
	revokeMultiOrgMcpConsent: revokeHumanMcpConsentContract,
	verifyMultiOrgMcpGrant: verifyHumanMcpGrantContract,
	resolveCliWorkspace: resolveCliWorkspaceContract,
	listMine: listMineContract,
	listAllMine: listAllMineContract,
	listOsMine: listOsMineContract,
	getMyOrganization: getMyOrganizationContract,
	completeOsOnboarding: completeOsOnboardingContract,
	list: listOrganizations,
	get: getOrganization,
	getBySlug: getOrganizationBySlugContract,
	isSlugAvailable: isSlugAvailableContract,
	create: createOrganizationContract,
	update: updateOrganizationContract,
	cancel: cancelOrganizationContract,
	delete: deleteOrganizationContract,
	syncFromDescope: syncFromDescopeContract,
	getFeatures: getFeaturesContract,
	repairCmsDomainEntitlement: repairCmsDomainEntitlementContract,
	canCreateApp: canCreateAppContract,
	listApiKeys: listApiKeysContract,
	createApiKey: createApiKeyContract,
	revokeApiKey: revokeApiKeyContract,
	deleteApiKey: deleteApiKeyContract,
	rotateApiKey: rotateApiKeyContract,
	getExpiringKeys: getExpiringKeysContract,
	getSsoStatus: getSsoStatusContract,
	configureSso: configureSsoContract,
	generateSsoSetupLink: generateSsoSetupLinkContract,
});

// =============================================================================
// HELPERS
// =============================================================================

export function requireOrganizationAccess(
	context: BaseContext,
	organizationId: string,
): void {
	const contextOrgId = context.organizationId;
	if (!contextOrgId || contextOrgId !== organizationId) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Organization access denied for this resource",
		);
	}
}

function requireAdminOrOwner(context: BaseContext): void {
	const role = context.userRole;
	if (!role || !["admin", "owner"].includes(role)) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Only admins and owners can perform this action",
		);
	}
}

/**
 * Reject a key that would carry more authority than the caller may delegate.
 *
 * The deny-list is `PLATFORM_ONLY_API_KEY_SCOPES` in the contract, NOT a local
 * literal, because the OS admin scope picker builds itself by subtracting
 * the same constant. When the two were written separately the picker offered
 * `["*"]` unconditionally and this guard refused it, so an ordinary tenant
 * admin could not create an API key at all.
 */
/**
 * Overrides as the guards see them.
 *
 * `userHoldsPermission` filters this column to `TENANT_GRANTABLE_PERMISSIONS`
 * before honoring it, so every surface that REPORTS it must apply the same
 * filter — otherwise the product would show authority the API ignores, which is
 * the defect this whole model unification removes.
 */
function filterGrantableOverrides(
	value: unknown,
): OrganizationPermission[] | null {
	if (!Array.isArray(value)) return null;
	return value.filter(
		(entry): entry is OrganizationPermission =>
			typeof entry === "string" && isTenantGrantablePermission(entry),
	);
}

function assertDelegatableApiKeyScopes(
	context: BaseContext,
	scopes: readonly string[],
): void {
	if (isPlatformPrincipal(context)) return;
	const forbidden = scopes.filter((scope) =>
		(PLATFORM_ONLY_API_KEY_SCOPES as readonly string[]).includes(scope),
	);
	if (forbidden.length > 0) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			`Platform authority is required to mint a key with: ${forbidden.join(", ")}`,
		);
	}
}

function requireForceDeleteAuthority(
	context: BaseContext,
	force: boolean,
): void {
	if (force && !isPlatformPrincipal(context)) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"force=true requires platform-admin authority",
		);
	}
}

export const __organizationsTest = {
	assertDelegatableApiKeyScopes,
	ensurePersonalDescopeTenantMembership,
	gatewayUrl,
	requireForceDeleteAuthority,
};

// Type export for the contract router
