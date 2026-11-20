import type { DbQueryClient } from "../../query-client";
import type {
	OsOutputRow,
	OsOutputRevisionRow,
} from "../../tenant-store/outputs-schema";
import { appendWorkspaceFeedLedger, listWorkspaceFeedLedger } from "./ledger";
import {
	applyWorkspaceChangeEvents,
	getWorkspaceFeedCursor,
} from "./projection";
import {
	getWorkspaceOutputIndexCurrent,
	getWorkspaceOutputIndexRevision,
} from "./read";

/**
 * Record a saved output revision in the workspace's feed ledger and bring the
 * organization's index and activity up to that entry. The ledger gives the
 * entry its sequence number. A revision that is not current is skipped unless
 * `historical`, and a revision already recorded changes nothing.
 */
export async function publishOutputProjection(
	db: DbQueryClient,
	output: OsOutputRow,
	revision: Omit<OsOutputRevisionRow, "content">,
	options: {
		historical?: boolean;
		continuesBurst?: boolean;
		/** Searchable text of the saved body, when the writer knows it. */
		excerpt?: string;
	} = {},
): Promise<void> {
	if (!output.workspaceId) return;
	if (!options.historical && output.currentRevisionId !== revision.id) return;
	if (
		options.historical &&
		(
			await getWorkspaceOutputIndexRevision(db, {
				organizationId: output.organizationId,
				revisionId: revision.id,
			})
		)?.workspaceId === output.workspaceId
	)
		return;
	const current = await getWorkspaceOutputIndexCurrent(db, {
		organizationId: output.organizationId,
		outputId: output.id,
	});
	if (!options.historical && current && current.revision > revision.revision)
		return;
	if (
		current?.revisionId === revision.id &&
		current.workspaceId === output.workspaceId &&
		current.title === output.title &&
		current.status === output.status &&
		current.updatedAt >= output.updatedAt
	)
		return;
	const event = await appendWorkspaceFeedLedger(db, {
		organizationId: output.organizationId,
		workspaceId: output.workspaceId,
		kind: "output",
		id: output.id,
		revision: revision.revision,
		actor: { kind: revision.createdByKind, id: revision.createdById },
		changeRecordId: revision.id,
		at: options.historical ? revision.createdAt : output.updatedAt,
		summary: {
			title: output.title,
			outputKind: output.kind,
			status: output.status,
			createdBy: { kind: output.createdByKind, id: output.createdById },
			createdAt: output.createdAt,
			note: revision.note,
			continuesBurst: options.continuesBurst,
			skillRunId: revision.skillRunId,
			skillId: revision.skillId,
			accessEnvelope: revision.accessEnvelope,
			contentSha256: revision.contentSha256,
			contentBytes: revision.contentBytes,
			bodyR2Key: revision.bodyR2Key,
			...(options.excerpt ? { excerpt: options.excerpt } : {}),
		},
	});
	let cursor = await getWorkspaceFeedCursor(db, output.workspaceId);
	while (cursor < event.seq) {
		const page = await listWorkspaceFeedLedger(db, {
			workspaceId: output.workspaceId,
			fromSeq: cursor + 1,
			limit: 500,
		});
		const applied = await applyWorkspaceChangeEvents(db, page);
		if (applied.lastSeq <= cursor)
			throw new Error("Workspace output projection did not advance");
		cursor = applied.lastSeq;
	}
}
