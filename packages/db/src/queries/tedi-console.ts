import { and, eq } from "drizzle-orm";
import type { DbQueryClient } from "../query-client";
import { tediConsoleGrants } from "../schema/tedi-console";
export async function getTediConsoleGrant(
	db: DbQueryClient,
	organizationId: string,
	tediId: string,
) {
	return (
		await db
			.select()
			.from(tediConsoleGrants)
			.where(
				and(
					eq(tediConsoleGrants.organizationId, organizationId),
					eq(tediConsoleGrants.tediId, tediId),
				),
			)
			.limit(1)
	)[0];
}
export async function setTediConsoleGrant(
	db: DbQueryClient,
	value: typeof tediConsoleGrants.$inferInsert,
) {
	return (
		await db
			.insert(tediConsoleGrants)
			.values(value)
			.onConflictDoUpdate({
				target: [tediConsoleGrants.organizationId, tediConsoleGrants.tediId],
				set: {
					enabled: value.enabled,
					workspaceIds: value.workspaceIds,
					revision: value.revision,
					grantedBy: value.grantedBy,
					updatedAt: value.updatedAt,
				},
			})
			.returning()
	)[0]!;
}
