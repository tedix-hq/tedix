/** Organization offboarding lifecycle: cancel, delete and syncFromDescope. */
import { assertDescopeOk } from "@tedix/auth/descope";
import { getDescopeManagement } from "../../lib/descope-management";
import { deleteAllAppRelations } from "@tedix/auth/fga";
import { descopeIssuer } from "@tedix/auth/principal-identity";
import { isPlatformPrincipal } from "@tedix/auth/types";
import { getAppsByOrganization } from "@tedix/db/queries/apps";
import {
	addMember,
	getMemberByCanonicalUserId,
	getMemberByUserId,
	updateMember,
} from "@tedix/db/queries/organization-members";
import {
	bindOrganizationExternalIdentity,
	createOrganization,
	generateUniqueSlug,
	getOrganizationByDescopeId,
	getOrganizationByExternalIdentity,
	getOrganizationById,
	retireOrganization,
	updateOrganization,
} from "@tedix/db/queries/organizations";
import { upsertUserForExternalIdentity } from "@tedix/db/queries/users";
import {
	resolveBillingSettlementMode,
	resolveInstallationEntitlementGrants,
} from "../../lib/billing-settlement-mode";
import {
	type BaseContext,
	createError,
	ErrorCodes,
	withAuthorization,
	withServiceAuth,
} from "../orpc";
import { requireStepUp } from "../step-up";
import {
	requireOrganizationAccess,
	mapOrgToContract,
	filterGrantableOverrides,
} from "./organizations-base";
import { organizationsOs, authedOrganizationsOs } from "./organizations-base";

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

		// Keep retirement retryable until the linked tenant is deleted.
		if (org.descopeTenantId) {
			const mgmt = getDescopeManagement(context.env, true);
			assertDescopeOk(
				await mgmt.management.tenant.delete(org.descopeTenantId),
				"tenant.delete",
			);
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

export function requireForceDeleteAuthority(
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
