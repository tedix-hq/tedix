import {
	getMemberByCanonicalUserId,
	getMemberByUserId,
} from "@tedix/db/queries/organization-members";
import type { BaseContext } from "./context";

/** Reuse the persisted row only when it matches the requested lookup key. */
export async function getRequestOrganizationMembership(
	context: BaseContext,
	organizationId: string,
	subject: string,
	lookup: { canonicalUserId?: string; fallbackToSubject?: boolean } = {},
) {
	const member = context.organizationMembership;
	if (
		member?.organizationId === organizationId &&
		member.subject === subject &&
		member.id !== undefined &&
		member.userId !== undefined &&
		member.descopeUserId !== undefined &&
		member.kind !== undefined &&
		member.customPermissions !== undefined &&
		(lookup.canonicalUserId
			? member.userId === lookup.canonicalUserId
			: member.descopeUserId === subject ||
				(context.oidcScopes !== undefined && member.userId === subject))
	) {
		return {
			id: member.id,
			organizationId,
			userId: member.userId,
			descopeUserId: member.descopeUserId,
			kind: member.kind,
			role: member.role,
			status: member.status,
			customPermissions: member.customPermissions,
		};
	}
	if (lookup.canonicalUserId) {
		const canonical = await getMemberByCanonicalUserId(
			context.db,
			organizationId,
			lookup.canonicalUserId,
		);
		if (canonical || lookup.fallbackToSubject === false) return canonical;
	}
	return getMemberByUserId(context.db, organizationId, subject);
}

/** True only for a live membership row whose role is owner or admin. */
export async function isActiveOwnerOrAdmin(
	context: BaseContext,
	organizationId: string,
	userId: string,
): Promise<boolean> {
	const member = await getRequestOrganizationMembership(
		context,
		organizationId,
		userId,
	);
	return (
		member?.status === "active" && ["owner", "admin"].includes(member.role)
	);
}
