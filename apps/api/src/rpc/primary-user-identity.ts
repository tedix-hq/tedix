import { createDbSession } from "@tedix/db/client";
import { resolveUserTenantIdentityContext } from "@tedix/db/queries/principal-identities";
import type { BaseContext } from "./context";

export async function resolvePrimaryUserIdentity(
	context: BaseContext,
	input: Parameters<typeof resolveUserTenantIdentityContext>[1],
) {
	if (context.env.ENVIRONMENT !== "production")
		return resolveUserTenantIdentityContext(context.db, input);
	// Authorization must see current membership, regardless of read routing or caller bookmarks.
	// Identity and review policy share one batch; a fenced cache adds serialized primary reads.
	const primary = createDbSession(context.env.DB, undefined, "first-primary");
	try {
		return await resolveUserTenantIdentityContext(primary.db, input);
	} finally {
		if (context.dbMetrics) {
			context.dbMetrics.queries += primary.metrics.queries;
			context.dbMetrics.rowsRead += primary.metrics.rowsRead;
			context.dbMetrics.rowsWritten += primary.metrics.rowsWritten;
			context.dbMetrics.withoutMeta += primary.metrics.withoutMeta;
		}
	}
}
