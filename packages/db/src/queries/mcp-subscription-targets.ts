import { eq } from "drizzle-orm";
import type { DbClient } from "../client";
import { apps } from "../schema/apps";

export async function listMcpSubscriptionTargetsForCatalogApp(
	db: DbClient,
	catalogAppId: string,
): Promise<Array<{ id: string; organizationId: string }>> {
	return db
		.select({ id: apps.id, organizationId: apps.organizationId })
		.from(apps)
		.where(eq(apps.catalogAppId, catalogAppId));
}
