import {
	and,
	asc,
	count,
	desc,
	eq,
	exists,
	gt,
	inArray,
	isNotNull,
	isNull,
	lt,
	notLike,
	or,
	sql,
} from "drizzle-orm";
import type { DbClient } from "../client";
import { coreTable } from "../core-store/client";
import { anyIds, coreStore } from "../core-store/dialect";
import { harnessSubjectTraceBundles } from "../schema/harness-versions";
import {
	chatDispatchIdempotency,
	type KernelConversation,
	type KernelConversationOrigin,
	kernelConversationGrants,
	kernelConversations,
	kernelHomeApprovalMirrors,
	kernelRuntimeEvents,
	kernelRuntimeRuns,
	kernelWakeQueue,
} from "../schema/cognitive-runtime";
import { runtimeSubmissions } from "../schema/runtime-submissions";
import { kernelConversationArtifactPins } from "../schema/conversation-artifact-pins";
import { kernelConversationCapabilities } from "../schema/conversation-capabilities";
import { kernelConversationSessionPolicies } from "../schema/conversation-session-policies";
import {
	buildInsertAuditEventStatement,
	type InsertAuditEventParams,
} from "./audit";
import {
	buildEvictConversationToolResultsStatement,
	type EvictedKernelToolResult,
} from "./kernel-tool-results";

export type KernelConversationTitleSource =
	| "rename"
	| "autoTitle"
	| "provisional";
export type { KernelConversationOrigin };
export type KernelConversationRow = KernelConversation;
export interface KernelConversationCursor {
	lastMessageAt: string;
	conversationId: string;
}

/**
 * Permanently remove content owned by one Home conversation while retaining a
 * content-free tombstone. The tombstone is load-bearing: a late child-complete
 * wake or runtime frame must never make a deleted conversation visible again.
 *
 * Callers must stop every active parent/child run before invoking this query.
 * Accepted Work Items and child-tedi ledgers are deliberately outside this
 * ownership boundary and are not deleted here.
 */
export async function purgeKernelConversation(
	db: DbClient,
	input: {
		organizationId: string;
		conversationId: string;
		deletedAt: string;
	},
): Promise<{ evictedToolResults: EvictedKernelToolResult[] }> {
	return purgeKernelConversations(db, {
		organizationId: input.organizationId,
		conversationIds: [input.conversationId],
		deletedAt: input.deletedAt,
	});
}

/** Largest conversation set one purge batch takes (bound-parameter bound). */
export const KERNEL_CONVERSATION_PURGE_CHUNK = 40;

/**
 * {@link purgeKernelConversation} for up to
 * {@link KERNEL_CONVERSATION_PURGE_CHUNK} conversations in one D1 batch, with
 * an optional content-free audit receipt per conversation in the same batch.
 * The same preconditions apply: no conversation may have an active run.
 */
