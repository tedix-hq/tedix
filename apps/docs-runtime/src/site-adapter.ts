import { getRuntimeDocsSiteBySlug as queryRuntimeDocsSiteBySlug } from "@tedix/db/queries/docs-sites/sites";
import type { DbQueryClient } from "@tedix/db/query-client";
import type { RuntimeDocsSite } from "./serving";

/** Load a DB-native site row and narrow it to the static-serving contract. */
export async function getRuntimeDocsSiteBySlug(
	db: DbQueryClient,
	slug: string,
): Promise<RuntimeDocsSite | null> {
	const row = await queryRuntimeDocsSiteBySlug(db, slug);
	if (!row) return null;
	return {
		id: row.id,
		orgSlug: row.orgSlug,
		slug: row.slug,
		status: row.status,
		accessMode: row.accessMode,
		activeBuildId: row.activeBuildId,
		descopeTenantId: row.descopeTenantId,
	};
}
