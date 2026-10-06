/**
 * Organization Sync Helpers
 * Idempotent sync functions for Descope → Tedix org/member creation
 *
 * Used by:
 * - API auth middleware (auto-sync on JWT validation)
 * - OS launcher bootstrap (via getMyOrganization endpoint)
 * - MCP service (via syncFromDescope endpoint)
 */

import type { DbClient } from "../client";
import type {
	BillingSettlementMode,
	RuntimeEntitlementGrant,
} from "@tedix/api-contract/schemas/runtime-entitlements";
import type {
	MemberRole,
	OrganizationMember,
} from "../schema/organization-members";
import type { Organization } from "../schema/organizations";
import type { User } from "../schema/users";
import {
	acceptInvite,
	addMember,
	getMemberByCanonicalUserId,
	getMemberByUserId,
	updateMember,
} from "./organization-members";
import {
	createOrganization,
	bindOrganizationExternalIdentity,
	generateUniqueSlug,
	getOrganizationByDescopeId,
	getOrganizationByExternalIdentity,
	getPersonalOrganization,
} from "./organizations";
import { upsertUserForExternalIdentity } from "./users";

function isUniqueConstraintError(error: unknown): boolean {
	const message =
		error instanceof Error
			? error.message
			: typeof error === "string"
				? error
				: "";
	return /unique constraint|constraint failed|SQLITE_CONSTRAINT/i.test(message);
}

// ============================================================================
// Types
// ============================================================================

export interface EnsureOrgAndMemberInput {
	settlementMode: BillingSettlementMode;
	runtimeEntitlementGrants?: RuntimeEntitlementGrant[];
	/** Descope organization ID (from JWT claim `oid`) */
	descopeTenantId: string;
	/** Exact validated Descope JWT issuer. */
	identityIssuer: string;
	/** Descope user ID (from JWT claim `sub`) */
	descopeUserId: string;
	/** User email (from JWT claim `email`) */
	email: string;
	/** User display name (optional, from JWT claim `name`) */
	name?: string;
	/** Organization name (optional, defaults to email domain) */
	organizationName?: string;
	/** Member role (optional, defaults to "owner" for first member, "member" otherwise) */
	role?: MemberRole;
}

export interface EnsureOrgAndMemberResult {
	/** The organization (found or created) */
	organization: Organization;
	/** The member record (found, reactivated, or created) */
	member: OrganizationMember;
	/** The user record (upserted) */
	user: User;
	/** What was created in this call */
	created: {
		organization: boolean;
		member: boolean;
	};
}

// ============================================================================
// Main Function
// ============================================================================

const DESCOPE_TENANT_ADMIN_ROLES = new Set(["Admin", "admin"]);

function normalizeMemberRole(role: unknown): MemberRole | undefined {
	if (
		role === "owner" ||
		role === "admin" ||
		role === "member" ||
		role === "viewer"
	) {
		return role;
	}

	// Descope's admin role is used for SSO/S4 permissions, not
	// Tedix RBAC. Treat it as admin when it is the only role surfaced in a JWT.
	if (typeof role === "string" && DESCOPE_TENANT_ADMIN_ROLES.has(role)) {
		return "admin";
	}

	return undefined;
}

/**
 * Ensure organization and member exist for a Descope user
 *
 * This function is idempotent and safe for concurrent calls:
 * - If org exists, returns it
 * - If org doesn't exist, creates it
 * - If member exists (active), returns it
 * - If member exists (invited), accepts invitation (sets status to active, records timestamp)
 * - If member exists (deactivated), reactivates it
 * - If member doesn't exist, creates it
 *
 * @param db - Database client
 * @param input - Descope user data from JWT
 * @returns Organization, member, user, and creation flags
 *
 * @example
 * // In API auth middleware
 * const result = await ensureOrgAndMember(db, {
 *   descopeTenantId: getTenantId(payload),
 *   identityIssuer: payload.iss,
 *   descopeUserId: payload.sub,
 *   email: payload.email,
 *   name: payload.name,
 *   role: getTenantRoles(payload)[0] ?? "member",
 * });
 * context.organizationId = result.organization.id;
 * context.userRole = result.member.role;
 */
