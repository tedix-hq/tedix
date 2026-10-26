import { safeExceptionTopology } from "../../lib/safe-log-metadata";
import { assertDescopeOk } from "@tedix/auth/descope";
import { getDescopeManagement } from "../../lib/descope-management";
/**
 * oRPC Members Router
 * Organization member management with Descope synchronization
 *
 * D1 is the primary store for member records. Descope management SDK
 * is used for user/tenant operations when available.
 *
 * All mutations require admin/owner role via requireRole() middleware
 *
 * This router uses contract-first development with oRPC.
 * The contract is imported from @tedix/api-contract package.
 */

import { implement } from "@orpc/server";
import { membersContract } from "@tedix/api-contract/contracts/members";
import { isPlatformPrincipal } from "@tedix/auth/types";
import {
	acceptInvite,
	countActiveOwners,
	getMemberById,
	getMembersByOrganization,
	listMemberRepresentatives,
	listTedisByMemberDescopeUserIds,
	setMemberIdentity,
	inviteMember as inviteMemberD1,
	removeMember as removeMemberD1,
	setMemberPermissions as setMemberPermissionsD1,
	updateMemberRole as updateMemberRoleD1,
} from "@tedix/db/queries/organization-members";
import { getOrganizationById } from "@tedix/db/queries/organizations";
import {
	withAuthorization,
	type BaseContext,
	createError,
	ErrorCodes,
	withAuth,
} from "../orpc";
import {
	ASSIGNABLE_ROLES,
	isTenantGrantablePermission,
	PERMISSION_METADATA,
	ROLE_METADATA,
	ROLE_PERMISSION_GRANTS,
	TENANT_GRANTABLE_PERMISSIONS,
} from "@tedix/auth/rbac";
import type { OrganizationPermission } from "@tedix/api-contract/schemas/user-settings";
import {
	CAPABILITY_SCOPE_METADATA,
	CAPABILITY_SCOPES,
} from "@tedix/mcp-shared/auth/scopes";
import { auditActor } from "../audit-helpers";
import { emitAuditEvent } from "../audit-helpers";
import {
	readMembershipReconciliation,
	descopeTenantRolesForMemberRole,
} from "../../services/membership-reconciliation";

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

// Role hierarchy for RBAC invariants. Higher rank = more authority.
const MEMBER_ROLE_RANK = { owner: 3, admin: 2, member: 1, viewer: 0 } as const;

export function memberRoleRank(role: string | null | undefined): number {
	return role && role in MEMBER_ROLE_RANK
		? MEMBER_ROLE_RANK[role as keyof typeof MEMBER_ROLE_RANK]
		: -1;
}

/**
 * The caller's effective role for member-management authority.
 *
 * A human's role is their `organization_members.role`. But a tenant's `org_admin`
 * OPERATOR tedi must also manage its own org's team without a human UI session
 * — it has no member row, so map it to an ADMIN-equivalent role.
 * Capped at admin on purpose: it can invite/manage admin/member/viewer but NOT
 * owner (the role-rank checks below still block owner, and the last-owner guard
 * still protects removals). Own-org is already enforced by
 * `requireOrganizationAccess` before any of these checks run, and a tedi's
 * `mcp:settings` scope is granted only by the `org_admin` capability profile.
 */
export function effectiveMemberRole(
	context: BaseContext,
): "owner" | "admin" | "member" | "viewer" | null {
	const userRole = context.userRole;
	if (userRole === "owner") return "owner";
	if (userRole === "admin") return "admin";
	if (userRole === "member") return "member";
	if (userRole === "viewer") return "viewer";
	if (context.tediId && context.tediScopes?.includes("mcp:settings.admin")) {
		return "admin";
	}
	return null;
}

/**
 * Accepting an invitation may only link the AUTHENTICATED caller's own Descope
 * account. `descopeUserId` arrives in the request body, and nothing used to
 * check it, so a caller could graft a third party's Descope account onto a
 * membership. A token with no user identity at all (M2M / tedi principal) has no
 * business accepting a human's invitation, so it fails closed.
 */
export function assertInvitationLinkTarget(
	context: BaseContext,
	requestedDescopeUserId: string,
): void {
	const callerDescopeUserId = context.descopeUserId ?? context.user?.sub;
	if (!callerDescopeUserId) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Accepting an invitation requires an authenticated user identity",
		);
	}
	if (requestedDescopeUserId !== callerDescopeUserId) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"An invitation can only be linked to the authenticated user's own account",
		);
	}
}

