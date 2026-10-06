import { and, desc, eq, isNull, lt, notLike, or, sql } from "drizzle-orm";
import type { DbClient } from "../client";
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
	const [evictedToolResults] = await db.batch([
		buildEvictConversationToolResultsStatement(db, {
			organizationId: input.organizationId,
			conversationId: input.conversationId,
			evictedAt: input.deletedAt,
		}),
		db
			.delete(kernelConversationArtifactPins)
			.where(
				and(
					eq(
						kernelConversationArtifactPins.organizationId,
						input.organizationId,
					),
					eq(
						kernelConversationArtifactPins.conversationId,
						input.conversationId,
					),
				),
			),
		db
			.delete(kernelConversationCapabilities)
			.where(
				and(
					eq(
						kernelConversationCapabilities.organizationId,
						input.organizationId,
					),
					eq(
						kernelConversationCapabilities.conversationId,
						input.conversationId,
					),
				),
			),
		db
			.delete(kernelRuntimeEvents)
			.where(
				and(
					eq(kernelRuntimeEvents.organizationId, input.organizationId),
					eq(kernelRuntimeEvents.conversationId, input.conversationId),
				),
			),
		db
			.delete(kernelRuntimeRuns)
			.where(
				and(
					eq(kernelRuntimeRuns.organizationId, input.organizationId),
					eq(kernelRuntimeRuns.conversationId, input.conversationId),
				),
			),
		db
			.delete(kernelConversationGrants)
			.where(
				and(
					eq(kernelConversationGrants.organizationId, input.organizationId),
					eq(kernelConversationGrants.conversationId, input.conversationId),
				),
			),
		db
			.delete(kernelHomeApprovalMirrors)
			.where(
				and(
					eq(kernelHomeApprovalMirrors.organizationId, input.organizationId),
					eq(
						kernelHomeApprovalMirrors.parentConversationId,
						input.conversationId,
					),
				),
			),
		db
			.delete(kernelWakeQueue)
			.where(
				and(
					eq(kernelWakeQueue.organizationId, input.organizationId),
					eq(kernelWakeQueue.parentConversationId, input.conversationId),
				),
			),
		db
			.delete(chatDispatchIdempotency)
			.where(
				and(
					eq(chatDispatchIdempotency.organizationId, input.organizationId),
					eq(chatDispatchIdempotency.conversationId, input.conversationId),
				),
			),
		db
			.delete(runtimeSubmissions)
			.where(
				and(
					eq(runtimeSubmissions.organizationId, input.organizationId),
					eq(runtimeSubmissions.conversationId, input.conversationId),
				),
			),
		db
			.delete(harnessSubjectTraceBundles)
			.where(
				and(
					eq(harnessSubjectTraceBundles.orgId, input.organizationId),
					eq(harnessSubjectTraceBundles.conversationId, input.conversationId),
				),
			),
		db
			.insert(kernelConversations)
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
				target: kernelConversations.id,
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
					deletedAt: sql`COALESCE(${kernelConversations.deletedAt}, ${input.deletedAt})`,
					archivedAt: null,
					pinnedAt: null,
					updatedAt: input.deletedAt,
				},
			}),
	]);
	return {
		evictedToolResults: evictedToolResults.filter(
			(row): row is EvictedKernelToolResult => row.evictedAt !== null,
		),
	};
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
function originConflictValue(origin: KernelConversationOrigin) {
	if (origin === "human") return sql`'human'`;
	return sql`CASE WHEN ${kernelConversations.origin} IS NOT NULL THEN ${kernelConversations.origin} WHEN ${kernelConversations.messageCount} = 0 THEN 'agent' ELSE NULL END`;
}

