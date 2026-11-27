import { and, eq, inArray, sql, type SQLWrapper } from "drizzle-orm";
import { coreTable } from "../../core-store/client";
import type { DbQueryClient } from "../../query-client";
import { kernelRuntimeRuns as d1KernelRuntimeRuns } from "../../schema/cognitive-runtime";
import {
	osReviewBatches as d1OsReviewBatches,
	osShareLinks as d1OsShareLinks,
} from "../../schema/os-shares";
import {
	osCollaborationProposals as d1OsCollaborationProposals,
	osWorkspaces as d1OsWorkspaces,
} from "../../schema/os-workspaces";
import { workEvidence as d1WorkEvidence } from "../../schema/work-items";
import {
	workspaceActivity as d1WorkspaceActivity,
	workspaceOutputIndex as d1WorkspaceOutputIndex,
} from "../../schema/workspace-feed";

/**
 * Thinning of editor auto-save revisions.
 *
 * An editor saves a moment after each pause in typing, so one day of
 * editing leaves hundreds of revisions that differ by a few words. History
 * stays useful with far fewer. A revision may be removed only when ALL of
 * this holds:
 *
 * - it is an auto-save: written by a person, by no skill run, with the
 *   auto-save note (`autosaveNote`);
 * - it is older than `olderThan` (a day: an open editor may still send an
 *   edit based on anything younger);
 * - it is neither the file's current, newest nor first revision;
 * - a later revision of the same file by the same person exists in the same
 *   ten-minute window, so one per window always stays;
 * - nothing points at it: no activity entry, share link, change proposal
 *   (as base or result), chat run receipt, review batch or Work evidence.
 *
 * Revisions written by agents, saves someone asked for, restores and merged
 * proposals never carry the auto-save note, so they are never candidates.
 * Revision numbers are not reused: the next number is always the highest
 * existing one plus one, and the newest revision is never removed.
 */

export const OUTPUT_THINNING_MAX_WINDOW = 5_000;
/** Ids travel as bound parameters, which D1 caps at 100 per statement. */
export const OUTPUT_THINNING_MAX_LIMIT = 40;
/** Seconds in one window that keeps one auto-save per file and person. */
export const OUTPUT_THINNING_WINDOW_SECONDS = 600;
/** Workspace stores inventoried per body-collection pass; larger orgs skip bodies. */
export const OUTPUT_THINNING_MAX_REFERENCE_WORKSPACES = 500;

export interface OutputThinningCandidate {
	rowid: number;
	revisionId: string;
	workspaceId: string | null;
	organizationId: string;
	outputId: string;
	revision: number;
	/** Stored body size; several revisions may share one stored body. */
	bytes: number;
	/** R2 object holding the revision body; null for inline legacy rows. */
	bodyR2Key: string | null;
}

/** Core references protect revisions regardless of which store owns their bodies. */
function outputRevisionUnreferenced(
	db: DbQueryClient,
	revisionId: SQLWrapper,
	outputId: SQLWrapper,
	revision: SQLWrapper,
) {
	const workspaceActivity = coreTable(db, d1WorkspaceActivity);
	const osShareLinks = coreTable(db, d1OsShareLinks);
	const osCollaborationProposals = coreTable(db, d1OsCollaborationProposals);
	const kernelRuntimeRuns = coreTable(db, d1KernelRuntimeRuns);
	const osReviewBatches = coreTable(db, d1OsReviewBatches);
	const workEvidence = coreTable(db, d1WorkEvidence);
	return sql`NOT EXISTS (
				SELECT 1 FROM ${workspaceActivity}
				WHERE ${workspaceActivity.entityId} = ${outputId}
				AND ${workspaceActivity.revision} = ${revision}
				AND ${workspaceActivity.changeRecordId} = ${revisionId})
			AND NOT EXISTS (
				SELECT 1 FROM ${osShareLinks}
				WHERE ${osShareLinks.pinnedRevisionId} = ${revisionId})
			AND NOT EXISTS (
				SELECT 1 FROM ${osCollaborationProposals}
				WHERE ${osCollaborationProposals.baseRevisionId} = ${revisionId}
				OR ${osCollaborationProposals.resultRevisionId} = ${revisionId})
			AND NOT EXISTS (
				SELECT 1 FROM ${kernelRuntimeRuns}
				WHERE ${kernelRuntimeRuns.outputRevisionId} = ${revisionId})
			AND NOT EXISTS (
				SELECT 1 FROM ${osReviewBatches}
				WHERE ${osReviewBatches.sourceRevisionId} = ${revisionId})
			AND NOT EXISTS (
				SELECT 1 FROM ${workEvidence}
				WHERE ${workEvidence.uri} = 'output://' || ${outputId} || '/revisions/' || ${revisionId}
				OR ${workEvidence.uri} LIKE '/os-exports/' || ${outputId} || '/rev-' || ${revision} || '.%')`;
}

export async function getOutputIndexMaxRowid(
	db: DbQueryClient,
): Promise<number> {
	const [row] = await db
		.select({
			maxRowid:
				sql<number>`coalesce(max(${d1WorkspaceOutputIndex}.rowid), 0)`.as(
					"max_rowid",
				),
		})
		.from(d1WorkspaceOutputIndex);
	return row?.maxRowid ?? 0;
}

/**
 * Auto-save revisions in `(after, through]` of the output index that the
 * policy above allows to remove, oldest first. The owning workspace store
 * rechecks and deletes them.
 */