/**
 * An invitation may only be accepted by the person it was addressed to.
 *
 * Previously the handler checked only that the invitation existed and was still
 * pending, so any authenticated caller who knew a pending `memberId` could join
 * an organization they were never invited to. The id is no defence: the invite
 * email carries only a static `/login` URL (see inviteMember), so it is not a
 * bearer secret and is discoverable after login.
 *
 * Identity comes from the verified `email` claim; human Descope tokens carry it
 * (the Tedix OS session and the CMS M2M-vs-human split both depend on it) and a
 * token without one fails closed. Throws NOT_FOUND rather than FORBIDDEN so a
 * caller cannot probe which member ids correspond to live invitations.
 */
export function assertInvitationAddressedToCaller(
	context: BaseContext,
	invitationEmail: string,
): void {
	const callerEmail = context.user?.email;
	if (!callerEmail) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Accepting an invitation requires a verified email identity",
		);
	}
	if (
		invitationEmail.trim().toLowerCase() !== callerEmail.trim().toLowerCase()
	) {
		throw createError(ErrorCodes.NOT_FOUND, "Invitation not found");
	}
}

/**
 * Prevent vertical privilege escalation: a caller may not grant a role higher
 * than their own effective role (e.g. an admin — or an org_admin operator tedi —
 * inviting/promoting to owner).
 */
export function assertCanAssignRole(
	context: BaseContext,
	targetRole: string,
): void {
	if (
		memberRoleRank(targetRole) > memberRoleRank(effectiveMemberRole(context))
	) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			`Cannot assign the "${targetRole}" role: it outranks your own role.`,
		);
	}
}

/**
 * Prevent acting on a member who outranks the caller (e.g. an admin demoting or
 * removing an owner).
 */
export function assertCanManageTarget(
	context: BaseContext,
	targetCurrentRole: string | null | undefined,
): void {
	if (
		memberRoleRank(targetCurrentRole) >
		memberRoleRank(effectiveMemberRole(context))
	) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Cannot manage a member whose role outranks your own.",
		);
	}
}

/**
 * Verify the caller has admin-or-owner authority (a human admin/owner, or an
 * org_admin operator tedi in its own org).
 * Throws if insufficient permissions.
 */
function requireAdminOrOwner(context: BaseContext): void {
	// A platform principal may administer memberships across organizations. The
	// target-org boundary is still enforced by requireOrganizationAccess(), which
	// only permits this bypass for an actual platform principal.
	if (isPlatformPrincipal(context)) return;
	const role = effectiveMemberRole(context);

	if (role !== "admin" && role !== "owner") {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Only admins and owners can manage organization members",
		);
	}
}

/**
 * D1 reports a uniqueness violation through a Drizzle wrapper. It must be
 * translated at this HTTP boundary; otherwise the oRPC client receives an
 * untyped 500 body and reports the misleading "Malformed Orpc Error Response".
 */
function isD1ConstraintError(error: unknown): boolean {
	for (let cursor = error; cursor instanceof Error; cursor = cursor.cause) {
		if (
			/unique constraint|constraint failed|SQLITE_CONSTRAINT/i.test(
				cursor.message,
			)
		) {
			return true;
		}
	}
	return false;
}

/** A pending invitation has not yet been bound to a provider subject. */
function hasResolvedDescopeUserId(value: string): boolean {
	return value.length > 0 && !value.startsWith("pending:");
}

/**
 * Verify the authenticated principal is scoped to the requested organization.
 */
async function requireOrganizationAccess(
	context: BaseContext,
	organizationId: string,
) {
	const org = await getOrganizationById(context.db, organizationId);
	if (!org) {
		throw createError(ErrorCodes.NOT_FOUND, "Organization not found");
	}

	if (!context.organizationId || context.organizationId !== organizationId) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Organization access denied for this resource",
		);
	}

	return org;
}

/**
 * Get Descope tenant ID from D1 organization
 */
async function getDescopeTenantId(
	db: ReturnType<typeof import("@tedix/db/client").createDbClient>,
	organizationId: string,
): Promise<string | null> {
	const org = await getOrganizationById(db, organizationId);

	if (!org) {
		throw createError(ErrorCodes.NOT_FOUND, "Organization not found");
	}

	return org.descopeTenantId ?? null;
}

// =============================================================================
// CONTRACT IMPLEMENTATION
// =============================================================================

/**
 * Create the contract implementer with base context
 * This enforces type safety between contract and implementation
 */
const membersOs = implement(membersContract).$context<BaseContext>();

/**
 * Create authenticated implementer - ALL procedures inherit auth
 * This ensures all member endpoints require authentication
 */
const authedMembersOs = membersOs.use(withAuth);

