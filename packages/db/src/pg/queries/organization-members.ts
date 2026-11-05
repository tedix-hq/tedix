import { and, desc, eq } from "drizzle-orm";
import type {
	MemberRole,
	MemberStatus,
} from "../../schema/organization-members";
import type { PgQueryClient } from "../query-client";
import { organizationMembers } from "../schema/organizations";

export async function getMembersByOrganization(
	db: PgQueryClient,
	organizationId: string,
	options: {
		status?: MemberStatus;
		role?: MemberRole;
		limit?: number;
		offset?: number;
	} = {},
) {
	return db
		.select()
		.from(organizationMembers)
		.where(
			and(
				eq(organizationMembers.organizationId, organizationId),
				options.status
					? eq(organizationMembers.status, options.status)
					: undefined,
				options.role ? eq(organizationMembers.role, options.role) : undefined,
			),
		)
		.orderBy(desc(organizationMembers.createdAt))
		.limit(options.limit ?? 100)
		.offset(options.offset ?? 0);
}
