/**
 * Auto-generated Home conversation titles (ChatGPT/Claude parity).
 *
 * When a Home conversation's FIRST exchange settles (first user message +
 * first assistant reply), generate a short 3-6 word title from that exchange
 * with a cheap provider-aware LLM call and persist it as the conversation's
 * label — using the SAME event-sourced storage the operator rename path uses
 * (`kernelRuntime.renameConversation` → a `conversation.updated` event in
 * `kernel_runtime_events`; `listConversations` overlays the newest title per
 * conversation).
 *
 * Invariants:
 * - NEVER overwrites an operator rename. Two layers of protection:
 *   1. The guard skips generation when ANY `conversation.updated` event
 *      already exists for the conversation (rename or prior auto-title).
 *   2. Auto-title events are stamped `source: "kernelRuntime.autoTitle"` and
 *      the `listConversations` overlay prefers the newest NON-auto event, so
 *      even a lost race can never shadow a human rename.
 * - Dispatched from the settle path: `runKernelTurnWork` calls the optional
 *   `generateConversationTitle` dep AFTER the run row and transcript events
 *   are durable. Contexts with a real `waitUntil` (inline /rpc HTTP path)
 *   fire-and-forget; waitUntil-less contexts (the KernelDO's synthetic turn
 *   context) return the promise so the turn body AWAITS it — a detached
 *   promise there is silently dropped when the DO is aborted/idled. Either
 *   way a lost title is acceptable; a broken settle is not — every branch
 *   here is fail-soft (bounded 10s LLM abort, never throws).
 * - `home:main` is excluded: it is the org's durable main Home thread (the
 *   Tedix OS labels it specially), not a topical chat.
 * - Marker-per-CI-run smoke/evidence conversations (see
 *   `EPHEMERAL_HOME_CONVERSATION_PREFIXES`) are excluded: ephemeral,
 *   machine-consumed, never opened by a human.
 * - Dispatched from TWO settle paths: the shared turn-work settle
 *   (`runKernelTurnWork`'s `generateConversationTitle` dep) for normal turns,
 *   and directly from `kernelRuntime.enqueueMessage`'s explicit-delegate
 *   branch (which bypasses `runKernelTurnWork` and writes its terminal event
 *   straight via `insertKernelRuntimeEvent`) — a conversation whose FIRST
 *   turn happens to delegate (e.g. `tedix tedi <target> ask "..."`) would
 *   otherwise never reach the dep at all and could never title itself.
 * - The instant PROVISIONAL title is a sibling mechanism owned by
 *   conversation-index.ts: the projection write-through stamps
 *   `fallbackConversationTitle(firstUserMessage)` with
 *   `title_source='provisional'` synchronously on the first `message.received`
 *   (projection-only — no `conversation.updated` event, so the guard below
 *   still sees zero title events and the auto-title upgrade is never blocked;
 *   the autoTitle write-through overwrites any non-rename source).
 * - Titles are at most six words, in the request's language, and never a code
 *   or id (`isCodeLikeConversationTitle`). An hourly bounded backfill
 *   ({@link backfillCodeLikeConversationTitles}) renames open conversations
 *   whose non-rename title is still one.
 */

import { kernelSpanContext } from "./gateway-attribution";
import {
	countKernelConversationEventsByKind,
	type KernelRuntimeEvent,
	listKernelRuntimeEvents,
} from "@tedix/db/queries/kernel-runtime-events";
import {
	advanceKernelConversationRetitleCursor,
	listKernelConversationRetitleCandidates,
} from "@tedix/db/queries/kernel-conversations";
import type { BaseContext } from "../../orpc";
import {
	fallbackConversationTitle,
	HOME_MAIN_CONVERSATION_ID,
	isCodeLikeConversationTitle,
	isEphemeralHomeConversation,
	KERNEL_AUTO_TITLE_SOURCE,
	sanitizeConversationTitle,
	stripConversationTitleContext,
} from "./conversation-index";
import { type KernelEnv, kernelModel } from "./llm";
import { insertKernelRuntimeEventWithStatus } from "./run-store";
import { safeExceptionTopology } from "../../../lib/safe-log-metadata";