const getMembershipReconciliationContract =
	authedMembersOs.getMembershipReconciliation
		.use(withAuthorization("team:manage", "team:read"))
		.handler(async ({ input, context }) => {
			const org = await requireOrganizationAccess(
				context,
				input.organizationId,
			);
			requireAdminOrOwner(context);
			if (!org.descopeTenantId) {
				throw createError(
					ErrorCodes.CONFLICT,
					"Organization has no Descope tenant configured",
				);
			}
			const mgmt = getDescopeManagement(context.env, true);
			return (
				await readMembershipReconciliation(
					context.db,
					mgmt,
					org.id,
					org.descopeTenantId,
				)
			).report;
		});

const repairMembershipContract = authedMembersOs.repairMembership
	.use(withAuthorization("team:manage", "team:write"))
	.handler(async ({ input, context }) => {
		const org = await requireOrganizationAccess(context, input.organizationId);
		requireAdminOrOwner(context);
		const tenantId = org.descopeTenantId;
		if (!tenantId) {
			throw createError(
				ErrorCodes.CONFLICT,
				"Organization has no Descope tenant configured",
			);
		}
		const mgmt = getDescopeManagement(context.env, true);
		const { members, report } = await readMembershipReconciliation(
			context.db,
			mgmt,
			org.id,
			tenantId,
		);
		const restoring = input.action === "restore_descope";
		const divergence = report.divergences.find((item) =>
			restoring
				? (item.kind === "missing_descope" || item.kind === "role_mismatch") &&
					item.memberId === input.targetId
				: (item.kind === "missing_d1" || item.kind === "inactive_d1") &&
					item.descopeUserId === input.targetId,
		);
		if (!divergence) {
			throw createError(
				ErrorCodes.CONFLICT,
				"Divergence no longer exists; refresh reconciliation",
			);
		}
		if (divergence.role) assertCanManageTarget(context, divergence.role);
		for (const role of divergence.descopeRoles) {
			// Unknown provider roles may carry authority outside the tenant role catalog.
			if (memberRoleRank(role) < 0) {
				throw createError(
					ErrorCodes.FORBIDDEN,
					"Provider has an unrecognized role; requires operator review",
				);
			}
			assertCanManageTarget(context, role);
		}
		const member = members.find((item) => item.id === divergence.memberId);
		const loaded = divergence.descopeUserId
			? await mgmt.management.user.loadByUserId(divergence.descopeUserId)
			: await mgmt.management.user.load(member!.email);
		assertDescopeOk(loaded, "user.load");
		const user = loaded.data;
		if (!user?.userId || user.customAttributes?.entityType === "tedi") {
			throw createError(
				ErrorCodes.CONFLICT,
				"Human provider identity unavailable; use the invitation flow for new identities",
			);
		}
		if (
			!divergence.descopeUserId &&
			user.email?.trim().toLowerCase() !== member!.email.trim().toLowerCase()
		) {
			throw createError(
				ErrorCodes.CONFLICT,
				"Provider identity does not match invitation email",
			);
		}
		const association = user.userTenants?.find(
			(tenant) => tenant.tenantId === tenantId,
		);
		if (
			divergence.kind === "missing_descope"
				? Boolean(association)
				: !association
		) {
			throw createError(
				ErrorCodes.CONFLICT,
				"Provider membership changed; refresh reconciliation",
			);
		}
		// Recheck roles from the direct provider read, not just the search inventory.
		for (const role of association?.roleNames ?? []) {
			if (memberRoleRank(role) < 0)
				throw createError(
					ErrorCodes.FORBIDDEN,
					"Provider has an unrecognized role; requires operator review",
				);
			assertCanManageTarget(context, role);
		}
		const repairId = crypto.randomUUID();
		const actor = auditActor(context);
		const audit = (outcome: "requested" | "verified" | "failed") =>
			emitAuditEvent(context.db, {
				organizationId: org.id,
				actorId: actor.actorId,
				actorType: actor.actorType,
				action: `member.reconciliation.${outcome}`,
				resourceType: "organization_member",
				resourceId: divergence.memberId ?? user.userId,
				metadata: {
					...actor.actorMetadata,
					repairId,
					reason: input.reason,
					repairAction: input.action,
					tenantId,
					descopeUserId: user.userId,
					divergence,
				},
			});
		// Persist intent before an external write; audit failure must prevent mutation.
		await audit("requested");
		try {
			if (restoring) {
				if (!association) {
					assertDescopeOk(
						await mgmt.management.user.addTenant(user.userId, tenantId),
						"user.addTenant",
					);
				}
				assertDescopeOk(
					await mgmt.management.user.setTenantRoles(
						user.userId,
						tenantId,
						descopeTenantRolesForMemberRole(member!.role),
					),
					"user.setTenantRoles",
				);
			} else {
				assertDescopeOk(
					await mgmt.management.user.removeTenant(user.userId, tenantId),
					"user.removeTenant",
				);
			}
			const verified = await mgmt.management.user.loadByUserId(user.userId);
			assertDescopeOk(verified, "user.loadByUserId");
			if (!verified.data)
				throw createError(
					ErrorCodes.INTERNAL_SERVER_ERROR,
					"Repair could not be verified",
				);
			const after = verified.data.userTenants?.find(
				(tenant) => tenant.tenantId === tenantId,
			);
			if (
				restoring
					? !after ||
						after.roleNames?.length !==
							descopeTenantRolesForMemberRole(member!.role).length ||
						!descopeTenantRolesForMemberRole(member!.role).every((role) =>
							after.roleNames?.includes(role),
						)
					: Boolean(after)
			) {
				throw createError(
					ErrorCodes.CONFLICT,
					"Repair not confirmed by Descope; refresh reconciliation before retrying",
				);
			}
		} catch (error) {
			await audit("failed");
			throw error;
		}
		await audit("verified");
		return { repairId, verified: true as const };
	});

