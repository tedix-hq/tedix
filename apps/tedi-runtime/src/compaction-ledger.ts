import type { ReadMessagesOutput } from "@tedix/api-contract/schemas/cognitive-runtime";
import type {
	TediSessionCompactionResult,
	TediSessionDurableState,
} from "@tedix/tedi-session/session-harness";

/** One atomic cognitiveRuntime/readMessages response. */
export type LedgerConversationRead = Pick<
	ReadMessagesOutput,
	"messages" | "compaction"
>;

/**
 * Map the canonical D1 conversation read into the body-neutral session port.
 * Message ids are load-bearing: `firstKeptEntryId` points at this stable ledger
 * identity, not at a runtime-local timestamp or array offset.
 */
export function ledgerReadToDurableState(
	sessionKey: string,
	read: LedgerConversationRead | null,
): TediSessionDurableState {
	if (!read) return { entries: [], compaction: null };
	return {
		entries: read.messages
			.filter(
				(message) => message.role === "user" || message.role === "assistant",
			)
			.map((message) => ({
				// The DO-local append id prefixes the ledger idempotency key with the
				// session key. Recreate that exact identity so a locally selected cut
				// still matches after a body swap.
				id: `${sessionKey}:${message.id}`,
				role: message.role === "assistant" ? "assistant" : "user",
				content: message.content,
				// The ledger timestamp derives from the original turn timestamp. Invalid
				// legacy values sort as oldest so they back-fill instead of disappearing.
				ts: Date.parse(message.createdAt) || 0,
			})),
		compaction: read.compaction
			? {
					summary: read.compaction.summary,
					firstKeptEntryId: read.compaction.firstKeptEntryId,
					tokensBefore: read.compaction.tokensBefore,
					...(read.compaction.checkpoint
						? { checkpoint: read.compaction.checkpoint }
						: {}),
				}
			: null,
	};
}

export type CompactionLedgerPayload = Record<string, unknown> & {
	source: "isolate-compaction";
	sessionKey: string;
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	summaryChars: number;
	checkpoint?: NonNullable<ReadMessagesOutput["compaction"]>["checkpoint"];
};

/** Build the complete durable overlay carried by `context.compacted`. */
export function buildCompactionLedgerPayload(
	sessionKey: string,
	result: TediSessionCompactionResult,
): CompactionLedgerPayload {
	if (
		!result.compacted ||
		!result.summary ||
		!result.firstKeptEntryId ||
		result.tokensBefore == null
	) {
		throw new Error(
			"compacted session result is missing durable overlay fields",
		);
	}
	return {
		source: "isolate-compaction",
		sessionKey,
		summary: result.summary,
		firstKeptEntryId: result.firstKeptEntryId,
		tokensBefore: result.tokensBefore,
		summaryChars: result.summaryChars ?? result.summary.length,
		...(result.checkpoint ? { checkpoint: result.checkpoint } : {}),
	};
}
