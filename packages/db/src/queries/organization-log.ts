import type { DbQueryClient } from "../query-client";
import {
	ORGANIZATION_LOG_CUTOVER_ALL,
	organizationLogCutoverAllowlist,
} from "../schema/organization-log";

/**
 * The organizations the log cutover may move: `"all"`, or the named ids
 * (empty: none).
 */
export async function getOrganizationLogCutoverAllowlist(
	db: DbQueryClient,
): Promise<"all" | ReadonlySet<string>> {
	const rows = await db
		.select({ organizationId: organizationLogCutoverAllowlist.organizationId })
		.from(organizationLogCutoverAllowlist);
	if (rows.some((row) => row.organizationId === ORGANIZATION_LOG_CUTOVER_ALL))
		return "all";
	return new Set(rows.map((row) => row.organizationId));
}