// =============================================================================
// CONTRACT-BASED MIDDLEWARE
// =============================================================================

// =============================================================================
// CONTRACT-BASED PROCEDURE IMPLEMENTATIONS
// =============================================================================

/**
 * Helper to format member response
 */
function formatMemberResponse(m: {
	id: string;
	organizationId: string;
	descopeUserId: string;
	userId?: string | null;
	kind?: "human" | "external_agent";
	representedUserId?: string | null;
	representedUserName?: string | null;
	tediId?: string | null;
	email: string;
	name: string | null;
	avatarUrl: string | null;
	role: string;
	customPermissions: unknown;
	status: string | null;
	invitedAt: string | null;
	invitedBy: string | null;
	inviteAcceptedAt: string | null;
	lastActiveAt: string | null;
	createdAt: string | null;
	updatedAt: string | null;
}) {
	return {
		id: m.id,
		organizationId: m.organizationId,
		descopeUserId: m.descopeUserId,
		userId: m.userId ?? null,
		kind: m.kind ?? "human",
		representedUserId: m.representedUserId ?? null,
		representedUserName: m.representedUserName ?? null,
		tediId: m.tediId ?? null,
		email: m.email,
		name: m.name,
		avatarUrl: m.avatarUrl,
		role: m.role as "owner" | "admin" | "member" | "viewer",
		// Filtered, not raw: the same boundary the guards apply on read, so a row
		// carrying something a tenant admin was never allowed to grant is not
		// reported as authority either.
		customPermissions: Array.isArray(m.customPermissions)
			? (m.customPermissions.filter(
					(entry): entry is OrganizationPermission =>
						typeof entry === "string" && isTenantGrantablePermission(entry),
				) as OrganizationPermission[])
			: null,
		status: m.status as "active" | "invited" | "deactivated" | null,
		invitedAt: m.invitedAt,
		invitedBy: m.invitedBy,
		inviteAcceptedAt: m.inviteAcceptedAt,
		lastActiveAt: m.lastActiveAt,
		createdAt: m.createdAt,
		updatedAt: m.updatedAt,
	};
}

/** Only a real image reference is an avatar; a tedi's emoji glyph is not a URL. */
function isAvatarUrl(value: string | null): value is string {
	return value !== null && /^(?:https?:\/\/|data:image\/)/i.test(value);
}

/**
 * Resolve each member's display identity from data: the represented person's
 * name for an external agent, and for a tedi-backed membership (same Descope
 * subject as a live tedi) the tedi's own avatar. A person keeps their profile
 * picture; an external agent keeps the avatar stored on its row.
 */
async function resolveMemberIdentities(
	db: BaseContext["db"],
	organizationId: string,
	members: Awaited<ReturnType<typeof getMembersByOrganization>>,
) {
	const representatives = await listMemberRepresentatives(
		db,
		organizationId,
		members.flatMap((member) =>
			member.kind === "external_agent" && member.representedUserId
				? [member.representedUserId]
				: [],
		),
	);
	const names = new Map(
		representatives.map((person) => [
			person.userId,
			person.name || person.email,
		]),
	);
	const tedisBySubject = new Map(
		(
			await listTedisByMemberDescopeUserIds(
				db,
				organizationId,
				members.flatMap((member) =>
					member.kind !== "external_agent" ? [member.descopeUserId] : [],
				),
			)
		).flatMap((tedi) =>
			tedi.descopeUserId ? [[tedi.descopeUserId, tedi] as const] : [],
		),
	);
	return members.map((member) => {
		const tedi =
			member.kind !== "external_agent"
				? tedisBySubject.get(member.descopeUserId)
				: undefined;
		return formatMemberResponse({
			...member,
			representedUserName: names.get(member.representedUserId) ?? null,
			tediId: tedi?.tediId ?? null,
			avatarUrl:
				tedi && isAvatarUrl(tedi.avatar) ? tedi.avatar : member.avatarUrl,
		});
	});
}