export async function purgeKernelConversations(
	db: DbClient,
	input: {
		organizationId: string;
		conversationIds: string[];
		deletedAt: string;
		auditEvents?: InsertAuditEventParams[];
		/** Also drop conversation session policies, which the single delete route clears itself. */
		clearSessionPolicies?: boolean;
	},
): Promise<{ evictedToolResults: EvictedKernelToolResult[] }> {
	const ids = [...new Set(input.conversationIds)];
	if (ids.length === 0) return { evictedToolResults: [] };
	if (ids.length > KERNEL_CONVERSATION_PURGE_CHUNK) {
		throw new Error(
			`purgeKernelConversations takes at most ${KERNEL_CONVERSATION_PURGE_CHUNK} conversations`,
		);
	}
	const org = input.organizationId;
	const [evictedToolResults] = await db.batch([
		buildEvictConversationToolResultsStatement(db, {
			organizationId: org,
			conversationId: ids,
			evictedAt: input.deletedAt,
		}),
		db.delete(coreTable(db, kernelConversationArtifactPins)).where(
			and(
				eq(kernelConversationArtifactPins.organizationId, org),
				// bound-params: ids is capped at KERNEL_CONVERSATION_PURGE_CHUNK
				inArray(kernelConversationArtifactPins.conversationId, ids),
			),
		),
		db.delete(coreTable(db, kernelConversationCapabilities)).where(
			and(
				eq(kernelConversationCapabilities.organizationId, org),
				// bound-params: ids is capped at KERNEL_CONVERSATION_PURGE_CHUNK
				inArray(kernelConversationCapabilities.conversationId, ids),
			),
		),
		db.delete(coreTable(db, kernelRuntimeEvents)).where(
			and(
				eq(kernelRuntimeEvents.organizationId, org),
				// bound-params: ids is capped at KERNEL_CONVERSATION_PURGE_CHUNK
				inArray(kernelRuntimeEvents.conversationId, ids),
			),
		),
		db.delete(coreTable(db, kernelRuntimeRuns)).where(
			and(
				eq(kernelRuntimeRuns.organizationId, org),
				// bound-params: ids is capped at KERNEL_CONVERSATION_PURGE_CHUNK
				inArray(kernelRuntimeRuns.conversationId, ids),
			),
		),
		db.delete(coreTable(db, kernelConversationGrants)).where(
			and(
				eq(kernelConversationGrants.organizationId, org),
				// bound-params: ids is capped at KERNEL_CONVERSATION_PURGE_CHUNK
				inArray(kernelConversationGrants.conversationId, ids),
			),
		),
		db.delete(coreTable(db, kernelHomeApprovalMirrors)).where(
			and(
				eq(kernelHomeApprovalMirrors.organizationId, org),
				// bound-params: ids is capped at KERNEL_CONVERSATION_PURGE_CHUNK
				inArray(kernelHomeApprovalMirrors.parentConversationId, ids),
			),
		),
		db.delete(coreTable(db, kernelWakeQueue)).where(
			and(
				eq(kernelWakeQueue.organizationId, org),
				// bound-params: ids is capped at KERNEL_CONVERSATION_PURGE_CHUNK
				inArray(kernelWakeQueue.parentConversationId, ids),
			),
		),
		db.delete(coreTable(db, chatDispatchIdempotency)).where(
			and(
				eq(chatDispatchIdempotency.organizationId, org),
				// bound-params: ids is capped at KERNEL_CONVERSATION_PURGE_CHUNK
				inArray(chatDispatchIdempotency.conversationId, ids),
			),
		),
		db.delete(coreTable(db, runtimeSubmissions)).where(
			and(
				eq(runtimeSubmissions.organizationId, org),
				// bound-params: ids is capped at KERNEL_CONVERSATION_PURGE_CHUNK
				inArray(runtimeSubmissions.conversationId, ids),
			),
		),
		db.delete(coreTable(db, harnessSubjectTraceBundles)).where(
			and(
				eq(harnessSubjectTraceBundles.orgId, org),
				// bound-params: ids is capped at KERNEL_CONVERSATION_PURGE_CHUNK
				inArray(harnessSubjectTraceBundles.conversationId, ids),
			),
		),
		...(input.clearSessionPolicies
			? [
					db.delete(coreTable(db, kernelConversationSessionPolicies)).where(
						and(
							eq(kernelConversationSessionPolicies.organizationId, org),
							// bound-params: ids is capped at KERNEL_CONVERSATION_PURGE_CHUNK
							inArray(kernelConversationSessionPolicies.conversationId, ids),
						),
					),
				]
			: []),
		...ids.map((conversationId) =>
			buildKernelConversationTombstoneStatement(db, {
				organizationId: org,
				conversationId,
				deletedAt: input.deletedAt,
			}),
		),
		...(input.auditEvents ?? []).map(
			(event) => buildInsertAuditEventStatement(db, event).statement,
		),
	]);
	return {
		evictedToolResults: evictedToolResults.filter(
			(row): row is EvictedKernelToolResult => row.evictedAt !== null,
		),
	};
}

/**
 * The tombstone is load-bearing: a late child-complete wake or runtime frame
 * must never make a deleted conversation visible again.
 */
function buildKernelConversationTombstoneStatement(
	db: DbClient,
	input: { organizationId: string; conversationId: string; deletedAt: string },
) {
	const table = coreTable(db, kernelConversations);
	return db
		.insert(table)
		.values({
			id: rowId(input.organizationId, input.conversationId),
			organizationId: input.organizationId,
			conversationId: input.conversationId,
			lastMessageAt: input.deletedAt,
			messageCount: 0,
			deletedAt: input.deletedAt,
			createdAt: input.deletedAt,
			updatedAt: input.deletedAt,
		})
		.onConflictDoUpdate({
			target: table.id,
			set: {
				title: null,
				titleSource: null,
				channel: null,
				origin: null,
				workspaceId: null,
				workpieceKind: null,
				workpieceId: null,
				lastMessageAt: input.deletedAt,
				messageCount: 0,
				deletedAt: sql`COALESCE(${table.deletedAt}, ${input.deletedAt})`,
				archivedAt: null,
				pinnedAt: null,
				updatedAt: input.deletedAt,
			},
		});
}