/**
 * The live path and the code-like-title backfill share this prompt, so both
 * produce the same kind of title.
 */
export const TITLE_SYSTEM_PROMPT =
	"Write a title of at most 6 words that names what the user asked for in their first request, in the same language as that request. Use plain words: never a code, id or number on its own, and never the assistant's status (an approval request, an error, a refusal). Reply with the title only: plain text, no quotes, no trailing punctuation.";

/** Per-side excerpt cap — keeps the prompt tiny (and the call cheap). */
const TITLE_EXCERPT_CHARS = 500;

/** Bounded wall-clock budget for the title LLM round trip. */
const TITLE_GENERATION_TIMEOUT_MS = 10_000;

export interface ConversationTitleTurnInput {
	organizationId: string;
	conversationId: string;
	/** Settled run id — keys the idempotent auto-title event id. */
	runId: string;
	/** The first user message of the exchange. */
	userContent: string;
	/** The assistant reply that settled the exchange. */
	assistantContent: string;
}

function excerpt(value: string, maxChars: number): string {
	const trimmed = value.trim();
	return trimmed.length > maxChars ? trimmed.slice(0, maxChars) : trimmed;
}

/** Pure prompt builder — first user message + first assistant reply, truncated. */
export function buildConversationTitlePrompt(input: {
	userContent: string;
	assistantContent: string;
}): string {
	return [
		`User: ${excerpt(stripConversationTitleContext(input.userContent), TITLE_EXCERPT_CHARS)}`,
		`Assistant: ${excerpt(input.assistantContent, TITLE_EXCERPT_CHARS)}`,
	].join("\n\n");
}

/**
 * Pure guard: auto-title ONLY the first settled exchange of a topical Home
 * conversation that has no label yet.
 *
 * - `conversationUpdatedCount > 0` ⇒ an operator rename OR a prior auto-title
 *   already labelled it — never touch it again (only-write-if-empty).
 * - `completedMessageCount > 1` ⇒ not the first assistant settlement (the
 *   count includes the event the settling turn just inserted).
 */
export function evaluateAutoTitleGuard(input: {
	conversationId: string;
	conversationUpdatedCount: number;
	completedMessageCount: number;
}): boolean {
	if (input.conversationId === HOME_MAIN_CONVERSATION_ID) return false;
	if (isEphemeralHomeConversation(input.conversationId)) return false;
	return (
		input.conversationUpdatedCount === 0 && input.completedMessageCount <= 1
	);
}

/**
 * DB-backed guard read: one grouped count over the conversation's
 * `conversation.updated` + `message.completed` events, then the pure
 * {@link evaluateAutoTitleGuard} decision.
 */
export async function shouldAutoTitleHomeConversation(
	db: BaseContext["db"],
	input: { organizationId: string; conversationId: string },
): Promise<boolean> {
	if (input.conversationId === HOME_MAIN_CONVERSATION_ID) return false;
	if (isEphemeralHomeConversation(input.conversationId)) return false;
	const counts = await countKernelConversationEventsByKind(db, {
		organizationId: input.organizationId,
		conversationId: input.conversationId,
		kinds: ["conversation.updated", "message.completed"],
	});
	return evaluateAutoTitleGuard({
		conversationId: input.conversationId,
		conversationUpdatedCount: counts.get("conversation.updated") ?? 0,
		completedMessageCount: counts.get("message.completed") ?? 0,
	});
}

/**
 * Title one exchange: the cheap model call when a run can carry its cost,
 * else (or when the model output is unusable) the deterministic first-request
 * fallback. Returns `null` when neither yields a usable title.
 */
