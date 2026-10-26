import type { DbClient } from "@tedix/db/client";
import { excludeWithdrawnSteering } from "./steering-history";
import { TediMessageAttachmentSchema } from "@tedix/api-contract/schemas/cognitive-runtime";
import { listKernelRuntimeEvents } from "@tedix/db/queries/kernel-runtime-events";
import type {
	SessionHarnessBackend,
	TediSessionContextEntry,
	TediSessionMessage,
	TediSessionTurn,
} from "@tedix/tedi-session/session-harness";
import {
	SessionHarness,
	toMessages,
} from "@tedix/tedi-session/session-harness";
import { routeAttemptPromptTokens } from "./context-compaction";

/**
 * Rows fetched from the canonical D1 ledger for one turn's replay projection.
 *
 * This is a read-safety bound, not a context bound. The context bound is
 * measured token pressure against the serving model's window (see
 * {@link DEFAULT_MAX_PROMPT_TOKENS} and `context-compaction.ts`); this number
 * only keeps one indexed D1 query and the Worker's memory finite.
 *
 * Sized against the measured envelope: on the Azure lane history may reach
 * ~410 000 chars before the compaction trigger, so 400 messages stay under it
 * only while they average below ~1 000 chars each. Above that size — and on the
 * Workers AI lane always, where the trigger arrives at ~70 messages — compaction
 * is what cuts, not this read. 400 messages is ~200 operator exchanges in one
 * conversation, well past any observed Home thread.
 *
 * It is therefore still a ceiling on very long, very short-message threads. That
 * is a deliberate read-cost tradeoff, not a context policy: raising it costs one
 * larger indexed D1 read per turn and nothing else.
 *
 * Empty-content rows and the current turn's own user message are dropped
 * post-read, so the effective entry count is slightly lower.
 */
const HISTORY_ROW_READ_LIMIT = 400;

// Conversation history (kernel-side SessionHarness backend over the D1 ledger)
// ============================================================================

/**
 * Map one `kernel_runtime_events` transcript row to the harness's body-neutral
 * turn shape. Role derives from the event kind (`message.received` = the
 * operator, `message.completed` = the kernel/assistant), mirroring
 * `kernelRuntime.readMessages`; `ts` is the row's `createdAt` — the stable join
 * key the harness reconciles on (never content).
 */
/**
 * The CLI appends a "Local terminal context" block (cwd, git root, status) to
 * every message it sends. It matters for the turn it was sent with — that turn
 * receives it in the operator message, not here — and is pure repetition when
 * replayed as history: one probe conversation carried 71 copies (~3 000 of
 * ~4 700 history tokens). Replay keeps the operator's words only.
 */
const LOCAL_TERMINAL_CONTEXT_BLOCK =
	/\n\nLocal terminal context:\n(?:- [^\n]*(?:\n {2}[^\n]*)*(?:\n|$))+/g;

export function stripLocalTerminalContext(content: string): string {
	if (!content.includes("Local terminal context:")) return content;
	return content.replace(LOCAL_TERMINAL_CONTEXT_BLOCK, "\n").trimEnd();
}

function homeEventRowToTurn(row: {
	kind: string;
	conversationId: string;
	payload: Record<string, unknown> | null;
	createdAt: string;
}): TediSessionTurn {
	const rawContent = row.payload?.content;
	const content =
		row.kind === "message.received" && typeof rawContent === "string"
			? stripLocalTerminalContext(rawContent)
			: rawContent;
	const attachments =
		row.kind === "message.received" && Array.isArray(row.payload?.attachments)
			? row.payload.attachments.flatMap((value) => {
					const parsed = TediMessageAttachmentSchema.safeParse(value);
					return parsed.success ? [parsed.data] : [];
				})
			: [];
	return {
		role: row.kind === "message.received" ? "user" : "assistant",
		content: typeof content === "string" ? content : "",
		...(attachments.length ? { attachments } : {}),
		sessionKey: row.conversationId,
		ts: Date.parse(row.createdAt),
	};
}

/**
 * De-duplicate the replay projection. Pure; order preserved (oldest → newest).
 *
 * This function used to also bound the history: keep the newest 8 entries,
 * truncate each to 2 048 chars, then drop oldest-first under a 4 096-char total.
 * That assembly-time cap was the defect. It discarded silently, and because
 * history could contribute at most ~4 KB against a ~421 600-char compaction
 * trigger, the compaction subsystem — summarizer and all — could never fire:
 * history would have had to be ~94× larger than the cap permitted. Bounding is
 * now compaction's job alone, driven by measured token pressure against the
 * serving model's window. All that survives here is the correctness fix:
 *
 * RunId dedup: when entries carry an optional `runId`, at most one
 * `message.completed` (assistant) entry per runId is retained — the latest one
 * for that runId (a leaky ledger may write duplicate rows for the same
 * completed turn; keeping the last one is safe because the content of a
 * completed assistant message is idempotent for the same runId). Running it here
 * keeps the duplicates out of the budget accounting downstream.
 */