/**
 * Contract-based list members procedure
 */
export const listMembersContract = authedMembersOs.listMembers
	.use(withAuthorization("team:read", "team:read"))
	.handler(async ({ input, context }) => {
		const { db } = context;
		const { organizationId, limit, offset, status, role } = input;

		await requireOrganizationAccess(context, organizationId);

		// Get members from D1
		const members = await getMembersByOrganization(db, organizationId, {
			limit,
			offset,
			status,
			role,
		});

		// Count total members (for pagination)
		const allMembers = await getMembersByOrganization(db, organizationId, {
			status,
			role,
		});
		const total = allMembers.length;

		return {
			data: await resolveMemberIdentities(db, organizationId, members),
			pagination: {
				limit,
				offset,
				total,
				hasMore: offset + limit < total,
			},
		};
	});

/**
 * Contract-based get member procedure
 */
export const getMemberContract = authedMembersOs.getMember
	.use(withAuthorization("team:read", "team:read"))
	.handler(async ({ input, context }) => {
		const { db } = context;
		const { organizationId, memberId } = input;

		await requireOrganizationAccess(context, organizationId);

		// Get member from D1
		const member = await getMemberById(db, memberId);
		if (!member) {
			throw createError(ErrorCodes.NOT_FOUND, "Member not found");
		}

		if (member.organizationId !== organizationId) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Member does not belong to this organization",
			);
		}

		const [resolved] = await resolveMemberIdentities(db, organizationId, [
			member,
		]);
		return { data: resolved! };
	});

export const listRolesContract = authedMembersOs.listRoles
	.use(withAuthorization("team:read", "team:read"))
	.handler(async ({ input, context }) => {
		await requireOrganizationAccess(context, input.organizationId);
		return {
			data: ASSIGNABLE_ROLES.map((role) => ({
				role,
				label: ROLE_METADATA[role].label,
				description: ROLE_METADATA[role].description,
				responsibility: ROLE_METADATA[role].responsibility,
				permissions: [...ROLE_PERMISSION_GRANTS[role]],
			})),
		};
	});

export const listPermissionsContract = authedMembersOs.listPermissions
	.use(withAuthorization("team:read", "team:read"))
	.handler(async ({ input, context }) => {
		await requireOrganizationAccess(context, input.organizationId);
		return {
			data: TENANT_GRANTABLE_PERMISSIONS.map((permission) => ({
				permission,
				...PERMISSION_METADATA[permission],
			})),
		};
	});

export const listCapabilityScopesContract = authedMembersOs.listCapabilityScopes
	.use(withAuthorization("team:read", "team:read"))
	.handler(async ({ input, context }) => {
		await requireOrganizationAccess(context, input.organizationId);
		return {
			data: CAPABILITY_SCOPES.map((scope) => ({
				scope,
				...CAPABILITY_SCOPE_METADATA[scope],
			})),
		};
	});

/**
 * Contract-based invite member procedure
 */