async function deriveConversationTitle(
	context: Pick<BaseContext, "env">,
	input: Omit<ConversationTitleTurnInput, "runId"> & { runId?: string },
): Promise<string | null> {
	// The title is part of the settled run, and billing counts it there: a
	// monetary plan with a per-run budget refuses a call without a run as
	// hard_spend_limit, so a run-less title uses the fallback only.
	const model = input.runId
		? kernelModel(context.env as unknown as KernelEnv, undefined, {
				organizationId: input.organizationId,
				runId: input.runId,
				sessionKey: input.conversationId,
				source: "kernel:conversation_title",
			})
		: null;
	let raw: string | undefined;
	if (model) {
		const abortController = new AbortController();
		const timeoutId = setTimeout(
			() => abortController.abort(),
			TITLE_GENERATION_TIMEOUT_MS,
		);
		try {
			const { tracedAi } = await import("../../../lib/traced-ai");
			const result = await tracedAi.generateText({
				model: model.model,
				instructions: TITLE_SYSTEM_PROMPT,
				runtimeContext: kernelSpanContext({
					organizationId: input.organizationId,
					sessionKey: input.conversationId,
					source: "conversation_title",
				}),
				telemetry: { functionId: "kernel.conversation_title" },
				messages: [
					{
						role: "user",
						content: buildConversationTitlePrompt({
							userContent: input.userContent,
							assistantContent: input.assistantContent,
						}),
					},
				],
				maxOutputTokens: 256,
				abortSignal: abortController.signal,
			});
			raw = result.text;
		} catch (error) {
			console.warn({
				component: "kernel.conversation_title",
				event: "auto_title_model_failed",
				exception: safeExceptionTopology(error),
			});
		} finally {
			clearTimeout(timeoutId);
		}
	}
	return (
		sanitizeConversationTitle(raw) ??
		fallbackConversationTitle(input.userContent)
	);
}

/**
 * Persist an auto title through the SAME storage as
 * kernelRuntime.renameConversation, distinguished by `source`. `eventKey`
 * makes the event id deterministic (insertKernelRuntimeEvent is
 * onConflictDoNothing on id), so a re-fired turn or backfill is idempotent.
 * Returns whether this call inserted the event.
 */
async function persistConversationAutoTitle(
	context: BaseContext,
	input: {
		organizationId: string;
		conversationId: string;
		runId?: string;
		eventKey: string;
		title: string;
	},
): Promise<boolean> {
	const { inserted } = await insertKernelRuntimeEventWithStatus(context, {
		id: [
			"home",
			input.organizationId,
			"event",
			"conversation.updated",
			input.conversationId,
			"auto",
			input.eventKey,
		].join(":"),
		organizationId: input.organizationId,
		kind: "conversation.updated",
		conversationId: input.conversationId,
		runId: input.runId,
		payload: {
			conversation: { title: input.title },
			title: input.title,
			source: KERNEL_AUTO_TITLE_SOURCE,
		},
	});
	return inserted;
}

/**
 * Generate + persist an auto title for a just-settled first exchange.
 * NEVER throws — every failure is a logged no-op (a lost title is acceptable;
 * this runs post-settle and must not disturb anything).
 *
 * Rides the SAME provider-aware model path as every secondary kernel LLM
 * surface: {@link kernelModel} (Azure via AI Gateway, or Workers AI under the
 * force flag / as configured), attributed to the org.
 */
