import { getMemberByUserId } from "@tedix/db/queries/organization-members";
import type { BaseContext } from "./context";

/** Reuse authentication's member only for the exact organization and subject. */
export async function getRequestOrganizationMembership(
	context: BaseContext,
	organizationId: string,
	subject: string,
) {
	const membership = context.organizationMembership;
	if (
		membership?.organizationId === organizationId &&
		membership.subject === subject
	)
		return membership;
	return getMemberByUserId(context.db, organizationId, subject);
}