export async function listObjectOutputThinningCandidates(
	db: DbQueryClient,
	params: {
		after: number;
		through: number;
		limit: number;
		/** ISO time; only revisions created before it are considered. */
		olderThan: string;
		autosaveNote: string;
	},
): Promise<OutputThinningCandidate[]> {
	if (
		![params.after, params.through, params.limit].every(Number.isSafeInteger) ||
		params.after < 0 ||
		params.through < params.after ||
		params.through - params.after > OUTPUT_THINNING_MAX_WINDOW ||
		params.limit < 1 ||
		params.limit > OUTPUT_THINNING_MAX_LIMIT ||
		Number.isNaN(Date.parse(params.olderThan)) ||
		!params.autosaveNote
	)
		throw new Error("Invalid output thinning bounds");
	const i = d1WorkspaceOutputIndex;
	const indexRowid = sql<number>`${i}.rowid`;
	const window = sql`CAST(${OUTPUT_THINNING_WINDOW_SECONDS} AS INTEGER)`;
	return db
		.select({
			rowid: indexRowid.as("index_rowid"),
			revisionId: i.revisionId,
			organizationId: i.organizationId,
			workspaceId: i.workspaceId,
			outputId: i.outputId,
			revision: i.revision,
			bytes: sql<number>`coalesce(${i.contentBytes}, 0)`.as("revision_bytes"),
			bodyR2Key: i.bodyR2Key,
		})
		.from(i)
		.where(sql`${indexRowid} > ${params.after} AND ${indexRowid} <= ${params.through}

 AND ${i.revisionCreatedByKind} = 'user' AND ${i.skillRunId} IS NULL
 AND substr(${i.note}, 1, ${params.autosaveNote.length}) = ${params.autosaveNote}
 AND unixepoch(${i.revisionCreatedAt}) < ${Math.floor(Date.parse(params.olderThan) / 1000)}
 AND ${i.isCurrent} = 0
 AND ${i.revision} > (SELECT min(first.revision) FROM ${i} AS first WHERE first.output_id = ${i.outputId})
 AND ${i.revision} < (SELECT max(newest.revision) FROM ${i} AS newest WHERE newest.output_id = ${i.outputId})
 AND EXISTS (SELECT 1 FROM ${i} AS kept WHERE kept.output_id = ${i.outputId}
 AND kept.revision_created_by_kind = ${i.revisionCreatedByKind} AND kept.revision_created_by_id = ${i.revisionCreatedById}
 AND kept.revision > ${i.revision} AND unixepoch(kept.revision_created_at) / ${window} = unixepoch(${i.revisionCreatedAt}) / ${window})
 AND ${outputRevisionUnreferenced(db, i.revisionId, i.outputId, i.revision)}`)
		.orderBy(indexRowid)
		.limit(params.limit);
}

/** Called only after the owning object confirms deletion; safe to repeat after a lost response. */
export async function deleteThinnedOutputIndex(
	db: DbQueryClient,
	revisionIds: readonly string[],
) {
	if (!revisionIds.length) return;
	if (revisionIds.length > OUTPUT_THINNING_MAX_LIMIT)
		throw new Error("Too many revisions in one thinning batch");
	const workspaceOutputIndex = coreTable(db, d1WorkspaceOutputIndex);
	await db.delete(workspaceOutputIndex).where(
		and(
			// bound-params: the function rejects more than 40 revision ids.
			inArray(workspaceOutputIndex.revisionId, [...revisionIds]),
			eq(workspaceOutputIndex.isCurrent, 0),
		),
	);
}

/** Recheck core references at the owner boundary, including pins added after candidate selection. */
export async function unreferencedObjectOutputRevisions(
	db: DbQueryClient,
	scope: { organizationId: string; workspaceId: string; outputId: string },
	revisionIds: string[],
): Promise<string[]> {
	if (!revisionIds.length) return [];
	if (revisionIds.length > OUTPUT_THINNING_MAX_LIMIT)
		throw new Error("Too many revisions in one thinning batch");
	const i = coreTable(db, d1WorkspaceOutputIndex);
	return (
		await db
			.select({ id: i.revisionId })
			.from(i)
			.where(
				and(
					eq(i.organizationId, scope.organizationId),
					eq(i.workspaceId, scope.workspaceId),
					eq(i.outputId, scope.outputId),
					// bound-params: the function rejects more than 40 revision ids.
					inArray(i.revisionId, revisionIds),
					eq(i.isCurrent, 0),
					outputRevisionUnreferenced(db, i.revisionId, i.outputId, i.revision),
				),
			)
	).map((row) => row.id);
}

/**
 * Every workspace store that can still reference an organization body. Null
 * means the inventory was truncated, so callers must not delete bodies.
 */
export async function listOutputBodyReferenceWorkspaces(
	db: DbQueryClient,
	organizationId: string,
): Promise<string[] | null> {
	const osWorkspaces = coreTable(db, d1OsWorkspaces);
	const rows = await db
		.select({ id: osWorkspaces.id })
		.from(osWorkspaces)
		.where(eq(osWorkspaces.organizationId, organizationId))
		.limit(OUTPUT_THINNING_MAX_REFERENCE_WORKSPACES + 1);
	if (rows.length > OUTPUT_THINNING_MAX_REFERENCE_WORKSPACES) return null;
	return rows.map((row) => row.id);
}
