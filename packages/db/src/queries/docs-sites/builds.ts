import { and, desc, eq, sql } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import { type DocsBuild, docsBuilds, docsSites } from "../../schema/docs-sites";

interface DocsActorParams {
	type: string;
	id: string;
	sessionId: string | null;
}

export interface CreateDocsBuildParams {
	siteId: string;
	sourceBranch: string;
	proposalId?: string | null;
	requestedBy: DocsActorParams;
}

export interface UpdateDocsBuildProgressParams {
	buildId: string;
	status: "running" | "failed";
	phase: string;
	error?: string | null;
	sourceRevision?: string | null;
}

export interface CompleteDocsBuildParams {
	buildId: string;
	siteId: string;
	sourceRevision: string;
	manifestKey: string;
}

export async function getDocsBuild(
	db: DbQueryClient,
	id: string,
): Promise<DocsBuild | null> {
	const [build] = await db
		.select()
		.from(docsBuilds)
		.where(eq(docsBuilds.id, id))
		.limit(1);
	return build ?? null;
}

export function listDocsBuilds(
	db: DbQueryClient,
	siteId: string,
): Promise<DocsBuild[]> {
	return db
		.select()
		.from(docsBuilds)
		.where(eq(docsBuilds.siteId, siteId))
		.orderBy(desc(docsBuilds.createdAt))
		.limit(50);
}

export async function createDocsBuild(
	db: DbQueryClient,
	params: CreateDocsBuildParams,
): Promise<DocsBuild> {
	const id = crypto.randomUUID();
	const insertBuild = db
		.insert(docsBuilds)
		.values({
			id,
			siteId: params.siteId,
			status: "queued",
			phase: "queued",
			sourceBranch: params.sourceBranch,
			proposalId: params.proposalId ?? null,
			requestedByType: params.requestedBy.type,
			requestedById: params.requestedBy.id,
			requestedBySessionId: params.requestedBy.sessionId,
			createdAt: sql`(datetime('now'))`,
		})
		.returning();
	const updateSite = db
		.update(docsSites)
		.set({
			latestBuildId: id,
			updatedAt: sql`(datetime('now'))`,
		})
		.where(eq(docsSites.id, params.siteId));

	const [created] = await db.batch([insertBuild, updateSite]);
	const build = created[0];
	if (!build) throw new Error("Failed to create docs build");
	return build;
}

export async function updateDocsBuildProgress(
	db: DbQueryClient,
	params: UpdateDocsBuildProgressParams,
): Promise<void> {
	await db
		.update(docsBuilds)
		.set({
			status: params.status,
			phase: params.phase,
			error: params.error ?? null,
			sourceRevision: sql`coalesce(${params.sourceRevision ?? null}, ${docsBuilds.sourceRevision})`,
			startedAt: sql`coalesce(${docsBuilds.startedAt}, datetime('now'))`,
			finishedAt:
				params.status === "failed"
					? sql`(datetime('now'))`
					: docsBuilds.finishedAt,
		})
		.where(eq(docsBuilds.id, params.buildId));
}

export async function completeDocsBuild(
	db: DbQueryClient,
	params: CompleteDocsBuildParams,
): Promise<void> {
	await db
		.update(docsBuilds)
		.set({
			status: "complete",
			phase: "ready",
			sourceRevision: params.sourceRevision,
			manifestKey: params.manifestKey,
			error: null,
			finishedAt: sql`(datetime('now'))`,
		})
		.where(
			and(
				eq(docsBuilds.id, params.buildId),
				eq(docsBuilds.siteId, params.siteId),
			),
		);
}