export async function generateAndPersistHomeConversationTitle(
	context: BaseContext,
	input: ConversationTitleTurnInput,
): Promise<void> {
	try {
		// This path is fire-and-forget, so retain a content-free outcome event.
		if (!input.userContent.trim() || !input.assistantContent.trim()) {
			console.log({
				component: "kernel.conversation_title",
				event: "auto_title_skipped",
				reason: "empty_exchange",
			});
			return;
		}
		const eligible = await shouldAutoTitleHomeConversation(context.db, {
			organizationId: input.organizationId,
			conversationId: input.conversationId,
		});
		if (!eligible) {
			console.log({
				component: "kernel.conversation_title",
				event: "auto_title_skipped",
				reason: "guard",
			});
			return;
		}

		const title = await deriveConversationTitle(context, input);
		if (!title) {
			console.log({
				component: "kernel.conversation_title",
				event: "auto_title_skipped",
				reason: "unusable_model_output",
			});
			return;
		}

		await persistConversationAutoTitle(context, {
			organizationId: input.organizationId,
			conversationId: input.conversationId,
			runId: input.runId,
			eventKey: input.runId,
			title,
		});
		console.log({
			component: "kernel.conversation_title",
			event: "auto_title_set",
		});
	} catch (error) {
		console.warn({
			component: "kernel.conversation_title",
			event: "auto_title_failed",
			exception: safeExceptionTopology(error),
		});
	}
}

/** First user request and first reply of a conversation, from the ledger. */
function firstExchange(events: readonly KernelRuntimeEvent[]): {
	userContent: string;
	assistantContent: string;
	runId?: string;
} | null {
	const payloadOf = (event: KernelRuntimeEvent) =>
		(event.payload ?? {}) as Record<string, unknown>;
	const request = events.find(
		(event) =>
			event.kind === "message.received" &&
			payloadOf(event).role === "user" &&
			typeof payloadOf(event).content === "string",
	);
	if (!request) return null;
	const reply = events.find(
		(event) =>
			event.kind === "message.completed" &&
			event.createdAt >= request.createdAt &&
			typeof payloadOf(event).content === "string",
	);
	return {
		userContent: payloadOf(request).content as string,
		assistantContent: reply ? (payloadOf(reply).content as string) : "",
		runId: reply?.runId ?? undefined,
	};
}

/** Rows scanned per backfill tick; each renamed row costs at most one model call. */
const RETITLE_BACKFILL_BATCH = 20;

/**
 * Bounded, idempotent rename of open conversations whose auto or provisional
 * title is a code or id (`A304`, a uuid fragment). Titles derive from the
 * first request exactly as the live path does; user renames are never
 * candidates. A CAS cursor walks the candidates across ticks, so a row that
 * stays untitleable cannot starve later ones, and the fixed `retitle` event
 * key keeps a replayed tick from writing twice.
 */
export async function backfillCodeLikeConversationTitles(
	context: BaseContext,
): Promise<{ titleBackfillScanned: number; titleBackfillRenamed: number }> {
	const { rows, previous } = await listKernelConversationRetitleCandidates(
		context.db,
		{ limit: RETITLE_BACKFILL_BATCH },
	);
	let renamed = 0;
	for (const row of rows) {
		if (
			!isCodeLikeConversationTitle(row.title) ||
			row.conversationId === HOME_MAIN_CONVERSATION_ID ||
			isEphemeralHomeConversation(row.conversationId)
		)
			continue;
		try {
			const exchange = firstExchange(
				await listKernelRuntimeEvents(context.db, {
					organizationId: row.organizationId,
					conversationId: row.conversationId,
					kinds: ["message.received", "message.completed"],
					order: "asc",
					limit: 6,
				}),
			);
			if (!exchange) continue;
			const title = await deriveConversationTitle(context, {
				organizationId: row.organizationId,
				conversationId: row.conversationId,
				...exchange,
			});
			if (!title) continue;
			if (
				await persistConversationAutoTitle(context, {
					organizationId: row.organizationId,
					conversationId: row.conversationId,
					runId: exchange.runId,
					eventKey: "retitle",
					title,
				})
			)
				renamed++;
		} catch (error) {
			console.warn({
				component: "kernel.conversation_title",
				event: "title_backfill_failed",
				exception: safeExceptionTopology(error),
			});
		}
	}
	const last = rows.at(-1);
	await advanceKernelConversationRetitleCursor(
		context.db,
		previous,
		last ? last.id : "",
	);
	return { titleBackfillScanned: rows.length, titleBackfillRenamed: renamed };
}
