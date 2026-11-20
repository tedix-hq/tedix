/**
 * Memory recall for a message a signed-in person sent to a tedi in the chat.
 * Someone is waiting on the first word, so this path does less than the
 * shared `brainDigestAddendum`: a follow-up within a short window reuses the
 * previous turn's recall and task state, and the task-state read is one
 * capped request. Scheduled and delegated turns never come through here.
 */
import type { TurnMemory } from "@tedix/api-contract/schemas/turn-memory";
import { memorySourceReferences } from "@tedix/context-core/memory-freshness";
import { DEFAULT_SESSION_KEY } from "@tedix/tedi-session/session-harness";
import { serializeBrainDigest } from "./brain/brain-digest";
import {
	type MemoryRecallReport,
	recallLongTermMemoryBlock,
} from "./memory-recall";
import type { RuntimeMemoryHost } from "./runtime-memory";
import {
	mergeTurnMemory,
	readTurnMemory,
	renderTurnMemory,
} from "./turn-memory";

/** A follow-up this soon after a full recall reuses it instead of recomputing. */
export const PERSON_CHAT_RECALL_REUSE_MS = 5 * 60_000;
/**
 * Task references whose live state joins one chat turn. The shared path checks
 * every id in the digest and the whole conversation (three serial requests and
 * most of a 19k-token block on 20 Nov); a chat turn keeps the nearest ones.
 */
export const PERSON_CHAT_REFERENCE_CAP = 40;
const STORE_KEY = "memory:person-chat-recall";

interface StoredRecall {
	at: number;
	recall: string;
	state: TurnMemory;
}

export async function personChatMemoryAddendum(
	this: RuntimeMemoryHost,
	input: {
		userText: string;
		sessionKey?: string | null;
		learningDisabled?: boolean;
		onRecall?: (report: MemoryRecallReport) => void;
	},
): Promise<string> {
	const started = performance.now();
	const sessionKey = input.sessionKey ?? DEFAULT_SESSION_KEY;
	const kv = this.ctx.storage.kv;
	const now = Date.now();
	const recent = Object.fromEntries(
		Object.entries(
			kv.get<Record<string, StoredRecall>>(STORE_KEY) ?? {},
		).filter(([, stored]) => now - stored.at < PERSON_CHAT_RECALL_REUSE_MS),
	);
	const previous = recent[sessionKey];
	const refresh = async (references: string[]) => {
		const platform = await this.getPlatformClient();
		if (!platform) throw new Error("Task-state platform unavailable");
		return platform.getTurnMemory(references);
	};
	const recallPromise = previous
		? null
		: recallLongTermMemoryBlock({
				userText: input.userText,
				search: async (query, limit) => {
					const platform = await this.getPlatformClient();
					return platform
						? await platform.memorySearch(
								query,
								limit,
								input.learningDisabled ? { recordAccess: false } : undefined,
							)
						: null;
				},
			});
	await this.ensureBrainDigestLoaded();
	const digest = this.brainDigest ? serializeBrainDigest(this.brainDigest) : "";
	// Nearest first, so the cap drops the oldest conversation references.
	const named = memorySourceReferences(input.userText).slice(
		0,
		PERSON_CHAT_REFERENCE_CAP,
	);
	let recall: string;
	let state: TurnMemory | null;
	if (previous) {
		recall = previous.recall;
		input.onRecall?.({
			outcome: "reused",
			durationMs: Math.round(performance.now() - started),
			factCount: 0,
		});
		// Tasks the new message names are still read live.
		state =
			named.length > 0
				? await readTurnMemory(named, refresh).then(
						(live) => mergeTurnMemory([previous.state, live]),
						() => null,
					)
				: previous.state;
	} else {
		const { block, ...report } = await recallPromise!;
		recall = block;
		input.onRecall?.(report);
		const history = [...this.messagesForSession(sessionKey)].reverse();
		const references = memorySourceReferences(
			`${input.userText}\n${recall}\n${digest}\n${JSON.stringify(history)}`,
		).slice(0, PERSON_CHAT_REFERENCE_CAP);
		state = await readTurnMemory(references, refresh).catch(() => null);
		// Only a finished search is worth reusing: a skipped or timed-out one
		// would withhold memory from the next message too.
		if (state && report.outcome === "completed")
			kv.put(STORE_KEY, {
				...recent,
				[sessionKey]: { at: now, recall, state },
			});
	}
	return [digest, recall, renderTurnMemory(state)].filter(Boolean).join("\n\n");
}
