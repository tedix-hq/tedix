import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import {
	type DocsChange,
	docsBuilds,
	docsChanges,
} from "../../schema/docs-sites";

interface DocsActorParams {
	type: string;
	id: string;
	sessionId: string | null;
}

export interface CreateDocsChangeParams {
	id: string;
	siteId: string;
	path: string;
	message: string;
	baseRevision: string;
	proposalBranch: string;
	proposalRevision: string;
	contentSha256: string;
	proposedBy: DocsActorParams;
}

export interface SetDocsChangePreviewParams {
	changeId: string;
	buildId: string;
}

export interface MarkDocsChangeCommittedParams {
	changeId: string;
	revision: string;
	actor: DocsActorParams;
}

export async function getDocsChange(
	db: DbQueryClient,
	id: string,
): Promise<DocsChange | null> {
	const [change] = await db
		.select()
		.from(docsChanges)
		.where(eq(docsChanges.id, id))
		.limit(1);
	return change ?? null;
}

export function listDocsChanges(
	db: DbQueryClient,
	siteId: string,
): Promise<DocsChange[]> {
	return db
		.select()
		.from(docsChanges)
		.where(eq(docsChanges.siteId, siteId))
		.orderBy(desc(docsChanges.createdAt))
		.limit(50);
}

export async function createDocsChange(
	db: DbQueryClient,
	params: CreateDocsChangeParams,
): Promise<DocsChange> {
	const [change] = await db
		.insert(docsChanges)
		.values({
			id: params.id,
			siteId: params.siteId,
			status: "proposed",
			path: params.path,
			message: params.message,
			baseRevision: params.baseRevision,
			proposalBranch: params.proposalBranch,
			proposalRevision: params.proposalRevision,
			contentSha256: params.contentSha256,
			proposedByType: params.proposedBy.type,
			proposedById: params.proposedBy.id,
			proposedBySessionId: params.proposedBy.sessionId,
			createdAt: sql`(datetime('now'))`,
			updatedAt: sql`(datetime('now'))`,
		})
		.returning();
	if (!change) throw new Error("Failed to record documentation change");
	return change;
}

export async function setDocsChangePreview(
	db: DbQueryClient,
	params: SetDocsChangePreviewParams,
): Promise<DocsChange> {
	const [change] = await db
		.update(docsChanges)
		.set({
			status: "validating",
			previewBuildId: params.buildId,
			updatedAt: sql`(datetime('now'))`,
		})
		.where(
			and(
				eq(docsChanges.id, params.changeId),
				inArray(docsChanges.status, ["proposed", "validated"]),
			),
		)
		.returning();
	if (change) return change;
	const existing = await getDocsChange(db, params.changeId);
	if (!existing) throw new Error("Documentation change not found");
	return existing;
}

export async function markDocsChangeCommitted(
	db: DbQueryClient,
	params: MarkDocsChangeCommittedParams,
): Promise<DocsChange> {
	const [change] = await db
		.update(docsChanges)
		.set({
			status: "committed",
			committedRevision: params.revision,
			committedByType: params.actor.type,
			committedById: params.actor.id,
			committedBySessionId: params.actor.sessionId,
			committedAt: sql`(datetime('now'))`,
			updatedAt: sql`(datetime('now'))`,
		})
		.where(
			and(
				eq(docsChanges.id, params.changeId),
				inArray(docsChanges.status, ["proposed", "validating", "validated"]),
			),
		)
		.returning();
	if (!change) throw new Error("Documentation change is not committable");
	return change;
}

export async function syncDocsChangeValidation(
	db: DbQueryClient,
	change: Pick<DocsChange, "id" | "previewBuildId" | "status">,
): Promise<DocsChange> {
	const current = await getDocsChange(db, change.id);
	if (!current) throw new Error("Documentation change not found");
	if (!current.previewBuildId || current.status !== "validating")
		return current;
	const [build] = await db
		.select({ status: docsBuilds.status })
		.from(docsBuilds)
		.where(eq(docsBuilds.id, current.previewBuildId))
		.limit(1);
	if (!build || (build.status !== "complete" && build.status !== "failed")) {
		return current;
	}
	const [updated] = await db
		.update(docsChanges)
		.set({
			status: build.status === "complete" ? "validated" : "rejected",
			updatedAt: sql`(datetime('now'))`,
		})
		.where(
			and(eq(docsChanges.id, current.id), eq(docsChanges.status, "validating")),
		)
		.returning();
	return updated ?? (await getDocsChange(db, current.id)) ?? current;
}
