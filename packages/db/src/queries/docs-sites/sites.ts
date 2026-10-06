import { and, desc, eq, sql } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import { type DocsSite, docsSites } from "../../schema/docs-sites";
import { organizations } from "../../schema/organizations";

export interface UpsertDocsSiteParams {
	id?: string;
	orgSlug: string;
	slug: string;
	title: string;
	description: string;
	locale: string;
	canonicalUrl: string;
	sourceProvider: DocsSite["sourceProvider"];
	sourceAuthMode: DocsSite["sourceAuthMode"];
	repositoryUrl: string | null;
	artifactsRepository: string | null;
	branch: string;
	contentRoot: string;
	accessMode: DocsSite["accessMode"];
}

export interface RuntimeDocsSiteRow {
	id: string;
	orgSlug: string;
	slug: string;
	status: DocsSite["status"];
	accessMode: DocsSite["accessMode"];
	activeBuildId: string | null;
	descopeTenantId: string | null;
}

export async function getDocsSiteById(
	db: DbQueryClient,
	id: string,
): Promise<DocsSite | null> {
	const [site] = await db
		.select()
		.from(docsSites)
		.where(eq(docsSites.id, id))
		.limit(1);
	return site ?? null;
}

export async function getDocsSiteBySlug(
	db: DbQueryClient,
	slug: string,
): Promise<DocsSite | null> {
	const [site] = await db
		.select()
		.from(docsSites)
		.where(eq(docsSites.slug, slug))
		.limit(1);
	return site ?? null;
}

export async function getRuntimeDocsSiteBySlug(
	db: DbQueryClient,
	slug: string,
): Promise<RuntimeDocsSiteRow | null> {
	const [site] = await db
		.select({
			id: docsSites.id,
			orgSlug: docsSites.orgSlug,
			slug: docsSites.slug,
			status: docsSites.status,
			accessMode: docsSites.accessMode,
			activeBuildId: docsSites.activeBuildId,
			descopeTenantId: organizations.descopeTenantId,
		})
		.from(docsSites)
		.innerJoin(organizations, eq(docsSites.orgSlug, organizations.slug))
		.where(eq(docsSites.slug, slug))
		.limit(1);
	return site ?? null;
}

export function listDocsSites(
	db: DbQueryClient,
	orgSlug: string,
): Promise<DocsSite[]> {
	return db
		.select()
		.from(docsSites)
		.where(eq(docsSites.orgSlug, orgSlug))
		.orderBy(desc(docsSites.createdAt))
		.limit(100);
}

export async function setDocsSiteStatus(
	db: DbQueryClient,
	params: { id: string; orgSlug: string; status: DocsSite["status"] },
): Promise<DocsSite | null> {
	const [site] = await db
		.update(docsSites)
		.set({ status: params.status, updatedAt: sql`(datetime('now'))` })
		.where(
			and(eq(docsSites.id, params.id), eq(docsSites.orgSlug, params.orgSlug)),
		)
		.returning();
	return site ?? null;
}

export async function upsertDocsSite(
	db: DbQueryClient,
	params: UpsertDocsSiteParams,
): Promise<DocsSite> {
	const id = params.id ?? crypto.randomUUID();
	const [site] = await db
		.insert(docsSites)
		.values({
			id,
			orgSlug: params.orgSlug,
			slug: params.slug,
			title: params.title,
			description: params.description,
			locale: params.locale,
			canonicalUrl: params.canonicalUrl,
			sourceProvider: params.sourceProvider,
			sourceAuthMode: params.sourceAuthMode,
			repositoryUrl: params.repositoryUrl,
			artifactsRepository: params.artifactsRepository,
			branch: params.branch,
			contentRoot: params.contentRoot,
			accessMode: params.accessMode,
			status: "active",
			createdAt: sql`(datetime('now'))`,
			updatedAt: sql`(datetime('now'))`,
		})
		.onConflictDoUpdate({
			target: docsSites.id,
			set: {
				slug: params.slug,
				title: params.title,
				description: params.description,
				locale: params.locale,
				canonicalUrl: params.canonicalUrl,
				sourceProvider: params.sourceProvider,
				sourceAuthMode: params.sourceAuthMode,
				repositoryUrl: params.repositoryUrl,
				artifactsRepository: params.artifactsRepository,
				branch: params.branch,
				contentRoot: params.contentRoot,
				accessMode: params.accessMode,
				updatedAt: sql`(datetime('now'))`,
			},
			setWhere: eq(docsSites.orgSlug, params.orgSlug),
		})
		.returning();
	if (!site || site.orgSlug !== params.orgSlug) {
		throw new Error("Site not found or tenant ownership mismatch");
	}
	return site;
}
