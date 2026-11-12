/**
 * Apply workspace change events to the core projections.
 *
 * One call handles one workspace's events. They are sorted by `seq`, checked
 * against the workspace cursor, and the contiguous run that follows the
 * cursor is written in one `db.batch()` together with the cursor advance, so
 * a crash mid-way leaves either everything or nothing of that run applied.
 *
 * - `seq <= cursor` → `duplicate`: already applied, acknowledge.
 * - `seq == cursor + 1` → `applied`.
 * - anything later → `gap`: an earlier event has not arrived; the caller
 *   asks the queue to redeliver it later and `replayFrom` can fill a hole
 *   that never closes on its own.
 */

import type {
	WorkspaceChangeEvent,
	WorkspaceChangeSummary,
} from "@tedix/api-contract/schemas/workspace-feed";
import { and, eq, isNull, ne, notInArray, sql } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import { kernelConversations } from "../../schema/cognitive-runtime";
import {
	workspaceActivity,
	workspaceFeedCursors,
	workspaceOutputIndex,
	workspaceWorkLinks,
} from "../../schema/workspace-feed";

export type WorkspaceChangeOutcome = "applied" | "duplicate" | "gap";

export interface ApplyWorkspaceChangeEventsResult {
	outcomes: Map<number, WorkspaceChangeOutcome>;
	applied: number;
	/** The cursor after this call. */
	lastSeq: number;
}

/** Longest title the activity row keeps. */
const TITLE_MAX = 300;
/** Longest search text the index row keeps, after lower-casing. */
const SEARCH_TEXT_MAX = 4_000;

function clip(value: string | undefined, max: number): string | null {
	if (!value) return null;
	return value.length > max ? value.slice(0, max) : value;
}

function searchTextOf(summary: WorkspaceChangeSummary): string | null {
	if (!summary.excerpt) return null;
	return summary.excerpt.toLowerCase().slice(0, SEARCH_TEXT_MAX);
}

export async function getWorkspaceFeedCursor(
	db: DbQueryClient,
	workspaceId: string,
): Promise<number> {
	const [row] = await db
		.select({ lastSeq: workspaceFeedCursors.lastSeq })
		.from(workspaceFeedCursors)
		.where(eq(workspaceFeedCursors.workspaceId, workspaceId))
		.limit(1);
	return row?.lastSeq ?? 0;
}

export async function applyWorkspaceChangeEvents(
	db: DbQueryClient,
	events: readonly WorkspaceChangeEvent[],
	options: { appliedAt?: string } = {},
): Promise<ApplyWorkspaceChangeEventsResult> {
	const outcomes = new Map<number, WorkspaceChangeOutcome>();
	const first = events[0];
	if (!first) return { outcomes, applied: 0, lastSeq: 0 };
	const workspaceId = first.workspaceId;
	for (const event of events) {
		if (event.workspaceId !== workspaceId) {
			throw new Error(
				"WORKSPACE_FEED_MIXED_BATCH: applyWorkspaceChangeEvents takes one workspace per call",
			);
		}
	}
	const appliedAt = options.appliedAt ?? new Date().toISOString();
	const sorted = [...events].sort((a, b) => a.seq - b.seq);
	let cursor = await getWorkspaceFeedCursor(db, workspaceId);
	let expected = cursor + 1;
	const run: WorkspaceChangeEvent[] = [];
	for (const event of sorted) {
		if (outcomes.has(event.seq)) continue;
		if (event.seq <= cursor) {
			outcomes.set(event.seq, "duplicate");
			continue;
		}
		if (event.seq === expected) {
			run.push(event);
			outcomes.set(event.seq, "applied");
			expected += 1;
			continue;
		}
		if (event.seq < expected) {
			// Same seq delivered twice inside one batch.
			outcomes.set(event.seq, "duplicate");
			continue;
		}
		outcomes.set(event.seq, "gap");
	}
	if (run.length === 0) return { outcomes, applied: 0, lastSeq: cursor };

	const statements = run.flatMap((event) =>
		projectionStatements(db, event, appliedAt),
	);
	const last = run[run.length - 1]!;
	statements.push(
		db
			.insert(workspaceFeedCursors)
			.values({
				workspaceId,
				organizationId: last.organizationId,
				lastSeq: last.seq,
				appliedAt,
				lastEventAt: last.at,
			})
			.onConflictDoUpdate({
				target: workspaceFeedCursors.workspaceId,
				set: { lastSeq: last.seq, appliedAt, lastEventAt: last.at },
			}),
	);
	await db.batch(statements as [BatchStatement, ...BatchStatement[]]);
	cursor = last.seq;
	return { outcomes, applied: run.length, lastSeq: cursor };
}