export async function recordKernelConversationMessage(
	db: DbClient,
	input: {
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
		workspaceId?: string | null;
		workpieceKind?: "gadget" | "output" | null;
		workpieceId?: string | null;
	},
): Promise<void> {
	const updatedAt = new Date().toISOString();
	const origin = input.origin ?? null;
	await db
		.insert(kernelConversations)
		.values({
			id: rowId(input.organizationId, input.conversationId),
			organizationId: input.organizationId,
			conversationId: input.conversationId,
			...(input.provisionalTitle
				? { title: input.provisionalTitle, titleSource: "provisional" as const }
				: {}),
			channel: input.channel,
			...(origin ? { origin } : {}),
			...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
			...(input.workpieceKind
				? { workpieceKind: input.workpieceKind, workpieceId: input.workpieceId }
				: {}),
			lastMessageAt: input.createdAt,
			messageCount: 1,
			createdAt: input.createdAt,
			updatedAt,
		})
		.onConflictDoUpdate({
			target: kernelConversations.id,
			// A permanent-delete tombstone is terminal. Late runtime frames must
			// not repopulate its content-free projection.
			where: isNull(kernelConversations.deletedAt),
			set: {
				lastMessageAt: sql`CASE WHEN ${kernelConversations.lastMessageAt} < ${input.createdAt} THEN ${input.createdAt} ELSE ${kernelConversations.lastMessageAt} END`,
				messageCount: sql`${kernelConversations.messageCount} + 1`,
				channel: sql`COALESCE(${input.channel}, ${kernelConversations.channel})`,
				...(origin ? { origin: originConflictValue(origin) } : {}),
				...(input.workspaceId
					? {
							workspaceId: sql`COALESCE(${kernelConversations.workspaceId}, ${input.workspaceId})`,
						}
					: {}),
				...(input.workpieceKind
					? {
							workpieceKind: input.workpieceKind,
							workpieceId: input.workpieceId ?? null,
						}
					: {}),
				...(input.provisionalTitle
					? {
							title: sql`CASE WHEN ${kernelConversations.title} IS NULL AND ${kernelConversations.titleSource} IS NULL AND ${kernelConversations.messageCount} = 0 THEN ${input.provisionalTitle} ELSE ${kernelConversations.title} END`,
							titleSource: sql`CASE WHEN ${kernelConversations.title} IS NULL AND ${kernelConversations.titleSource} IS NULL AND ${kernelConversations.messageCount} = 0 THEN 'provisional' ELSE ${kernelConversations.titleSource} END`,
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
	await db
		.insert(kernelConversations)
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
			target: kernelConversations.id,
			set: {
				deletedAt: sql`COALESCE(${kernelConversations.deletedAt}, ${input.deletedAt})`,
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
	await db
		.insert(kernelConversations)
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
			target: kernelConversations.id,
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
	await db
		.insert(kernelConversations)
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
			target: kernelConversations.id,
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
			.insert(kernelConversations)
			.values(values)
			.onConflictDoUpdate({
				target: kernelConversations.id,
				set: { title: input.title, titleSource: input.titleSource, updatedAt },
			});
		return;
	}
	await db
		.insert(kernelConversations)
		.values(values)
		.onConflictDoUpdate({
			target: kernelConversations.id,
			set: {
				title: sql`CASE WHEN ${kernelConversations.titleSource} = 'rename' THEN ${kernelConversations.title} ELSE ${input.title} END`,
				titleSource: sql`CASE WHEN ${kernelConversations.titleSource} = 'rename' THEN ${kernelConversations.titleSource} ELSE 'autoTitle' END`,
				updatedAt,
			},
		});
}

export async function getKernelConversation(
	db: DbClient,
	input: { organizationId: string; conversationId: string },
): Promise<KernelConversation | undefined> {
	const [row] = await db
		.select()
		.from(kernelConversations)
		.where(
			and(
				eq(kernelConversations.organizationId, input.organizationId),
				eq(kernelConversations.conversationId, input.conversationId),
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
	const hiddenPrefixes = input.hiddenPrefixes ?? [];
	const isHidden = (conversationId: string) =>
		hiddenPrefixes.some((prefix) => conversationId.startsWith(prefix));
	const cursorCondition = input.cursor
		? or(
				lt(kernelConversations.lastMessageAt, input.cursor.lastMessageAt),
				and(
					eq(kernelConversations.lastMessageAt, input.cursor.lastMessageAt),
					lt(kernelConversations.conversationId, input.cursor.conversationId),
				),
			)
		: undefined;
	const rows = await db
		.select()
		.from(kernelConversations)
		.where(
			and(
				eq(kernelConversations.organizationId, input.organizationId),
				isNull(kernelConversations.deletedAt),
				input.includeArchived
					? undefined
					: isNull(kernelConversations.archivedAt),
				input.workspaceId
					? eq(kernelConversations.workspaceId, input.workspaceId)
					: undefined,
				// LIKE has no wildcards to escape here: every prefix is literal
				// `[a-z-]` plus `:`, so a caller cannot smuggle in `%` or `_`.
				...hiddenPrefixes.map((prefix) =>
					notLike(kernelConversations.conversationId, `${prefix}%`),
				),
				cursorCondition,
			),
		)
		.orderBy(
			desc(kernelConversations.lastMessageAt),
			desc(kernelConversations.conversationId),
		)
		.limit(input.limit);
	return rows.filter((row) => !row.deletedAt && !isHidden(row.conversationId));
}
