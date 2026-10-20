import { eq } from "drizzle-orm";
import type { DbQueryClient } from "../query-client";
import { organizations } from "../schema/organizations";

export async function getOrganizationModelFallback(
	db: DbQueryClient,
	organizationId: string,
) {
	const [row] = await db
		.select({ metadata: organizations.metadata })
		.from(organizations)
		.where(eq(organizations.id, organizationId))
		.limit(1);
	return row?.metadata?.modelFallback ?? null;
}
