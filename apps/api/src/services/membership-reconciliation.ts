import type { MembershipDivergence } from "@tedix/api-contract/schemas/organization";
import { assertDescopeOk } from "@tedix/auth/descope";
import type { DbClient } from "@tedix/db/client";
import { getMembersByOrganization } from "@tedix/db/queries/organization-members";
import type { getDescopeManagement } from "../lib/descope-management";
import { createError, ErrorCodes } from "../rpc/orpc";

type Management = NonNullable<ReturnType<typeof getDescopeManagement>>;
type ProviderUser = NonNullable<
	Awaited<ReturnType<Management["management"]["user"]["search"]>>["data"]
>["users"][number];

const PAGE_SIZE = 100;
const MAX_PAGES = 100;
const normalizedEmail = (email: string) => email.trim().toLowerCase();

export function descopeTenantRolesForMemberRole(
	role: NonNullable<MembershipDivergence["role"]>,
): string[] {
	return role === "owner" ? [role, "admin"] : [role];
}

export async function readMembershipReconciliation(
	db: DbClient,
	mgmt: Management,
	organizationId: string,
	tenantId: string,
) {
	const members: Awaited<ReturnType<typeof getMembersByOrganization>> = [];
	const users: ProviderUser[] = [];
	// Never allow a truncated inventory to authorize removal of a member.
	let d1Complete = false;
	let descopeComplete = false;
	let providerCount = 0;
	for (let page = 0; page < MAX_PAGES; page++) {
		const batch = await getMembersByOrganization(db, organizationId, {
			limit: PAGE_SIZE,
			offset: page * PAGE_SIZE,
		});
		members.push(...batch);
		if (batch.length < PAGE_SIZE) {
			d1Complete = true;
			break;
		}
	}
	for (let page = 0; page < MAX_PAGES; page++) {
		const response = await mgmt.management.user.search({
			tenantIds: [tenantId],
			limit: PAGE_SIZE,
			page,
		});
		assertDescopeOk(response, "user.search");
		if (!response.data?.users) {
			throw createError(
				ErrorCodes.INTERNAL_SERVER_ERROR,
				"Descope inventory unavailable",
			);
		}
		users.push(
			...response.data.users.filter(
				(user) =>
					user.customAttributes?.entityType !== "tedi" &&
					user.userTenants?.some((tenant) => tenant.tenantId === tenantId),
			),
		);
		if (response.data.users.length < PAGE_SIZE) {
			providerCount += response.data.users.length;
			if (response.data.total > providerCount) {
				throw createError(
					ErrorCodes.CONFLICT,
					"Descope inventory is incomplete; no repair is safe",
				);
			}
			descopeComplete = true;
			break;
		}
		providerCount += response.data.users.length;
	}
	if (!d1Complete || !descopeComplete) {
		throw createError(
			ErrorCodes.CONFLICT,
			"Membership inventory exceeds reconciliation limit; no repair is safe",
		);
	}

	const divergences: MembershipDivergence[] = [];
	const matched = new Set<string>();
	const bySubject = new Map(users.map((user) => [user.userId, user]));
	const byEmail = new Map<string, ProviderUser[]>();
	for (const user of users) {
		if (!user.email) continue;
		const email = normalizedEmail(user.email);
		const matches = byEmail.get(email) ?? [];
		matches.push(user);
		byEmail.set(email, matches);
	}
	for (const member of members) {
		const pending = member.descopeUserId.startsWith("pending:");
		const subject = bySubject.get(member.descopeUserId);
		const candidates = pending
			? (byEmail.get(normalizedEmail(member.email)) ?? [])
			: subject
				? [subject]
				: [];
		// An ambiguous email does not authorize choosing or removing an identity.
		if (candidates.length > 1) {
			for (const candidate of candidates) matched.add(candidate.userId);
			divergences.push({
				kind: "identity_conflict",
				memberId: member.id,
				descopeUserId: null,
				email: member.email,
				role: member.role,
				descopeRoles: [],
			});
			continue;
		}
		const user = candidates.length === 1 ? candidates[0] : undefined;
		if (user) matched.add(user.userId);
		const enabled = member.status === "active" || member.status === "invited";
		const roles =
			user?.userTenants?.find((tenant) => tenant.tenantId === tenantId)
				?.roleNames ?? [];
		const expectedRoles = descopeTenantRolesForMemberRole(member.role);
		const roleMismatch =
			user &&
			(roles.length !== expectedRoles.length ||
				expectedRoles.some((role) => !roles.includes(role)));
		if ((enabled && (!user || roleMismatch)) || (!enabled && user)) {
			divergences.push({
				kind: !enabled
					? "inactive_d1"
					: user
						? "role_mismatch"
						: "missing_descope",
				memberId: member.id,
				descopeUserId: user?.userId ?? (pending ? null : member.descopeUserId),
				email: member.email,
				role: member.role,
				descopeRoles: roles,
			});
		}
	}
	for (const user of users) {
		if (!matched.has(user.userId)) {
			divergences.push({
				kind: "missing_d1",
				memberId: null,
				descopeUserId: user.userId,
				email: user.email ?? null,
				role: null,
				descopeRoles:
					user.userTenants?.find((tenant) => tenant.tenantId === tenantId)
						?.roleNames ?? [],
			});
		}
	}
	return {
		members,
		report: { tenantId, checkedAt: new Date().toISOString(), divergences },
	};
}