export const inviteMemberContract = authedMembersOs.inviteMember
	.use(withAuthorization("team:manage", "team:write"))
	.handler(async ({ input, context }) => {
		const { db } = context;
		const { organizationId, email, role } = input;

		// Require admin/owner role
		await requireOrganizationAccess(context, organizationId);
		requireAdminOrOwner(context);

		// Prevent escalation: cannot invite at a role higher than the caller's
		// (an admin must not be able to mint an owner).
		assertCanAssignRole(context, role);

		const actor = auditActor(context);
		// Retain the initiating principal before D1 or provider side effects.
		await emitAuditEvent(db, {
			organizationId,
			actorId: actor.actorId,
			actorType: actor.actorType,
			action: "member.invite_requested",
			resourceType: "organization_member",
			metadata: { ...actor.actorMetadata, email, role },
		});

		// Create pending membership in D1 (primary store). A concurrent invite can
		// still race the email lookup in the query layer; return an oRPC conflict
		// that the UI can render instead of leaking a raw D1 500.
		const member = await inviteMemberD1(
			db,
			organizationId,
			email,
			role,
			undefined,
			actor.actorId,
		).catch((error: unknown) => {
			if (isD1ConstraintError(error)) {
				throw createError(
					ErrorCodes.CONFLICT,
					"An invitation for this member is already being created. Refresh and try again.",
				);
			}
			throw error;
		});

		await emitAuditEvent(db, {
			organizationId,
			actorId: actor.actorId,
			actorType: actor.actorType,
			action: "member.invitation_created",
			resourceType: "organization_member",
			resourceId: member.id,
			metadata: { ...actor.actorMetadata, email, role, status: member.status },
		});

		// Invite the user in Descope when configured.
		//
		// `invite` creates a Descope invitation and sends its magic-link email.
		// An already active Descope user cannot receive another Descope invitation,
		// so OS also exposes a sign-in recovery path for the still-pending D1 row.
		// `addTenantRoles` covers both new and pre-existing identities idempotently.
		const descopeTenantId = await getDescopeTenantId(db, organizationId);
		if (descopeTenantId) {
			const mgmt = getDescopeManagement(context.env);
			if (mgmt) {
				// The invite email's ONLY actionable element is `{{inviteUrl}}`
				// ("Click on the link below to start your journey: {{inviteUrl}}").
				// Descope resolves it from this per-invite `inviteUrl`, falling back to
				// the project-level setting. A per-invite URL keeps the destination
				// environment-specific even though the Descope project is shared.
				// Send the invitee to OS's dedicated token-consumption route. Descope
				// appends `?t=<magic-link-token>` when the project setting enables
				// invitation magic links; `/invite` verifies that token with the
				// Descope browser SDK before the broker establishes the product
				// session. Sending it to `/` silently discarded the token and retained
				// whichever identity happened to be signed in in that browser.
				//
				// Per-invite beats the project-level "User Invitation Redirect URL",
				// which matters because Descope is a SINGLE shared project across
				// production and local while OS_URL is env-aware — so the project
				// setting can only ever name one environment, and this names the right
				// one.
				const osBase = context.env.OS_URL || "https://os.tedix.dev";
				const inviteUrl = new URL("/invite", `${osBase.replace(/\/+$/, "")}/`);
				// Descope authenticates the email address but does not select a tenant
				// for an invitation response. Carry only the server-authorized target;
				// acceptance still proves that target against the verified caller.
				inviteUrl.searchParams.set("member_id", member.id);
				inviteUrl.searchParams.set("tenant_id", descopeTenantId);
				assertDescopeOk(
					await mgmt.management.user.invite(email, {
						email,
						userTenants: [
							{
								tenantId: descopeTenantId,
								roleNames: descopeTenantRolesForMemberRole(role),
							},
						],
						sendMail: true,
						inviteUrl: inviteUrl.toString(),
					}),
					"user.invite",
				);
				assertDescopeOk(
					await mgmt.management.user.addTenantRoles(
						email,
						descopeTenantId,
						descopeTenantRolesForMemberRole(role),
					),
					"user.addTenantRoles",
				);
				// An admin inviting a teammate IS the approval decision. But the
				// signup gate lives in the Descope sign-up-or-in flow keyed on the
				// `waitlistStatus` custom attribute, and `user.invite` leaves it
				// unset — which falls into the flow's Else branch ("Waitlist
				// Pending"). Without this, every invited member is bounced at login
				// holding a perfectly valid invite. See docs/engineering/platform/auth.md (waitlist gate).
				assertDescopeOk(
					await mgmt.management.user.updateCustomAttribute(
						email,
						"waitlistStatus",
						"approved",
					),
					"user.updateCustomAttribute",
				);
			}
		}

		return {
			data: formatMemberResponse(member),
		};
	});

/**
 * Contract-based update member role procedure
 */
export const updateMemberRoleContract = authedMembersOs.updateMemberRole
	.use(withAuthorization("team:manage", "team:write"))
	.handler(async ({ input, context }) => {
		const { db } = context;
		const { organizationId, memberId, role } = input;

		// Require admin/owner role
		await requireOrganizationAccess(context, organizationId);
		requireAdminOrOwner(context);

		// Owner is deliberately a platform-control-plane operation. Tenant admins
		// and org_admin tedis can manage their own team, but cannot mint another
		// owner; a verified platform principal can add an owner without demoting
		// the existing one. D1 supports multiple active owners and the existing
		// last-owner invariant protects later demotions/removals.
		if (role === "owner" && !isPlatformPrincipal(context)) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Only a platform principal can assign an additional organization owner.",
			);
		}

		// Get member from D1
		const member = await getMemberById(db, memberId);
		if (!member) {
			throw createError(ErrorCodes.NOT_FOUND, "Member not found");
		}

		if (member.organizationId !== organizationId) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Member does not belong to this organization",
			);
		}

		// Cannot act on a member who outranks you (an admin must not modify an owner).
		assertCanManageTarget(context, member.role);

		// Last-owner invariant: never demote the final owner. (role is already
		// narrowed to non-owner by the guard above, so this IS a demotion.)
		if (member.role === "owner") {
			const owners = await countActiveOwners(db, organizationId);
			if (owners <= 1) {
				throw createError(
					ErrorCodes.FORBIDDEN,
					"Cannot demote the last owner. Assign another owner first.",
				);
			}
		}

		const descopeTenantId = await getDescopeTenantId(db, organizationId);
		const needsDescopeSync =
			Boolean(descopeTenantId) &&
			hasResolvedDescopeUserId(member.descopeUserId);
		const mgmt = needsDescopeSync ? getDescopeManagement(context.env) : null;
		if (needsDescopeSync && !mgmt) {
			throw createError(
				ErrorCodes.SERVICE_UNAVAILABLE,
				"Descope role synchronization is unavailable; member role was not changed",
			);
		}

		// D1 is primary, but a failed provider sync must not look like full success.
		// Retrying the same role reconciles a partial update without changing scope.
		const updated = await updateMemberRoleD1(db, memberId, role);
		if (mgmt && descopeTenantId) {
			let synced;
			try {
				synced = await mgmt.management.user.setTenantRoles(
					member.descopeUserId,
					descopeTenantId,
					descopeTenantRolesForMemberRole(role),
				);
			} catch (error) {
				console.error("[Teams] Descope member role sync threw", {
					exception: safeExceptionTopology(error),
				});
				throw createError(
					ErrorCodes.BAD_GATEWAY,
					"Member role changed in Tedix but Descope synchronization failed; retry the same role",
				);
			}
			if (!synced.ok) {
				console.error("[Teams] Descope member role sync failed:", {
					code: synced.error?.errorCode,
				});
				throw createError(
					ErrorCodes.BAD_GATEWAY,
					"Member role changed in Tedix but Descope synchronization failed; retry the same role",
				);
			}
		}

		return {
			data: formatMemberResponse(updated),
		};
	});