function rowId(organizationId: string, conversationId: string): string {
	return `${organizationId}:${conversationId}`;
}

/**
 * Merge rule for the conversation-origin stamp on an existing row.
 *
 * - `human` always wins and is not conditional: the moment a human operator
 *   sends into a conversation it is theirs, whatever created it.
 * - `agent` is first-writer-only. It never overwrites an existing stamp, and
 *   it never stamps a row that already has messages but no stamp — those are
 *   pre-column rows that read as human, and reclassifying them would delete
 *   real chats from the operator's view.
 */
function originConflictValue(db: DbClient, origin: KernelConversationOrigin) {
	const table = coreTable(db, kernelConversations);
	if (origin === "human") return sql`'human'`;
	return sql`CASE WHEN ${table.origin} IS NOT NULL THEN ${table.origin} WHEN ${table.messageCount} = 0 THEN 'agent' ELSE NULL END`;
}

export interface RecordKernelConversationMessageParams {
	organizationId: string;
	conversationId: string;
	channel: string | null;
	createdAt: string;
	provisionalTitle: string | null;
	/**
	 * Origin of the turn that produced this event, or `null` when the event
	 * carries no stamp (assistant completions and replayed events). A
	 * `null` origin leaves the column exactly as it is — it never writes a
	 * default, because an unstamped column already reads as human.
	 */
	origin?: KernelConversationOrigin | null;
	workpieceKind?: "gadget" | "output" | null;
	workpieceId?: string | null;
}

export async function recordKernelConversationMessage(
	db: DbClient,
	input: RecordKernelConversationMessageParams,
): Promise<void> {
	await buildRecordKernelConversationMessageStatement(db, input);
}

/**
 * Unexecuted recency/count bump for one message event, for `db.batch()`
 * composition. Not idempotent: the caller composes it only for an event it
 * knows is being inserted for the first time.
 */
export function buildRecordKernelConversationMessageStatement(
	db: DbClient,
	input: RecordKernelConversationMessageParams,
) {
	const updatedAt = new Date().toISOString();
	const origin = input.origin ?? null;
	const table = coreTable(db, kernelConversations);
	return db
		.insert(table)
		.values({
			id: rowId(input.organizationId, input.conversationId),
			organizationId: input.organizationId,
			conversationId: input.conversationId,
			...(input.provisionalTitle
				? { title: input.provisionalTitle, titleSource: "provisional" as const }
				: {}),
			channel: input.channel,
			...(origin ? { origin } : {}),
			...(input.workpieceKind
				? { workpieceKind: input.workpieceKind, workpieceId: input.workpieceId }
				: {}),
			lastMessageAt: input.createdAt,
			messageCount: 1,
			createdAt: input.createdAt,
			updatedAt,
		})
		.onConflictDoUpdate({
			target: table.id,
			// A permanent-delete tombstone is terminal. Late runtime frames must
			// not repopulate its content-free projection.
			where: isNull(table.deletedAt),
			set: {
				lastMessageAt: sql`CASE WHEN ${table.lastMessageAt} < ${input.createdAt} THEN ${input.createdAt} ELSE ${table.lastMessageAt} END`,
				messageCount: sql`${table.messageCount} + 1`,
				channel: sql`COALESCE(${input.channel}, ${table.channel})`,
				...(origin ? { origin: originConflictValue(db, origin) } : {}),
				...(input.workpieceKind
					? {
							workpieceKind: input.workpieceKind,
							workpieceId: input.workpieceId ?? null,
						}
					: {}),
				...(input.provisionalTitle
					? {
							title: sql`CASE WHEN ${table.title} IS NULL AND ${table.titleSource} IS NULL AND ${table.messageCount} = 0 THEN ${input.provisionalTitle} ELSE ${table.title} END`,
							titleSource: sql`CASE WHEN ${table.title} IS NULL AND ${table.titleSource} IS NULL AND ${table.messageCount} = 0 THEN 'provisional' ELSE ${table.titleSource} END`,
						}
					: {}),
				updatedAt,
			},
		});
}

export async function recordKernelConversationDeleted(
	db: DbClient,
	input: {
		organizationId: string;
		conversationId: string;
		createdAt: string;
		deletedAt: string;
	},
): Promise<void> {
	const updatedAt = new Date().toISOString();
	const table = coreTable(db, kernelConversations);
	await db
		.insert(table)
		.values({
			id: rowId(input.organizationId, input.conversationId),
			organizationId: input.organizationId,
			conversationId: input.conversationId,
			title: null,
			titleSource: null,
			lastMessageAt: input.createdAt,
			messageCount: 0,
			deletedAt: input.deletedAt,
			createdAt: input.createdAt,
			updatedAt,
		})
		.onConflictDoUpdate({
			target: table.id,
			set: {
				deletedAt: sql`COALESCE(${table.deletedAt}, ${input.deletedAt})`,
				updatedAt,
			},
		});
}