export async function ensureOrgAndMember(
	db: DbClient,
	input: EnsureOrgAndMemberInput,
): Promise<EnsureOrgAndMemberResult> {
	const {
		descopeTenantId,
		descopeUserId,
		identityIssuer,
		email,
		name,
		organizationName,
		role,
	} = input;

	const created = {
		organization: false,
		member: false,
	};

	// 1. Reconcile the provider identity and verified email. Descope name claims
	// seed an empty profile only; D1 remains authoritative for a user-managed
	// display name and avatar.
	const user = await upsertUserForExternalIdentity(db, {
		identity: {
			provider: "descope",
			issuer: identityIssuer,
			subject: descopeUserId,
		},
		email,
		name: name ?? null,
		lastLoginAt: new Date().toISOString(),
	});

	// 2. Find or create organization
	const tenantIdentity = {
		provider: "descope",
		issuer: identityIssuer,
		subject: descopeTenantId,
	};
	let organization =
		(await getOrganizationByExternalIdentity(db, tenantIdentity)) ??
		(await getOrganizationByDescopeId(db, descopeTenantId));

	if (!organization) {
		// Name the org for who it actually is. Prefer the real org/tenant name
		// resolved by the caller (Descope `tenant.load` name, threaded as
		// `organizationName`); never default to the capitalized email domain, which
		// turned single-word company domains into brand-masquerade names and forced
		// `tedix-XXXX` slug collisions (the "Tedix" default-name drift class). Fall
		// back to an opaque, non-brand id-suffix label, mirroring syncFromDescope.
		const orgName =
			organizationName ?? `Organization ${descopeTenantId.slice(-8)}`;
		const slug = await generateUniqueSlug(
			db,
			organizationName ?? descopeTenantId,
		);

		try {
			organization = await createOrganization(
				db,
				{
					name: orgName,
					slug,
					descopeTenantId,
				},
				{
					settlementMode: input.settlementMode,
					runtimeEntitlementGrants: input.runtimeEntitlementGrants,
				},
			);
			created.organization = true;
		} catch (error) {
			if (!isUniqueConstraintError(error)) throw error;
			organization = await getOrganizationByDescopeId(db, descopeTenantId);
			if (!organization) throw error;
		}
	}
	await bindOrganizationExternalIdentity(db, organization.id, tenantIdentity);

	// 3. Find or create member
	let member =
		(await getMemberByCanonicalUserId(db, organization.id, user.id)) ??
		(await getMemberByUserId(db, organization.id, descopeUserId));

	if (member) {
		// Reactivate if deactivated
		if (member.status === "deactivated") {
			member = await updateMember(db, member.id, { status: "active" });
		}
		// Accept invitation if pending (user logged in via invitation link)
		else if (member.status === "invited") {
			member = await acceptInvite(db, member.id, descopeUserId, {
				name: name ?? undefined,
			});
		}
		if (member.userId !== user.id) {
			member = await updateMember(db, member.id, { userId: user.id });
		}
		// Member already exists and is active - no creation needed
	} else {
		// Determine role: first member is owner, others default to "member"
		const memberRole =
			normalizeMemberRole(role) ?? (created.organization ? "owner" : "member");

		try {
			member = await addMember(db, {
				organizationId: organization.id,
				userId: user.id,
				descopeUserId,
				email,
				name: name ?? null,
				role: memberRole,
				status: "active",
			});
			created.member = true;
		} catch (error) {
			if (!isUniqueConstraintError(error)) throw error;
			member = await getMemberByUserId(db, organization.id, descopeUserId);
			if (!member) throw error;
		}
	}

	return {
		organization,
		member,
		user,
		created,
	};
}

// ============================================================================
// Personal Organization
// ============================================================================

export interface EnsurePersonalOrgResult {
	/** The personal organization (found or created) */
	organization: Organization;
	/** The member record (found or created) */
	member: OrganizationMember;
	/** Whether the personal org was created in this call */
	created: boolean;
}

/**
 * Ensure a personal organization exists for a Descope user
 *
 * This function is idempotent and safe for concurrent calls:
 * - If a personal org already exists for this user, returns it
 * - If not, creates one with type = "personal" and the user as owner
 *
 * Personal orgs have a synthetic Descope tenant ID: "personal_{descopeUserId}"
 * This allows the `dct` claim to route to the personal org in getTenantId().
 *
 * @param db - Database client
 * @param descopeUserId - Descope user ID (from JWT claim `sub`)
 * @param userName - User display name (optional, for workspace naming)
 * @param userEmail - User email (optional, for member record)
 * @returns Personal organization, member, and creation flag
 *
 * @example
 * const result = await ensurePersonalOrg(
 *   db,
 *   payload.sub,
 *   payload.name,
 *   payload.email,
 *   payload.iss,
 *   options,
 * );
 * if (result.created) {
 *   // Also create Descope tenant for this personal org
 * }
 */
