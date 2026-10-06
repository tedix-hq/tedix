import { AUTHZ } from "../../orpc";
import {
	type TediConversation,
	type TediConversationCompaction,
	TediConversationCompactionSchema,
	type TediMessage,
} from "@tedix/api-contract/schemas/cognitive-runtime";
import {
	getLatestTediConversationCompactionEvent,
	isTediConversationDeleted,
	listTediConversationIndexRows,
	listTediConversationTranscriptRows,
} from "@tedix/db/queries/cognitive-runtime";
import {
	authed,
	conversationMatchesInput,
	inferConversationChannel,
	jsonObjectArray,
	nextCursor,
	nonNullRecord,
	normalizeRuntimeRef,
	normalizeTediConversationIdForRead,
	readPayloadAttachments,
	readPayloadRole,
	readPayloadText,
	requireTediAccess,
	stringFromPayload,
} from "./events-policy";
import { assembleCompletedContentFromDeltas } from "./recovery-artifacts";

export const listConversationsRoute = authed.listConversations
	.use(AUTHZ.tedisRead)
	.handler(async ({ context, input }) => {
		const tedi = await requireTediAccess(context, input.tediId);
		const limit = input.limit ?? 100;
		// the package query excludes org-scoped soft-deleted sessions.
		const rows = await listTediConversationIndexRows(context.db, {
			organizationId: tedi.organizationId,
			tediId: input.tediId,
			before: input.cursor,
			limit: limit * 10,
		});
		const byConversation = new Map<string, TediConversation>();
		for (const row of rows) {
			if (!row.conversationId || byConversation.has(row.conversationId))
				continue;
			const payload = nonNullRecord(row.payload);
			const conversationPayload = nonNullRecord(payload?.conversation);
			const title =
				stringFromPayload(conversationPayload?.title) ??
				stringFromPayload(payload?.title) ??
				row.conversationId;
			const channel =
				stringFromPayload(payload?.channel) ??
				inferConversationChannel(row.conversationId);
			const conversation: TediConversation = {
				id: row.conversationId,
				tediId: input.tediId,
				organizationId: tedi.organizationId,
				title,
				status: "active",
				channel,
				lastMessageAt: row.createdAt,
				messageCount: 0,
				runtime: normalizeRuntimeRef(row),
				createdAt: row.createdAt,
				updatedAt: row.createdAt,
				metadata: conversationPayload ?? payload,
			};
			if (!conversationMatchesInput(conversation, input)) continue;
			byConversation.set(row.conversationId, conversation);
			if (byConversation.size >= limit) break;
		}
		return {
			conversations: [...byConversation.values()],
			nextCursor: nextCursor(rows, limit * 10),
		};
	});