export async function recordKernelConversationPinned(
	db: DbClient,
	input: {
		organizationId: string;
		conversationId: string;
		createdAt: string;
		pinned: boolean;
	},
): Promise<void> {
	const updatedAt = new Date().toISOString();
	const pinnedAt = input.pinned ? input.createdAt : null;
	const table = coreTable(db, kernelConversations);
	await db
		.insert(table)
		.values({
			id: rowId(input.organizationId, input.conversationId),
			organizationId: input.organizationId,
			conversationId: input.conversationId,
			lastMessageAt: input.createdAt,
			messageCount: 0,
			pinnedAt,
			createdAt: input.createdAt,
			updatedAt,
		})
		.onConflictDoUpdate({
			target: table.id,
			set: { pinnedAt, updatedAt },
		});
}

export async function recordKernelConversationArchived(
	db: DbClient,
	input: {
		organizationId: string;
		conversationId: string;
		createdAt: string;
		archived: boolean;
	},
): Promise<void> {
	const updatedAt = new Date().toISOString();
	const archivedAt = input.archived ? input.createdAt : null;
	const table = coreTable(db, kernelConversations);
	await db
		.insert(table)
		.values({
			id: rowId(input.organizationId, input.conversationId),
			organizationId: input.organizationId,
			conversationId: input.conversationId,
			lastMessageAt: input.createdAt,
			messageCount: 0,
			archivedAt,
			createdAt: input.createdAt,
			updatedAt,
		})
		.onConflictDoUpdate({
			target: table.id,
			set: { archivedAt, updatedAt },
		});
}

export async function recordKernelConversationTitle(
	db: DbClient,
	input: {
		organizationId: string;
		conversationId: string;
		createdAt: string;
		title: string;
		titleSource: "rename" | "autoTitle";
	},
): Promise<void> {
	const updatedAt = new Date().toISOString();
	const table = coreTable(db, kernelConversations);
	const values = {
		id: rowId(input.organizationId, input.conversationId),
		organizationId: input.organizationId,
		conversationId: input.conversationId,
		title: input.title,
		titleSource: input.titleSource,
		lastMessageAt: input.createdAt,
		messageCount: 0,
		createdAt: input.createdAt,
		updatedAt,
	};
	if (input.titleSource === "rename") {
		await db
			.insert(table)
			.values(values)
			.onConflictDoUpdate({
				target: table.id,
				set: { title: input.title, titleSource: input.titleSource, updatedAt },
			});
		return;
	}
	await db
		.insert(table)
		.values(values)
		.onConflictDoUpdate({
			target: table.id,
			set: {
				title: sql`CASE WHEN ${table.titleSource} = 'rename' THEN ${table.title} ELSE ${input.title} END`,
				titleSource: sql`CASE WHEN ${table.titleSource} = 'rename' THEN ${table.titleSource} ELSE 'autoTitle' END`,
				updatedAt,
			},
		});
}

export async function getKernelConversation(
	db: DbClient,
	input: { organizationId: string; conversationId: string },
): Promise<KernelConversation | undefined> {
	const table = coreTable(db, kernelConversations);
	const [row] = await db
		.select()
		.from(table)
		.where(
			and(
				eq(table.organizationId, input.organizationId),
				eq(table.conversationId, input.conversationId),
			),
		)
		.limit(1);
	return row;
}

