import { eq } from "drizzle-orm";
import { coreTable } from "../core-store/client";
import type { DbQueryClient } from "../query-client";
import { organizations as schemaOrganizations } from "../schema/organizations";

export async function getOrganizationModelFallback(
	db: DbQueryClient,
	organizationId: string,
) {
	const organizations = coreTable(db, schemaOrganizations);
	const [row] = await db
		.select({ metadata: organizations.metadata })
		.from(organizations)
		.where(eq(organizations.id, organizationId))
		.limit(1);
	return row?.metadata?.modelFallback ?? null;
}
