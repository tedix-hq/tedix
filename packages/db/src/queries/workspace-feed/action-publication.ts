import {
	WorkspaceActionSchema,
	type WorkspaceChangeInput,
} from "@tedix/api-contract/schemas/workspace-feed";
import { and, eq } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import {
	workspaceActivity,
	workspaceFeedLedger,
} from "../../schema/workspace-feed";
import { appendWorkspaceFeedLedger, listWorkspaceFeedLedger } from "./ledger";
import {
	applyWorkspaceChangeEvents,
	getWorkspaceFeedCursor,
} from "./projection";

/** The workspace serializes publication; the source record id survives a lost reply. */
export async function publishWorkspaceAction(
	db: DbQueryClient,
	input: WorkspaceChangeInput,
): Promise<void> {
	if (input.kind !== "run" || !input.summary?.action)
		throw new Error("Workspace action metadata required");
	WorkspaceActionSchema.parse(input.summary.action);
	const [existing] = await db
		.select()
		.from(workspaceFeedLedger)
		.where(
			and(
				eq(workspaceFeedLedger.organizationId, input.organizationId),
				eq(workspaceFeedLedger.workspaceId, input.workspaceId),
				eq(workspaceFeedLedger.kind, "run"),
				eq(workspaceFeedLedger.changeRecordId, input.changeRecordId),
			),
		)
		.limit(1);
	const target =
		existing?.seq ?? (await appendWorkspaceFeedLedger(db, input)).seq;
	let cursor = await getWorkspaceFeedCursor(db, input.workspaceId);
	while (cursor < target) {
		const page = await listWorkspaceFeedLedger(db, {
			workspaceId: input.workspaceId,
			fromSeq: cursor + 1,
			limit: 100,
		});
		const applied = await applyWorkspaceChangeEvents(db, page);
		if (applied.lastSeq <= cursor)
			throw new Error("Workspace action projection did not advance");
		cursor = applied.lastSeq;
	}
	// A source replay also repairs a pruned action below the cursor without replaying chat counters.
	if (existing)
		await db
			.insert(workspaceActivity)
			.values({
				id: existing.id,
				organizationId: existing.organizationId,
				workspaceId: existing.workspaceId,
				seq: existing.seq,
				kind: existing.kind,
				entityId: existing.entityId,
				revision: existing.revision,
				actorKind: existing.actorKind,
				actorId: existing.actorId,
				changeRecordId: existing.changeRecordId,
				occurredAt: existing.at,
				appliedAt: new Date().toISOString(),
			})
			.onConflictDoNothing({ target: workspaceActivity.id });
}

export async function hasWorkspaceActionProjection(
	db: DbQueryClient,
	params: {
		organizationId: string;
		workspaceId: string;
		changeRecordId: string;
	},
): Promise<boolean> {
	const [row] = await db
		.select({ id: workspaceActivity.id })
		.from(workspaceActivity)
		.innerJoin(
			workspaceFeedLedger,
			and(
				eq(workspaceFeedLedger.id, workspaceActivity.id),
				eq(
					workspaceFeedLedger.organizationId,
					workspaceActivity.organizationId,
				),
				eq(
					workspaceFeedLedger.changeRecordId,
					workspaceActivity.changeRecordId,
				),
			),
		)
		.where(
			and(
				eq(workspaceActivity.organizationId, params.organizationId),
				eq(workspaceActivity.workspaceId, params.workspaceId),
				eq(workspaceActivity.kind, "run"),
				eq(workspaceActivity.changeRecordId, params.changeRecordId),
			),
		)
		.limit(1);
	return Boolean(row);
}
