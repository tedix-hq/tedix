import type { DbQueryClient } from "../../query-client";
import type {
	OsOutputRow,
	OsOutputRevisionRow,
} from "../../schema/os-workspaces";
import { appendWorkspaceFeedLedger, listWorkspaceFeedLedger } from "./ledger";
import {
	applyWorkspaceChangeEvents,
	getWorkspaceFeedCursor,
} from "./projection";
import {
	getWorkspaceOutputIndexCurrent,
	getWorkspaceOutputIndexRevision,
} from "./read";

/** The core ledger retains sequence ownership while existing D1 outputs remain writable. */
export async function publishOutputProjection(
	db: DbQueryClient,
	output: OsOutputRow,
	revision: Omit<OsOutputRevisionRow, "content">,
	options: { historical?: boolean } = {},
): Promise<void> {
	if (!output.workspaceId) return;
	if (!options.historical && output.currentRevisionId !== revision.id) return;
	if (
		options.historical &&
		(await getWorkspaceOutputIndexRevision(db, {
			organizationId: output.organizationId,
			revisionId: revision.id,
		}))
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
			skillRunId: revision.skillRunId,
			skillId: revision.skillId,
			accessEnvelope: revision.accessEnvelope,
			contentSha256: revision.contentSha256,
			contentBytes: revision.contentBytes,
			bodyR2Key: revision.bodyR2Key,
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
