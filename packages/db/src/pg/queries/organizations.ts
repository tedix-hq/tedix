import { and, desc, eq, sql } from "drizzle-orm";
import type { PgQueryClient } from "../query-client";
import { organizations } from "../schema/organizations";

export async function getOrganizationById(db: PgQueryClient, id: string) {
	const [row] = await db
		.select()
		.from(organizations)
		.where(eq(organizations.id, id))
		.limit(1);
	return row;
}

export async function getOrganizationBySlug(db: PgQueryClient, slug: string) {
	const [row] = await db
		.select()
		.from(organizations)
		.where(
			and(
				eq(organizations.slug, slug.toLowerCase()),
				sql`${organizations.metadata} ->> 'retiredAt' IS NULL`,
			),
		)
		.limit(1);
	return row;
}

export async function listOrganizations(
	db: PgQueryClient,
	options: { limit?: number; offset?: number } = {},
) {
	return db
		.select()
		.from(organizations)
		.where(sql`${organizations.metadata} ->> 'retiredAt' IS NULL`)
		.orderBy(desc(organizations.createdAt))
		.limit(options.limit ?? 50)
		.offset(options.offset ?? 0);
}

export async function getOrganizationGuestProfile(
	db: PgQueryClient,
	id: string,
) {
	const [row] = await db
		.select({
			name: organizations.name,
			logoUrl: organizations.logoUrl,
			locale: sql<
				string | null
			>`${organizations.metadata} #>> '{tediWidget,locale}'`,
			translations: sql<Record<
				string,
				Record<string, unknown>
			> | null>`${organizations.metadata} #> '{tediWidget,translations}'`,
		})
		.from(organizations)
		.where(eq(organizations.id, id))
		.limit(1);
	return row ?? null;
}