export function dedupeConversationHistory(
	entries: ReadonlyArray<TediSessionContextEntry & { runId?: string | null }>,
): TediSessionContextEntry[] {
	// Dedup: for assistant entries that share a runId keep only the last one
	// (latest by position in the already-ascending slice).
	const dedupedEntries: (typeof entries)[number][] = [];
	const seenCompletedRunIds = new Set<string>();
	// Scan in reverse to identify which (latest) entry per runId to keep.
	const reversedForDedup = [...entries].reverse();
	const keepSet = new Set<number>();
	const origLength = entries.length;
	for (let i = 0; i < reversedForDedup.length; i++) {
		const entry = reversedForDedup[i];
		if (!entry) continue;
		const origIndex = origLength - 1 - i;
		if (entry.role === "assistant" && entry.runId) {
			if (!seenCompletedRunIds.has(entry.runId)) {
				seenCompletedRunIds.add(entry.runId);
				keepSet.add(origIndex);
			}
			// else: duplicate — skip it
		} else {
			keepSet.add(origIndex);
		}
	}
	for (let i = 0; i < origLength; i++) {
		if (keepSet.has(i)) {
			const e = entries[i];
			if (e) dedupedEntries.push(e);
		}
	}

	return dedupedEntries;
}

/**
 * Kernel-side SessionHarness backend over the canonical D1 ledger. There is no
 * hot cache in Home, so `listTurns()` is empty and `readMessages()` is the
 * whole transcript source. The current turn is excluded by its ledger message
 * id before rows become body-neutral session entries; same-millisecond turns
 * cannot collide because the D1 backend has message ids while isolate caches do
 * not.
 */
class KernelHomeSessionBackend implements SessionHarnessBackend {
	/**
	 * Provider-reported prompt tokens of the newest `message.completed` row this
	 * backend read — the measured size of the last persisted step's request.
	 * `null` until a read happens, and `null` afterwards when the provider
	 * reported no usage (the per-step check then reloads and remeasures).
	 */
	lastStepPromptTokens: number | null = null;

	constructor(
		private readonly db: DbClient,
		private readonly organizationId: string,
		private readonly excludeMessageId?: string,
	) {}

	listTurns(): ReadonlyArray<TediSessionTurn> {
		return [];
	}

	appendTurn(): boolean {
		return false;
	}

	async readMessages(
		sessionKey: string,
		limit = HISTORY_ROW_READ_LIMIT,
	): Promise<TediSessionContextEntry[]> {
		const rows = await listKernelRuntimeEvents(this.db, {
			organizationId: this.organizationId,
			conversationId: sessionKey,
			kinds: ["message.received", "message.completed"],
			order: "desc",
			limit,
		});

		// Rows are DESC (newest first): the first completed step that carries
		// provider usage is the measurement the next request projects from.
		// Read defensively — the payload is a JSON bag, not a typed column.
		this.lastStepPromptTokens = readStepPromptTokens(rows);

		const projectedRows = await excludeWithdrawnSteering(
			this.db,
			this.organizationId,
			sessionKey,
			rows,
		);
		return [...projectedRows]
			.reverse()
			.filter(
				(row) =>
					!this.excludeMessageId || row.messageId !== this.excludeMessageId,
			)
			.map((row) => {
				const turn = homeEventRowToTurn(row);
				return {
					role: turn.role,
					content: turn.content,
					...(turn.attachments?.length
						? { attachments: turn.attachments }
						: {}),
					ts: turn.ts,
					// Thread runId so dedupeConversationHistory can dedup duplicate
					// message.completed rows from a leaky ledger.
					runId: row.runId ?? undefined,
				};
			});
	}
}

/**
 * Provider-reported prompt tokens of the newest persisted assistant step.
 *
 * `turn-work.ts` writes the route planner's `routeUsage` onto every
 * `message.completed` payload (`payload.usage`), so the canonical ledger already
 * carries the measured prompt size of the last step — no second store and no new
 * write. Returns `null` when no completed step carries usage, which is exactly
 * the "provider reported none" case the caller reloads on.
 */
export function readStepPromptTokens(
	rowsNewestFirst: ReadonlyArray<{
		kind: string;
		payload: Record<string, unknown> | null;
	}>,
): number | null {
	for (const row of rowsNewestFirst) {
		if (row.kind !== "message.completed") continue;
		const usage = row.payload?.usage;
		if (!usage || typeof usage !== "object") continue;
		// Per-attempt usage is on the ledger: measure the route call, not the
		// step's sum over route + rankings (+ summarizer).
		const attempts = (usage as { attempts?: unknown }).attempts;
		if (Array.isArray(attempts)) {
			const routeTokens = routeAttemptPromptTokens(
				attempts as Parameters<typeof routeAttemptPromptTokens>[0],
			);
			if (routeTokens !== null) return routeTokens;
		}
		const inputTokens = (usage as { inputTokens?: unknown }).inputTokens;
		if (typeof inputTokens !== "number" || !Number.isFinite(inputTokens)) {
			continue;
		}
		if (inputTokens <= 0) continue;
		return inputTokens;
	}
	return null;
}

/** The replay projection plus the measured size of the step that produced it. */
export interface ConversationHistoryRead {
	messages: TediSessionMessage[];
	lastStepPromptTokens: number | null;
}

export async function fetchConversationHistory(
	db: DbClient,
	organizationId: string,
	conversationId: string,
	excludeMessageId?: string,
): Promise<ConversationHistoryRead> {
	const backend = new KernelHomeSessionBackend(
		db,
		organizationId,
		excludeMessageId,
	);
	const harness = new SessionHarness(backend);
	const messages = await harness.buildContext(conversationId, {
		requireContent: true,
	});
	const entries = messages.map((message, index) => ({
		...message,
		ts: index,
	}));
	return {
		messages: toMessages(dedupeConversationHistory(entries)),
		lastStepPromptTokens: backend.lastStepPromptTokens,
	};
}