export const readMessagesRoute = authed.readMessages
	.use(AUTHZ.tedisRead)
	.handler(async ({ context, input }) => {
		// Conversation reads project EXCLUSIVELY from the canonical durable
		// ledger (`tedi_runtime_events`) — same source as `listConversations`.
		// No runtime/gateway-direct fallback: the ledger IS the transcript of
		// record. If a turn is missing here, it was never durably recorded,
		// and querying the runtime would surface a non-canonical, non-replayable
		// view that diverges from analytics/audit. (Alpha: ship the clean path.)
		const tedi = await requireTediAccess(context, input.tediId);
		const limit = input.limit ?? 100;
		const conversationId = normalizeTediConversationIdForRead(
			input.conversationId,
		);
		// a soft-deleted conversation has no readable transcript. Mirror the
		// ORG-SCOPED hiding in `listConversations` — if any operator/key in the
		// org soft-deleted this session (`tedi_session_states.deletedAt` non-null,
		// `sessionKey` == conversationId), short-circuit to an empty transcript so
		// MCP/analytics/audit don't surface cleaned-up turns.
		const deleted = await isTediConversationDeleted(context.db, {
			organizationId: tedi.organizationId,
			tediId: input.tediId,
			conversationId,
		});
		if (deleted) {
			return {
				messages: [],
				compaction: null,
				nextCursor: null,
			};
		}
		const [rows, compactionRow] = await Promise.all([
			listTediConversationTranscriptRows(context.db, {
				tediId: input.tediId,
				conversationId,
				before: input.cursor,
				limit,
			}),
			getLatestTediConversationCompactionEvent(context.db, {
				tediId: input.tediId,
				conversationId,
			}),
		]);
		let compaction: TediConversationCompaction | null = null;
		if (compactionRow) {
			const payload = nonNullRecord(compactionRow.payload);
			const parsed = TediConversationCompactionSchema.safeParse({
				summary: payload?.summary,
				firstKeptEntryId: payload?.firstKeptEntryId,
				tokensBefore: payload?.tokensBefore,
				createdAt: compactionRow.createdAt,
				checkpoint: payload?.checkpoint,
			});
			if (parsed.success) compaction = parsed.data;
		}
		const orderedRows = rows.reverse();
		const completedRuns = new Map<string, string>();
		const runsWithCompletedMessage = new Set<string>();
		const deltasByRun = new Map<string, (typeof orderedRows)[number][]>();
		// Ψ5 Part B (server-side): track the FIRST `message.delta` createdAt
		// per run so hydrated assistant turns can populate `startedAt` and Tedix OS
		// can render elapsed work consistently after a reload. Preserve the first
		// timestamp while later deltas arrive.
		const firstDeltaByRun = new Map<string, string>();
		for (const row of orderedRows) {
			if (row.kind === "run.completed" && row.runId) {
				completedRuns.set(row.runId, row.createdAt);
				continue;
			}
			if (row.kind === "message.completed" && row.runId) {
				runsWithCompletedMessage.add(row.runId);
				continue;
			}
			if (row.kind === "message.delta" && row.runId) {
				const deltas = deltasByRun.get(row.runId) ?? [];
				deltas.push(row);
				deltasByRun.set(row.runId, deltas);
				if (!firstDeltaByRun.has(row.runId)) {
					firstDeltaByRun.set(row.runId, row.createdAt);
				}
			}
		}
		const assembledDeltaRows = [...deltasByRun.entries()]
			.filter(([runId]) => !runsWithCompletedMessage.has(runId))
			.flatMap(([, deltas]) => {
				const assembled = assembleCompletedContentFromDeltas(deltas);
				const sourceRow = assembled.sourceRow;
				if (!sourceRow) return [];
				const payload = nonNullRecord(sourceRow.payload);
				return [
					{
						...sourceRow,
						delta: assembled.content,
						payload: {
							...payload,
							assemblyMode: assembled.mode,
							content: assembled.content,
							sourceEventId: sourceRow.id,
						},
					},
				];
			});
		const renderRows = [
			...orderedRows.filter(
				(row) =>
					row.kind === "message.received" || row.kind === "message.completed",
			),
			...assembledDeltaRows,
		].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
		return {
			messages: renderRows.map((row): TediMessage => {
				const payload = nonNullRecord(row.payload);
				const completedAt = row.runId
					? completedRuns.get(row.runId)
					: undefined;
				const isDelta = row.kind === "message.delta";
				const role = readPayloadRole(payload, row.kind);
				// Ψ5 Part B: `startedAt` is the first delta time for an
				// assistant turn (or the row time if no delta was recorded,
				// e.g. completed-only or message.received). User turns stamp
				// the row time directly.
				const startedAt =
					role === "user"
						? row.createdAt
						: row.runId
							? (firstDeltaByRun.get(row.runId) ?? row.createdAt)
							: row.createdAt;
				return {
					id:
						isDelta && row.runId
							? `assistant:${row.runId}`
							: (row.messageId ?? row.id),
					tediId: row.tediId,
					conversationId: row.conversationId ?? conversationId,
					runId: row.runId ?? undefined,
					role,
					status:
						row.kind === "message.completed" || completedAt
							? "completed"
							: "pending",
					content: row.delta ?? readPayloadText(payload),
					attachments: readPayloadAttachments(payload),
					contentParts: jsonObjectArray(payload?.contentParts),
					toolCallIds: Array.isArray(payload?.toolCallIds)
						? (payload.toolCallIds as string[])
						: undefined,
					artifactIds: Array.isArray(payload?.artifactIds)
						? (payload.artifactIds as string[])
						: row.artifactId
							? [row.artifactId]
							: undefined,
					runtime: normalizeRuntimeRef(row),
					createdAt: row.createdAt,
					startedAt,
					completedAt:
						row.kind === "message.completed" ? row.createdAt : completedAt,
					metadata: payload,
				};
			}),
			compaction,
			nextCursor: nextCursor(rows, limit),
		};
	});