type BatchStatement = Parameters<DbQueryClient["batch"]>[0][number];

function projectionStatements(
	db: DbQueryClient,
	event: WorkspaceChangeEvent,
	appliedAt: string,
): BatchStatement[] {
	const summary = event.summary;
	const statements: BatchStatement[] = [];
	if (event.kind !== "output" || !summary.continuesBurst)
		statements.push(
			db
				.insert(workspaceActivity)
				.values({
					id: `${event.workspaceId}:${event.seq}`,
					organizationId: event.organizationId,
					workspaceId: event.workspaceId,
					seq: event.seq,
					kind: event.kind,
					entityId: event.id,
					revision: event.revision,
					actorKind: event.actor.kind,
					actorId: event.actor.id,
					changeRecordId: event.changeRecordId,
					title: clip(summary.title, TITLE_MAX),
					summary: clip(summary.description, 500),
					occurredAt: event.at,
					appliedAt,
				})
				.onConflictDoNothing({ target: workspaceActivity.id }),
		);
	if (event.kind === "output") statements.push(...outputStatements(db, event));
	if (event.kind === "chat") {
		const chat = chatStatement(db, event);
		if (chat) statements.push(chat);
	}
	return statements;
}

function outputStatements(
	db: DbQueryClient,
	event: WorkspaceChangeEvent,
): BatchStatement[] {
	const summary = event.summary;
	const createdBy = summary.createdBy ?? event.actor;
	const searchText = searchTextOf(summary);
	const rowId = `${event.id}:${event.revision}`;
	// Publication can arrive out of revision order even though feed sequence is contiguous.
	const isCurrent = sql<number>`CASE WHEN EXISTS (SELECT 1 FROM workspace_output_index WHERE organization_id = ${event.organizationId} AND output_id = ${event.id} AND is_current = 1 AND revision > ${event.revision}) THEN 0 ELSE 1 END`;
	const statements: BatchStatement[] = [
		// Only one row per output serves the library and search.
		db
			.update(workspaceOutputIndex)
			.set({ isCurrent: 0 })
			.where(
				and(
					eq(workspaceOutputIndex.outputId, event.id),
					sql`${workspaceOutputIndex.revision} <= ${event.revision}`,
					ne(workspaceOutputIndex.id, rowId),
				),
			),
		db
			.insert(workspaceOutputIndex)
			.values({
				id: rowId,
				organizationId: event.organizationId,
				workspaceId: event.workspaceId,
				outputId: event.id,
				revision: event.revision,
				revisionId: event.changeRecordId,
				isCurrent,
				outputKind: summary.outputKind ?? "document",
				title: summary.title ?? "",
				status: summary.status ?? "active",
				searchText: searchText ?? "",
				note: summary.note ?? null,
				outputCreatedByKind: createdBy.kind,
				outputCreatedById: createdBy.id,
				outputCreatedAt: summary.createdAt ?? event.at,
				revisionCreatedByKind: event.actor.kind,
				revisionCreatedById: event.actor.id,
				revisionCreatedAt: event.at,
				skillRunId: summary.skillRunId ?? null,
				skillId: summary.skillId ?? null,
				accessEnvelope: summary.accessEnvelope ?? null,
				contentSha256: summary.contentSha256 ?? null,
				contentBytes: summary.contentBytes ?? null,
				bodyR2Key: summary.bodyR2Key ?? null,
				updatedAt: event.at,
			})
			.onConflictDoUpdate({
				target: workspaceOutputIndex.id,
				// A metadata-only event (rename, archive, move) names the current
				// revision row and carries only what changed; keep the rest.
				set: {
					workspaceId: event.workspaceId,
					revisionId: event.changeRecordId,
					isCurrent,
					title: summary.title ?? sql`${workspaceOutputIndex.title}`,
					status: summary.status ?? sql`${workspaceOutputIndex.status}`,
					outputKind:
						summary.outputKind ?? sql`${workspaceOutputIndex.outputKind}`,
					searchText: searchText ?? sql`${workspaceOutputIndex.searchText}`,
					note:
						summary.note === undefined
							? sql`${workspaceOutputIndex.note}`
							: summary.note,
					updatedAt: event.at,
				},
			}),
	];
	if (summary.workItemIds) {
		const ids = [...new Set(summary.workItemIds)];
		statements.push(
			db
				.update(workspaceWorkLinks)
				.set({ unlinkedAt: event.at })
				.where(
					and(
						eq(workspaceWorkLinks.outputId, event.id),
						isNull(workspaceWorkLinks.unlinkedAt),
						ids.length === 0
							? undefined
							: notInArray(workspaceWorkLinks.workItemId, ids),
					),
				),
		);
		for (const workItemId of ids) {
			statements.push(
				db
					.insert(workspaceWorkLinks)
					.values({
						id: `${event.id}:${workItemId}`,
						organizationId: event.organizationId,
						workspaceId: event.workspaceId,
						outputId: event.id,
						workItemId,
						revision: event.revision,
						linkedAt: event.at,
						unlinkedAt: null,
					})
					.onConflictDoUpdate({
						target: workspaceWorkLinks.id,
						set: {
							workspaceId: event.workspaceId,
							revision: event.revision,
							unlinkedAt: null,
						},
					}),
			);
		}
	}
	return statements;
}

