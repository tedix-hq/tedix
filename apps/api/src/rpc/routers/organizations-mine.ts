/** Caller-scoped organization reads: listMine, listAllMine, listOsMine, getMyOrganization and OS onboarding. */
import { assertDescopeOk } from "@tedix/auth/descope";
import { installDefaultWorkApps } from "../../services/default-work-apps";
import { getDescopeManagement } from "../../lib/descope-management";
import { descopeProjectUserIdentity } from "@tedix/auth/principal-identity";
import type { JWTPayload } from "@tedix/auth/types";
import { getTenantId, getTenantRoles } from "@tedix/auth/types";
import {
	getMemberByCanonicalUserId,
	getMemberByUserId,
	getOrganizationAggregatorGateways,
	getUserOrganizationMemberships,
	getUserOsMemberships,
} from "@tedix/db/queries/organization-members";
import {
	ensureOrgAndMember,
	ensurePersonalOrg,
} from "@tedix/db/queries/organization-sync";
import {
	isSlugAvailable as checkSlugAvailable,
	getOrganizationById,
	updateOrganization,
} from "@tedix/db/queries/organizations";
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
	type BaseContext,
	createError,
	ErrorCodes,
	withAuthorization,
} from "../orpc";
import {
	ensurePersonalDescopeTenantMembership,
	memberRoleFromTenantRoles,
	normalizeMemberRole,
} from "./organizations-descope-membership";
import {
	filterGrantableOverrides,
	filterMembershipsByLiveDescopeTenants,
	gatewayUrl,
	mapOrgToContract,
} from "./organizations-base";
import { authedOrganizationsOs } from "./organizations-base";

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

		if (context.oidcScopes !== undefined) {
			if (!context.organizationId || !context.userId)
				throw createError(ErrorCodes.FORBIDDEN, "OIDC organization required");
			const organization = await getOrganizationById(
				db,
				context.organizationId,
			);
			const member = await getMemberByCanonicalUserId(
				db,
				context.organizationId,
				context.userId,
			);
			if (!organization || member?.status !== "active")
				throw createError(ErrorCodes.FORBIDDEN, "Active membership required");
			return {
				organization: mapOrgToContract(organization),
				member: {
					...member,
					role: normalizeMemberRole(member.role),
					customPermissions: filterGrantableOverrides(member.customPermissions),
				},
				created: { organization: false, member: false },
			};
		}

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
		// A Connect (agentic app) token names the same human by an app issuer;
		// bind under the project issuer like every other login, or the lookup
		// misses and the bootstrap collides with the existing user's email.
		const identityIssuer = descopeProjectUserIdentity(user, {
			projectId: context.env.DESCOPE_PROJECT_ID,
			baseUrl: context.env.DESCOPE_BASE_URL,
		}).issuer;

		// Ensure personal org exists for this user (bootstrap for new users,
		// idempotent for returning users)
		const personalResult = await ensurePersonalOrg(
			db,
			user.sub,
			user.name ?? undefined,
			user.email,
			identityIssuer,
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
				identityIssuer,
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

			const mgmt = getDescopeManagement(context.env);
			if (mgmt) {
				assertDescopeOk(
					await mgmt.management.tenant.patchTenant(existing.descopeTenantId, {
						name: input.name,
					}),
					"tenant.patchTenant",
				);
			}

			await installDefaultWorkApps(db, input.organizationId, {
				kind: "user",
				id: user.sub,
			});
			const updated = await updateOrganization(db, input.organizationId, {
				name: input.name,
				slug: input.slug,
				features: {
					...existing.features,
					os: true,
				},
			});

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