/**
 * Contract-based set member permissions procedure.
 *
 * Replaces the additive grants layered on a member's role. PUT semantics: the
 * request carries the complete desired list and an empty array clears every
 * override, so a caller never has to read-modify-write to revoke one.
 *
 * The escalation boundary is `TENANT_GRANTABLE_PERMISSIONS` — exactly what the
 * `owner` role itself holds — so a tenant administrator can never mint
 * `platform:admin` or `catalog:manage` through this path. Enforced on write
 * here, and again on read in `userHoldsPermission`, so a row written by any
 * other path stays inert.
 */
export const setMemberPermissionsContract = authedMembersOs.setMemberPermissions
	.use(withAuthorization("team:manage", "team:write"))
	.handler(async ({ input, context }) => {
		const { db } = context;
		const { organizationId, memberId, permissions } = input;

		await requireOrganizationAccess(context, organizationId);
		requireAdminOrOwner(context);

		const member = await getMemberById(db, memberId);
		if (!member) {
			throw createError(ErrorCodes.NOT_FOUND, "Member not found");
		}
		if (member.organizationId !== organizationId) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Member does not belong to this organization",
			);
		}

		// An admin must not edit an owner's authority.
		assertCanManageTarget(context, member.role);

		const forbidden = permissions.filter(
			(permission) => !isTenantGrantablePermission(permission),
		);
		if (forbidden.length > 0) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				`Cannot grant permissions beyond the owner role: ${forbidden.join(", ")}`,
			);
		}

		const deduped = [...new Set(permissions)].sort();
		const updated = await setMemberPermissionsD1(db, memberId, deduped);

		const actor = auditActor(context);
		await emitAuditEvent(db, {
			organizationId,
			actorId: actor.actorId,
			actorType: actor.actorType,
			action: "member.permissions_set",
			resourceType: "organization_member",
			resourceId: memberId,
			metadata: {
				...actor.actorMetadata,
				email: member.email,
				role: member.role,
				previous: member.customPermissions ?? [],
				granted: deduped,
			},
		});

		return { data: formatMemberResponse(updated) };
	});

/**
 * Contract-based remove member procedure
 */
export const removeMemberContract = authedMembersOs.removeMember
	.use(withAuthorization("team:manage", "team:write"))
	.handler(async ({ input, context }) => {
		const { db } = context;
		const { organizationId, memberId } = input;

		// Require admin/owner role
		await requireOrganizationAccess(context, organizationId);
		requireAdminOrOwner(context);

		// Get member from D1
		const member = await getMemberById(db, memberId);
		if (!member) {
			throw createError(ErrorCodes.NOT_FOUND, "Member not found");
		}

		if (member.organizationId !== organizationId) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Member does not belong to this organization",
			);
		}

		// Cannot act on a member who outranks you; and cannot remove an owner
		// (transfer ownership first — preserves the last-owner invariant).
		assertCanManageTarget(context, member.role);
		if (member.role === "owner") {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Cannot remove organization owner. Transfer ownership first.",
			);
		}

		// Retain the local member until provider removal succeeds.
		const descopeTenantId = await getDescopeTenantId(db, organizationId);
		if (descopeTenantId && hasResolvedDescopeUserId(member.descopeUserId)) {
			const mgmt = getDescopeManagement(context.env, true);
			assertDescopeOk(
				await mgmt.management.user.removeTenant(
					member.descopeUserId,
					descopeTenantId,
				),
				"user.removeTenant",
			);
		}

		await removeMemberD1(db, memberId);

		return {
			success: true,
			message: `Member ${member.email} removed from organization`,
		};
	});