export async function ensurePersonalOrg(
	db: DbClient,
	descopeUserId: string,
	userName?: string,
	userEmail?: string,
	identityIssuer?: string,
	options?: {
		settlementMode: BillingSettlementMode;
		runtimeEntitlementGrants?: RuntimeEntitlementGrant[];
	},
): Promise<EnsurePersonalOrgResult> {
	if (!options)
		throw new Error("Personal organization bootstrap requires settlement mode");
	if (!identityIssuer)
		throw new Error("Personal organization bootstrap requires identity issuer");
	const user = await upsertUserForExternalIdentity(db, {
		identity: {
			provider: "descope",
			issuer: identityIssuer,
			subject: descopeUserId,
		},
		email: userEmail ?? `${descopeUserId}@identity.invalid`,
		name: userName ?? null,
		lastLoginAt: new Date().toISOString(),
	});
	// 1. Check if a personal org already exists for this user
	const existing = await getPersonalOrganization(db, descopeUserId);

	if (existing) {
		await bindOrganizationExternalIdentity(db, existing.id, {
			provider: "descope",
			issuer: identityIssuer,
			subject: existing.descopeTenantId ?? `personal_${descopeUserId}`,
		});
		// Personal org exists — find the member record
		let member =
			(await getMemberByCanonicalUserId(db, existing.id, user.id)) ??
			(await getMemberByUserId(db, existing.id, descopeUserId));
		if (!member) {
			// Edge case: org exists but member was removed — re-add as owner
			const newMember = await addMember(db, {
				organizationId: existing.id,
				userId: user.id,
				descopeUserId,
				email: userEmail ?? "",
				name: userName ?? null,
				role: "owner",
				status: "active",
			});
			return { organization: existing, member: newMember, created: false };
		}
		if (member.userId !== user.id) {
			member = await updateMember(db, member.id, { userId: user.id });
		}
		return { organization: existing, member, created: false };
	}
	// 2. Create new personal organization
	const workspaceName = userName
		? `${userName}'s Workspace`
		: "Personal Workspace";

	// Generate a unique slug with "personal-" prefix and a short random ID
	const shortId = crypto.randomUUID().substring(0, 8);
	const baseSlug = `personal-${shortId}`;
	const slug = await generateUniqueSlug(db, baseSlug);

	// Synthetic Descope tenant ID for personal orgs
	const descopeTenantId = `personal_${descopeUserId}`;

	let organization: Organization;
	let createdOrganization = true;
	try {
		organization = await createOrganization(
			db,
			{
				name: workspaceName,
				slug,
				type: "personal",
				descopeTenantId,
			},
			options,
		);
	} catch (error) {
		if (!isUniqueConstraintError(error)) throw error;
		createdOrganization = false;
		const racedOrganization = await getPersonalOrganization(db, descopeUserId);
		if (!racedOrganization) throw error;
		const racedMember = await getMemberByUserId(
			db,
			racedOrganization.id,
			descopeUserId,
		);
		if (racedMember) {
			const canonicalMember =
				racedMember.userId === user.id
					? racedMember
					: await updateMember(db, racedMember.id, { userId: user.id });
			await bindOrganizationExternalIdentity(db, racedOrganization.id, {
				provider: "descope",
				issuer: identityIssuer,
				subject: descopeTenantId,
			});
			return {
				organization: racedOrganization,
				member: canonicalMember,
				created: false,
			};
		}
		organization = racedOrganization;
	}
	await bindOrganizationExternalIdentity(db, organization.id, {
		provider: "descope",
		issuer: identityIssuer,
		subject: descopeTenantId,
	});

	// 3. Create member record as owner
	let member: OrganizationMember;
	try {
		member = await addMember(db, {
			organizationId: organization.id,
			userId: user.id,
			descopeUserId,
			email: userEmail ?? "",
			name: userName ?? null,
			role: "owner",
			status: "active",
		});
	} catch (error) {
		if (!isUniqueConstraintError(error)) throw error;
		const racedMember = await getMemberByUserId(
			db,
			organization.id,
			descopeUserId,
		);
		if (!racedMember) throw error;
		member = racedMember;
	}

	return { organization, member, created: createdOrganization };
}
