/** oRPC organizations router: CRUD, provisioning, features and the router assembly. */
import { assertDescopeOk } from "@tedix/auth/descope";
import { installDefaultWorkApps } from "../../services/default-work-apps";
import {
	getDataResidency,
	setDataResidency,
	listResidencyProviderCatalog,
	publishResidencyProviderVersion,
} from "./organization-residency";
import { getDescopeManagement } from "../../lib/descope-management";
import { validateEmbeddedTediSelection } from "../../services/embedded-tedi-selection";
import type { CreateOrganizationInput } from "@tedix/api-contract/schemas/organization";
import { descopeIssuer } from "@tedix/auth/principal-identity";
import type { JWTPayload } from "@tedix/auth/types";
import { isPlatformPrincipal } from "@tedix/auth/types";
import { getBillingEntitlement } from "@tedix/db/queries/billing/plans";
import {
	addMember,
	getMemberByUserId,
	getOrganizationAggregatorGateways,
} from "@tedix/db/queries/organization-members";
import {
	bindOrganizationExternalIdentity,
	canCreateApp as canCreateAppDb,
	isSlugAvailable as checkSlugAvailable,
	createOrganization,
	generateUniqueSlug,
	getOrganizationByDescopeId,
	getOrganizationById,
	getOrganizationBySlug,
	getOrganizationFeatures,
	listOrganizations as listOrganizationsDb,
	listOrganizationWidgetQuotaStatus as listOrganizationWidgetQuotaStatusDb,
	updateOrganization,
} from "@tedix/db/queries/organizations";
import { invalidateKernelContextCache } from "../../kernel/context-cache";
import { upsertUserForExternalIdentity } from "@tedix/db/queries/users";
import { DEFAULT_ORGANIZATION_FEATURES_BY_PLAN } from "@tedix/db/schema/organizations";
import {
	resolveBillingSettlementMode,
	resolveInstallationEntitlementGrants,
} from "../../lib/billing-settlement-mode";
import {
	OrganizationGatewaySlugConflictError,
	renameOrganizationUnifiedGateway,
} from "../../lib/organization-mcp-gateway";
import { autoProvisionFirstTedi } from "../../lib/tedi-provisioning";
import {
	AUTHZ,
	type BaseContext,
	createError,
	ErrorCodes,
	withAuthorization,
} from "../orpc";
import {
	descopeTenantRolesForMemberRole,
	ensurePersonalDescopeTenantMembership,
} from "./organizations-descope-membership";
import {
	organizationsOs,
	authedOrganizationsOs,
	requireOrganizationAccess,
	requireAdminOrOwner,
	gatewayUrl,
	mapOrgToContract,
} from "./organizations-base";
import {
	listMcpAuthorizationsContract,
	disableMcpAuthorizationContract,
	stageHumanMcpConsentContract,
	revokeHumanMcpConsentContract,
	verifyHumanMcpGrantContract,
	resolveCliWorkspaceContract,
} from "./organizations-mcp-authorizations";
import {
	listApiKeysContract,
	createApiKeyContract,
	revokeApiKeyContract,
	deleteApiKeyContract,
	rotateApiKeyContract,
	getExpiringKeysContract,
	assertDelegatableApiKeyScopes,
} from "./organizations-api-keys";
import {
	listMineContract,
	listAllMineContract,
	listOsMineContract,
	getMyOrganizationContract,
	completeOsOnboardingContract,
} from "./organizations-mine";
import {
	cancelOrganizationContract,
	deleteOrganizationContract,
	syncFromDescopeContract,
	requireForceDeleteAuthority,
} from "./organizations-lifecycle";
import {
	getSsoStatusContract,
	configureSsoContract,
	generateSsoSetupLinkContract,
} from "./organizations-sso";

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
 * Platform-operator drift read. Unlike `list`, machine principals holding
 * platform:admin (a background tedi run) are admitted: the projection carries
 * only the widget turn quota, never a general organization inventory.
 */
export const listWidgetQuotaStatus = authedOrganizationsOs.listWidgetQuotaStatus
	.use(AUTHZ.platformAdmin)
	.handler(async ({ context }) => ({
		organizations: await listOrganizationWidgetQuotaStatusDb(context.db),
	}));

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

	if (mgmt && !existingProviderOrg?.descopeTenantId) {
		assertDescopeOk(
			await mgmt.management.tenant.updateDefaultRoles(descopeTenantId, [
				"member",
			]),
			"tenant.updateDefaultRoles",
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
	if (mgmt && descopeTenantId) {
		assertDescopeOk(
			await mgmt.management.user.addTenantRoles(
				userId,
				descopeTenantId,
				descopeTenantRolesForMemberRole("owner"),
			),
			"user.addTenantRoles",
		);
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

	await installDefaultWorkApps(db, org.id, { kind: "user", id: userId });
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
		if (
			updates.metadata?.portfolioBuckets !== undefined &&
			context.userRole !== "owner"
		) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Only the organization owner can change portfolio sections",
			);
		}

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
		// Sync the tenant name with a partial update.
		if (existing.descopeTenantId && updates.name) {
			const mgmt = getDescopeManagement(context.env);
			if (mgmt) {
				assertDescopeOk(
					await mgmt.management.tenant.patchTenant(existing.descopeTenantId, {
						name: updates.name ?? existing.name,
					}),
					"tenant.patchTenant",
				);
			}
		}

		const updated = await updateOrganization(db, organizationId, {
			...updates,
			...(updates.metadata
				? { metadata: { ...(existing.metadata ?? {}), ...updates.metadata } }
				: {}),
		});

		invalidateKernelContextCache(
			context,
			organizationId,
			"organization.updated",
		);

		return mapOrgToContract(updated);
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

/**
 * Contract-based router using os.router() pattern
 * This enforces that all procedures match the contract
 *
 * Note: Uses base implementer (organizationsOs) to allow mixed auth:
 * - Most procedures use authedOrganizationsOs (user auth)
 * - syncFromDescope uses service auth
 */
export const organizationsContractRouter = organizationsOs.router({
	getDataResidency,
	setDataResidency,
	listResidencyProviderCatalog,
	publishResidencyProviderVersion,
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
	listWidgetQuotaStatus,
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

export const __organizationsTest = {
	assertDelegatableApiKeyScopes,
	ensurePersonalDescopeTenantMembership,
	gatewayUrl,
	requireForceDeleteAuthority,
};

// Type export for the contract router