export async function listKernelConversationPage(
	db: DbClient,
	input: {
		organizationId: string;
		cursor: KernelConversationCursor | null;
		limit: number;
		workspaceId?: string;
		includeArchived?: boolean;
		/**
		 * Conversation-id prefixes never shown in an operator list (CI marker-per-run
		 * smoke threads). Filtered in SQL, not after the fact, so pages remain full.
		 */
		hiddenPrefixes?: readonly string[];
	},
): Promise<KernelConversation[]> {
	const table = coreTable(db, kernelConversations);
	const hiddenPrefixes = input.hiddenPrefixes ?? [];
	const isHidden = (conversationId: string) =>
		hiddenPrefixes.some((prefix) => conversationId.startsWith(prefix));
	const cursorCondition = input.cursor
		? or(
				lt(table.lastMessageAt, input.cursor.lastMessageAt),
				and(
					eq(table.lastMessageAt, input.cursor.lastMessageAt),
					lt(table.conversationId, input.cursor.conversationId),
				),
			)
		: undefined;
	const rows = await db
		.select()
		.from(table)
		.where(
			and(
				eq(table.organizationId, input.organizationId),
				isNull(table.deletedAt),
				input.includeArchived ? undefined : isNull(table.archivedAt),
				input.workspaceId
					? eq(table.workspaceId, input.workspaceId)
					: undefined,
				// LIKE has no wildcards to escape here: every prefix is literal
				// `[a-z-]` plus `:`, so a caller cannot smuggle in `%` or `_`.
				...hiddenPrefixes.map((prefix) =>
					notLike(table.conversationId, `${prefix}%`),
				),
				cursorCondition,
			),
		)
		.orderBy(desc(table.lastMessageAt), desc(table.conversationId))
		.limit(input.limit);
	return rows.filter((row) => !row.deletedAt && !isHidden(row.conversationId));
}

export interface ArchivedKernelConversationPurgeParams {
	organizationId: string;
	/** Exclusive conversation-id cursor; omitted starts at the beginning. */
	afterConversationId?: string;
	/** ISO-8601; only conversations archived or deleted before it. */
	archivedBefore?: string;
}

export interface ArchivedKernelConversationPurgeCandidate {
	conversationId: string;
	workspaceId: string | null;
	pinnedAt: string | null;
}

/**
 * Archived conversations, and deleted ones whose content was never purged (an
 * older soft delete left its events behind). A purged tombstone has neither
 * an archive marker nor events, so it never comes back as a candidate.
 */
function archivedConversationFilter(
	db: DbClient,
	params: ArchivedKernelConversationPurgeParams,
) {
	const table = coreTable(db, kernelConversations);
	const events = coreTable(db, kernelRuntimeEvents);
	const archivedBefore =
		params.archivedBefore === undefined
			? undefined
			: coreStore(db) === "postgres"
				? sql`COALESCE(${table.archivedAt}, ${table.deletedAt})::timestamptz < ${params.archivedBefore}::timestamptz`
				: sql`datetime(COALESCE(${table.archivedAt}, ${table.deletedAt})) < datetime(${params.archivedBefore})`;
	return and(
		eq(table.organizationId, params.organizationId),
		params.afterConversationId === undefined
			? undefined
			: gt(table.conversationId, params.afterConversationId),
		or(
			isNotNull(table.archivedAt),
			and(
				isNotNull(table.deletedAt),
				or(
					gt(table.messageCount, 0),
					isNotNull(table.title),
					exists(
						db
							.select({ id: events.id })
							.from(events)
							.where(
								and(
									eq(events.organizationId, params.organizationId),
									eq(events.conversationId, table.conversationId),
								),
							),
					),
				),
			),
		),
		archivedBefore,
	);
}

export async function listArchivedKernelConversationPurgeCandidates(
	db: DbClient,
	params: ArchivedKernelConversationPurgeParams & { limit: number },
): Promise<ArchivedKernelConversationPurgeCandidate[]> {
	const table = coreTable(db, kernelConversations);
	return db
		.select({
			conversationId: table.conversationId,
			workspaceId: table.workspaceId,
			pinnedAt: table.pinnedAt,
		})
		.from(table)
		.where(archivedConversationFilter(db, params))
		.orderBy(asc(table.conversationId))
		.limit(params.limit);
}

export async function countArchivedKernelConversationPurgeCandidates(
	db: DbClient,
	params: ArchivedKernelConversationPurgeParams,
): Promise<number> {
	const table = coreTable(db, kernelConversations);
	const [row] = await db
		.select({ total: count() })
		.from(table)
		.where(archivedConversationFilter(db, params));
	return row?.total ?? 0;
}

/** Which of `conversationIds` have a queued, running or approval-waiting run. */
export async function listKernelConversationIdsWithActiveRuns(
	db: DbClient,
	params: { organizationId: string; conversationIds: string[] },
): Promise<Set<string>> {
	const found = new Set<string>();
	const table = coreTable(db, kernelRuntimeRuns);
	if (params.conversationIds.length === 0) return found;
	const rows = await db
		.selectDistinct({ conversationId: table.conversationId })
		.from(table)
		.where(
			and(
				eq(table.organizationId, params.organizationId),
				anyIds(db, table.conversationId, params.conversationIds),
				inArray(table.status, ["queued", "running", "requires_approval"]),
			),
		);
	for (const row of rows) found.add(row.conversationId);
	return found;
}
