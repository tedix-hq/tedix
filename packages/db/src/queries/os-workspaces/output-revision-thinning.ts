import { and, eq, inArray, sql, type SQLWrapper } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import { kernelRuntimeRuns } from "../../schema/cognitive-runtime";
import { osReviewBatches, osShareLinks } from "../../schema/os-shares";
import {
	osCollaborationProposals,
	osOutputRevisions,
	osOutputs,
} from "../../schema/os-workspaces";
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

const rowid = sql<number>`${osOutputRevisions}.rowid`;

export const OUTPUT_THINNING_MAX_WINDOW = 5_000;
/** Ids travel as bound parameters, which D1 caps at 100 per statement. */
export const OUTPUT_THINNING_MAX_LIMIT = 40;
/** Seconds in one window that keeps one auto-save per file and person. */
export const OUTPUT_THINNING_WINDOW_SECONDS = 600;

export async function getOsOutputRevisionMaxRowid(
	db: DbQueryClient,
): Promise<number> {
	const [row] = await db
		.select({
			maxRowid: sql<number>`coalesce(max(${rowid}), 0)`.as("max_rowid"),
		})
		.from(osOutputRevisions);
	return row?.maxRowid ?? 0;
}

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

/**
 * Auto-save revisions in `(after, through]` that the policy above allows to
 * remove, oldest first.
 */
export async function listOutputThinningCandidates(
	db: DbQueryClient,
	params: {
		after: number;
		through: number;
		limit: number;
		/** ISO time; only revisions created before it are considered. */
		olderThan: string;
		autosaveNote: string;
		/** Scan retained migration copies too when runtime authority can be checked. */
		includeCoreCopies?: boolean;
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
	const cutoff = Math.floor(Date.parse(params.olderThan) / 1000);
	const r = osOutputRevisions;
	const noteLength = params.autosaveNote.length;
	// A bound number may arrive as a float, and the windows need integer
	// division: cast it in the statement.
	const window = sql`CAST(${OUTPUT_THINNING_WINDOW_SECONDS} AS INTEGER)`;
	return db
		.select({
			rowid: rowid.as("revision_rowid"),
			revisionId: r.id,
			workspaceId: osOutputs.workspaceId,
			organizationId: r.organizationId,
			outputId: r.outputId,
			revision: r.revision,
			bytes: sql<number>`coalesce(${r.contentBytes}, length(${r.content}))`.as(
				"revision_bytes",
			),
		})
		.from(r)
		.innerJoin(
			osOutputs,
			and(
				eq(osOutputs.id, r.outputId),
				eq(osOutputs.organizationId, r.organizationId),
			),
		)
		.where(
			sql`${rowid} > ${params.after} AND ${rowid} <= ${params.through}
			AND ${r.createdByKind} = 'user'
			AND ${r.skillRunId} IS NULL
			AND substr(${r.note}, 1, ${noteLength}) = ${params.autosaveNote}
			AND unixepoch(${r.createdAt}) < ${cutoff}
			AND ${r.id} <> ${osOutputs.currentRevisionId}
			AND ${r.revision} > (
				SELECT min(first.revision) FROM ${r} AS first
				WHERE first.output_id = ${r.outputId})
			AND ${r.revision} < (
				SELECT max(newest.revision) FROM ${r} AS newest
				WHERE newest.output_id = ${r.outputId})
			AND EXISTS (
				SELECT 1 FROM ${r} AS kept
				WHERE kept.output_id = ${r.outputId}
				AND kept.created_by_kind = ${r.createdByKind}
				AND kept.created_by_id = ${r.createdById}
				AND kept.revision > ${r.revision}
				AND unixepoch(kept.created_at) / ${window}
					= unixepoch(${r.createdAt}) / ${window})
			AND ${outputRevisionUnreferenced(r.id, r.outputId, r.revision)}`,
		)
		.orderBy(rowid)
		.limit(params.limit);
}

/**
 * Remove the given revisions and their rows in the output index, in one
 * batch. The delete repeats the two checks that must hold at the instant it
 * runs: the row is not its file's current revision and not its newest.
 * Returns the ids actually removed.
 */
export async function deleteThinnedOutputRevisions(
	db: DbQueryClient,
	revisionIds: readonly string[],
): Promise<string[]> {
	if (revisionIds.length === 0) return [];
	if (revisionIds.length > OUTPUT_THINNING_MAX_LIMIT)
		throw new Error("Too many revisions in one thinning batch");
	const ids = [...revisionIds];
	const r = osOutputRevisions;
	const [removed] = await db.batch([
		db
			.delete(r)
			.where(
				and(
					inArray(r.id, ids),
					sql`NOT EXISTS (
						SELECT 1 FROM ${osOutputs}
						WHERE ${osOutputs.currentRevisionId} = ${r.id})`,
					sql`${r.revision} < (
						SELECT max(newest.revision) FROM ${r} AS newest
						WHERE newest.output_id = ${r.outputId})`,
				),
			)
			.returning({ revisionId: r.id }),
		db.delete(workspaceOutputIndex).where(
			and(
				inArray(workspaceOutputIndex.revisionId, ids),
				eq(workspaceOutputIndex.isCurrent, 0),
				sql`NOT EXISTS (
						SELECT 1 FROM ${osOutputs}
						WHERE ${osOutputs.currentRevisionId} = ${workspaceOutputIndex.revisionId})`,
			),
		),
	]);
	return removed.map((row) => row.revisionId);
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

export async function listObjectOutputThinningCandidates(
	db: DbQueryClient,
	params: Parameters<typeof listOutputThinningCandidates>[1],
) {
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
 AND (${params.includeCoreCopies ? 1 : 0} = 1 OR NOT EXISTS (SELECT 1 FROM ${osOutputs} WHERE ${osOutputs.id} = ${i.outputId}))
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
