import { eq } from "drizzle-orm";
import type { DbClient } from "../client";
import { coreTable } from "../core-store/client";
import { apps as d1Apps } from "../schema/apps";

export async function listMcpSubscriptionTargetsForCatalogApp(
	db: DbClient,
	catalogAppId: string,
): Promise<Array<{ id: string; organizationId: string }>> {
	const apps = coreTable(db, d1Apps);
	return db
		.select({ id: apps.id, organizationId: apps.organizationId })
		.from(apps)
		.where(eq(apps.catalogAppId, catalogAppId));
}