/**
 * Contract-based accept invitation procedure
 */
export const acceptInvitationContract = authedMembersOs.acceptInvitation
	.use(
		withAuthorization(
			{
				handlerOwnedUserAuthorization:
					"Invitation acceptance is identity-bound; the handler verifies the link target and invitation email against the human caller.",
			},
			"team:read",
		),
	)
	.handler(async ({ input, context }) => {
		const { db } = context;
		const { memberId, descopeUserId, name, avatarUrl } = input;

		assertInvitationLinkTarget(context, descopeUserId);

		// Get pending invitation
		const invitation = await getMemberById(db, memberId);

		if (!invitation) {
			throw createError(ErrorCodes.NOT_FOUND, "Invitation not found");
		}

		assertInvitationAddressedToCaller(context, invitation.email);

		// Acceptance can be retried safely after D1 has been updated but tenant
		// selection or the browser session broker was interrupted. It remains
		// strictly identity- and email-bound above; an active row for any other
		// account is never disclosed or accepted here.
		if (
			invitation.status === "active" &&
			invitation.descopeUserId === descopeUserId
		) {
			return {
				data: formatMemberResponse(invitation),
			};
		}

		if (invitation.status !== "invited") {
			throw createError(
				ErrorCodes.CONFLICT,
				"Invitation has already been accepted or is no longer valid",
			);
		}

		try {
			// Accept invitation and link Descope user ID
			const member = await acceptInvite(db, memberId, descopeUserId, {
				name,
				avatarUrl,
			});

			return {
				data: formatMemberResponse(member),
			};
		} catch (error) {
			console.error("[Teams] Accept invitation failed", {
				exception: safeExceptionTopology(error),
			});
			if (isD1ConstraintError(error)) {
				throw createError(
					ErrorCodes.CONFLICT,
					"This account is already a member of the workspace.",
				);
			}
			throw createError(
				ErrorCodes.INTERNAL_SERVER_ERROR,
				"Failed to accept invitation",
			);
		}
	});

export const setMemberIdentityContract = authedMembersOs.setMemberIdentity
	.use(withAuthorization("team:manage", "team:write"))
	.handler(async ({ input, context }) => {
		await requireOrganizationAccess(context, input.organizationId);
		requireAdminOrOwner(context);
		const member = await getMemberById(context.db, input.memberId);
		if (!member || member.organizationId !== input.organizationId) {
			throw createError(
				ErrorCodes.NOT_FOUND,
				"Member not found in this organization",
			);
		}
		assertCanManageTarget(context, member.role);
		const actor = auditActor(context);
		await emitAuditEvent(context.db, {
			organizationId: input.organizationId,
			actorId: actor.actorId,
			actorType: actor.actorType,
			action: "member.identity_requested",
			resourceType: "organization_member",
			resourceId: member.id,
			metadata: { ...actor.actorMetadata, ...input.identity },
		});
		const updated = await setMemberIdentity(
			context.db,
			input.organizationId,
			input.memberId,
			input.identity,
		);
		if (!updated)
			throw createError(
				ErrorCodes.CONFLICT,
				"Choose an active member and a different active human in this organization",
			);
		await emitAuditEvent(context.db, {
			organizationId: input.organizationId,
			actorId: actor.actorId,
			actorType: actor.actorType,
			action: "member.identity_set",
			resourceType: "organization_member",
			resourceId: member.id,
			metadata: {
				...actor.actorMetadata,
				kind: updated.kind,
				representedUserId: updated.representedUserId,
			},
		});
		return { data: formatMemberResponse(updated) };
	});

export const membersContractRouter = authedMembersOs.router({
	setMemberIdentity: setMemberIdentityContract,
	getMembershipReconciliation: getMembershipReconciliationContract,
	repairMembership: repairMembershipContract,
	listMembers: listMembersContract,
	getMember: getMemberContract,
	listRoles: listRolesContract,
	listPermissions: listPermissionsContract,
	listCapabilityScopes: listCapabilityScopesContract,
	inviteMember: inviteMemberContract,
	updateMemberRole: updateMemberRoleContract,
	setMemberPermissions: setMemberPermissionsContract,
	removeMember: removeMemberContract,
	acceptInvitation: acceptInvitationContract,
});

// =============================================================================
// TYPE EXPORTS
// =============================================================================
