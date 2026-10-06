import { and, eq, isNull } from "drizzle-orm";
import type { DbClient } from "../client";
import { apps } from "../schema/apps";
import { tedis } from "../schema/tedis";

/**
 * D1 side of the Descope/AIH drift comparison.
 *
 * Retired tedis are excluded: retirement deletes the Descope user, FGA
 * relations and AIH MCP server on purpose while keeping the D1 row (and its
 * memory) alive, so including them would report every retired worker as
 * permanent, unfixable drift.
 */
export async function loadDescopeAihD1SnapshotRows(
	db: DbClient,
	organizationId?: string,
) {
	const [appRows, tediRows] = await Promise.all([
		db
			.select({
				id: apps.id,
				slug: apps.slug,
				name: apps.name,
				metadata: apps.metadata,
			})
			.from(apps)
			.where(
				organizationId ? eq(apps.organizationId, organizationId) : undefined,
			),
		db
			.select({
				id: tedis.id,
				slug: tedis.slug,
				name: tedis.name,
				descopeMcpResourceId: tedis.descopeMcpResourceId,
				descopeUserId: tedis.descopeUserId,
				mcpCapabilityProfile: tedis.mcpCapabilityProfile,
			})
			.from(tedis)
			.where(
				organizationId
					? and(
							eq(tedis.organizationId, organizationId),
							isNull(tedis.retiredAt),
						)
					: isNull(tedis.retiredAt),
			),
	]);
	return { appRows, tediRows };
}
