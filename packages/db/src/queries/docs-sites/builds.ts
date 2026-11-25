import { and, desc, eq, ne, sql } from "drizzle-orm";
import { coreTable } from "../../core-store/client";
import type { DbQueryClient } from "../../query-client";
import {
	type DocsBuild,
	docsBuilds as d1DocsBuilds,
	docsSites as d1DocsSites,
} from "../../schema/docs-sites";
import { docsNow } from "./clock";

interface DocsActorParams {
	type: string;
	id: string;
	sessionId: string | null;
}

export interface CreateDocsBuildParams {
	id?: string;
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
	const docsBuilds = coreTable(db, d1DocsBuilds);
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
	const docsBuilds = coreTable(db, d1DocsBuilds);
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
	const docsBuilds = coreTable(db, d1DocsBuilds);
	const docsSites = coreTable(db, d1DocsSites);
	const id = params.id ?? crypto.randomUUID();
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
			createdAt: docsNow(db),
		})
		.returning();
	const updateSite = db
		.update(docsSites)
		.set({
			latestBuildId: id,
			updatedAt: docsNow(db),
		})
		.where(eq(docsSites.id, params.siteId));

	const [created] = await db.batch([insertBuild, updateSite]);
	const build = created[0];
	if (!build) throw new Error("Failed to create docs build");
	return build;
}

/**
 * A complete build is terminal. Progress and completion writes carry this
 * predicate in the same statement, so a stale running/failed notification or
 * a duplicate completion can never reopen or rewrite it; a failed build stays
 * open for workflow retries.
 */
export async function updateDocsBuildProgress(
	db: DbQueryClient,
	params: UpdateDocsBuildProgressParams,
): Promise<void> {
	const docsBuilds = coreTable(db, d1DocsBuilds);
	await db
		.update(docsBuilds)
		.set({
			status: params.status,
			phase: params.phase,
			error: params.error ?? null,
			sourceRevision: sql`coalesce(${params.sourceRevision ?? null}, ${docsBuilds.sourceRevision})`,
			startedAt: sql`coalesce(${docsBuilds.startedAt}, ${docsNow(db)})`,
			finishedAt:
				params.status === "failed" ? docsNow(db) : docsBuilds.finishedAt,
		})
		.where(
			and(eq(docsBuilds.id, params.buildId), ne(docsBuilds.status, "complete")),
		);
}

export async function completeDocsBuild(
	db: DbQueryClient,
	params: CompleteDocsBuildParams,
): Promise<void> {
	const docsBuilds = coreTable(db, d1DocsBuilds);
	await db
		.update(docsBuilds)
		.set({
			status: "complete",
			phase: "ready",
			sourceRevision: params.sourceRevision,
			manifestKey: params.manifestKey,
			error: null,
			finishedAt: docsNow(db),
		})
		.where(
			and(
				eq(docsBuilds.id, params.buildId),
				eq(docsBuilds.siteId, params.siteId),
				ne(docsBuilds.status, "complete"),
			),
		);
}