/**
 * Home lists conversations from `kernel_conversations`; a workspace chat
 * message bumps that index the same way a kernel event does. The bump is not
 * idempotent on its own; the cursor guarantees each event lands once.
 */
function chatStatement(
	db: DbQueryClient,
	event: WorkspaceChangeEvent,
): BatchStatement | null {
	const conversationId = event.summary.conversationId;
	if (!conversationId) return null;
	const title = clip(event.summary.title, TITLE_MAX);
	const channel = event.summary.channel ?? null;
	return db
		.insert(kernelConversations)
		.values({
			id: `${event.organizationId}:${conversationId}`,
			organizationId: event.organizationId,
			conversationId,
			...(title ? { title, titleSource: "provisional" as const } : {}),
			channel,
			workspaceId: event.workspaceId,
			lastMessageAt: event.at,
			messageCount: 1,
			createdAt: event.at,
			updatedAt: event.at,
		})
		.onConflictDoUpdate({
			target: kernelConversations.id,
			where: isNull(kernelConversations.deletedAt),
			set: {
				lastMessageAt: sql`CASE WHEN ${kernelConversations.lastMessageAt} < ${event.at} THEN ${event.at} ELSE ${kernelConversations.lastMessageAt} END`,
				messageCount: sql`${kernelConversations.messageCount} + 1`,
				channel: sql`COALESCE(${channel}, ${kernelConversations.channel})`,
				workspaceId: sql`COALESCE(${kernelConversations.workspaceId}, ${event.workspaceId})`,
				...(title
					? {
							title: sql`CASE WHEN ${kernelConversations.title} IS NULL THEN ${title} ELSE ${kernelConversations.title} END`,
							titleSource: sql`CASE WHEN ${kernelConversations.title} IS NULL THEN 'provisional' ELSE ${kernelConversations.titleSource} END`,
						}
					: {}),
				updatedAt: event.at,
			},
		});
}
