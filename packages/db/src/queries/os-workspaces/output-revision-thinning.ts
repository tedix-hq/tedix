import { and, eq, inArray, sql, type SQLWrapper } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import { kernelRuntimeRuns } from "../../schema/cognitive-runtime";
import { osReviewBatches, osShareLinks } from "../../schema/os-shares";
import { osCollaborationProposals } from "../../schema/os-workspaces";
import { workEvidence } from "../../schema/work-items";
import {
	workspaceActivity,
	workspaceOutputIndex,
} from "../../schema/workspace-feed";

/**
 * Thinning of editor auto-save revisions.
 *
 * An editor saves a moment after each pause in typing, so one hour of
 * editing leaves hundreds of revisions that differ by a few words. History
 * stays useful with far fewer. A revision may be removed only when ALL of
 * this holds:
 *
 * - it is an auto-save: written by a person, by no skill run, with the
 *   auto-save note (`autosaveNote`);
 * - it is older than `olderThan` (an hour: an open editor may still send an
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

export interface OutputThinningCandidate {
	rowid: number;
	revisionId: string;
	workspaceId: string | null;
	organizationId: string;
	outputId: string;
	revision: number;
	/** Stored body size; several revisions may share one stored body. */
	bytes: number;
}

/** Core references protect revisions regardless of which store owns their bodies. */
function outputRevisionUnreferenced(
	revisionId: SQLWrapper,
	outputId: SQLWrapper,
	revision: SQLWrapper,
) {
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
			maxRowid: sql<number>`coalesce(max(${workspaceOutputIndex}.rowid), 0)`.as(
				"max_rowid",
			),
		})
		.from(workspaceOutputIndex);
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
	const i = workspaceOutputIndex;
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
 AND ${outputRevisionUnreferenced(i.revisionId, i.outputId, i.revision)}`)
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
	const i = workspaceOutputIndex;
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
					outputRevisionUnreferenced(i.revisionId, i.outputId, i.revision),
				),
			)
	).map((row) => row.id);
}
