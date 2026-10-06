/**
 * Kernel — durable Home conversation index (`kernel_conversations`).
 *
 * - **Write-through** ({@link applyKernelConversationEvent}): called from the
 *   kernel event choke point (`insertKernelRuntimeEvent`) for the kinds that
 *   matter. One upsert per relevant event; irrelevant kinds (e.g. the ~3s
 *   `message.delta` stream) cost nothing. Always fail-soft — a projection
 *   failure must never break the event write.
 * - **Indexed page read** ({@link selectKernelConversationIndexPage}): ordered
 *   by `last_message_at DESC, conversation_id DESC` with a real keyset cursor.
 *
 * `kernel_runtime_events` stays the source of truth; this table is a
 * rebuildable read model. An
 * operator rename ALWAYS beats an auto-generated title, which beats the
 * instant first-message placeholder, regardless of event order
 * (`title_source`: `rename` > `autoTitle` > `provisional` > payload/none).
 * `provisional` is projection-only (no `conversation.updated` event): the
 * write-through stamps it from the FIRST user message of a topical
 * conversation so the sidebar never shows "New chat" after a reload, and a
 * ledger rebuild simply drops it (the auto-title event re-titles).
 *
 * This module must NOT import kernel-runtime.ts or run-store.ts (both import
 * this module; a value import back would create a cycle).
 */

import {
	type KernelConversationRow,
	listKernelConversationPage,
	recordKernelConversationArchived,
	recordKernelConversationDeleted,
	recordKernelConversationMessage,
	recordKernelConversationPinned,
	recordKernelConversationTitle,
} from "@tedix/db/queries/kernel-conversations";
import type { KernelRuntimeEvent } from "@tedix/db/queries/kernel-runtime-events";
import type { BaseContext } from "../../orpc";
import { kernelConversationOriginFromPayload } from "./conversation-origin";
import {
	errorMessage,
	nonNullRecord,
	stringFromPayload,
} from "./runtime-shared";

/**
 * Provenance marker on auto-title `conversation.updated` payloads. The
 * operator rename path stamps `source: "kernelRuntime.renameConversation"`;
 * any non-auto source counts as a rename for title precedence. (Declared here
 * so conversation-title.ts can import it without a module cycle; re-exported
 * there for existing callers.)
 */
export const KERNEL_AUTO_TITLE_SOURCE = "kernelRuntime.autoTitle";

/** The org's durable main Home thread — never auto- or provisionally titled. */
export const HOME_MAIN_CONVERSATION_ID = "home:main";

/**
 * Marker-per-run smoke/evidence conversations (CI-only, `Date.now()`-suffixed,
 * consumed as machine-readable release-gate JSON — never opened by a human in
 * the Tedix OS sidebar). Auto-titling these would spend a real LLM call per CI run
 * for zero user-visible benefit, so they're excluded defense-in-depth
 * regardless of which code path a future turn-settle dispatch runs through.
 * See the retired steering live smoke and
 * `scripts/mcp/tasks-live-smoke.ts`.
 * (Declared here rather than in conversation-title.ts so the write-through
 * projection can use it without a module cycle; re-exported there.)
 */
export const EPHEMERAL_HOME_CONVERSATION_PREFIXES = [
	"home:kernel-steering:",
	"home:mcp-tasks-live-smoke-",
	"home:tedi-coding-delegation-smoke:",
] as const;

export function isEphemeralHomeConversation(conversationId: string): boolean {
	return EPHEMERAL_HOME_CONVERSATION_PREFIXES.some((prefix) =>
		conversationId.startsWith(prefix),
	);
}

/** Titles that carry no information — never persist these. */
const PLACEHOLDER_TITLE_RE =
	/^(conversation|chat|session|thread|new|new chat|untitled|untitled chat|home|title)$/i;

/**
 * Refusal/apology-shaped model output — the title model (or the exchange it
 * summarized) declined instead of titling. Persisting it labels the chat
 * "I'm sorry, but I can't help with that" (observed live). Better no title
 * (the Tedix OS's "New chat" fallback) than a refusal as a permanent label.
 */
const REFUSAL_TITLE_RE =
	/^(i['’]?\s?m sorry\b|sorry\b|i apologi|i can['’]?t\b|i cannot\b|i['’]?m unable\b|unable to\b|i won['’]?t\b|as an ai\b)/i;

/** Context envelopes are references, not the conversation's topic. */
export function stripConversationTitleContext(value: string): string {
	return value
		.replace(/\[\[tedix-context:[^\]\r\n]*\]\]/g, " ")
		.replace(/\[\[tedix-context:[^\r\n]*/g, " ")
		.trim();
}

/**
 * Pure model-output sanitizer: first non-empty line, markdown/quote wrappers
 * stripped, whitespace collapsed, trailing sentence punctuation removed,
 * capped at 8 words / 80 chars. Returns `null` for empty or placeholder
 * output so the caller persists nothing rather than junk. (Declared here for
 * the provisional-title write-through; re-exported by conversation-title.ts.)
 */
export function sanitizeConversationTitle(
	raw: string | null | undefined,
): string | null {
	if (typeof raw !== "string") return null;
	let title =
		stripConversationTitleContext(raw)
			.split(/\r?\n/)
			.map((line) => line.trim())
			.find((line) => line.length > 0) ?? "";
	// Strip leading markdown/list decoration ("# ", "> ", "- ", "* ").
	title = title.replace(/^[#>*\-\s]+/, "");
	// Strip a leading "Title:" style prefix some models add.
	title = title.replace(/^title\s*[:-]\s*/i, "");
	// Unwrap symmetric quote/backtick wrappers (possibly nested).
	for (;;) {
		const wrapped = title.match(/^["'`“”‘’](.*)["'`“”‘’]$/);
		const inner = wrapped?.[1]?.trim();
		if (inner === undefined || inner.length === 0 || inner === title) break;
		title = inner;
	}
	title = title.replace(/\s+/g, " ").trim();
	title = title.replace(/[.!?,;:]+$/, "").trim();
	if (!title) return null;
	const words = title.split(" ");
	if (words.length > 8) title = words.slice(0, 8).join(" ");
	if (title.length > 80) title = title.slice(0, 80).trim();
	if (PLACEHOLDER_TITLE_RE.test(title)) return null;
	if (REFUSAL_TITLE_RE.test(title)) return null;
	return title;
}

/** Deterministic first-message title (provisional write-through + auto-title fallback). */
export function fallbackConversationTitle(userContent: string): string | null {
	const content = stripConversationTitleContext(userContent);
	const firstSentence = content.split(/[.!?\n]/, 1)[0] ?? content;
	return sanitizeConversationTitle(firstSentence);
}

/** Composite keyset cursor separator — never appears in an ISO timestamp. */
const CURSOR_SEPARATOR = "|";

const MESSAGE_EVENT_KINDS = new Set(["message.received", "message.completed"]);

/**
 * `rename` > `autoTitle` > `provisional`. `provisional` is the instant
 * deterministic first-message placeholder written through the projection only
 * (never a `conversation.updated` event) so a brand-new conversation has a
 * sidebar label before the post-settle auto-title lands and replaces it.
 */
export type KernelConversationTitleSource =
	| "rename"
	| "autoTitle"
	| "provisional";

export interface KernelConversationCursor {
	lastMessageAt: string;
	conversationId: string;
}

export function encodeKernelConversationCursor(row: {
	lastMessageAt: string;
	conversationId: string;
}): string {
	return `${row.lastMessageAt}${CURSOR_SEPARATOR}${row.conversationId}`;
}

export function parseKernelConversationCursor(
	cursor: string | undefined,
): KernelConversationCursor | null {
	if (!cursor) return null;
	const separatorAt = cursor.indexOf(CURSOR_SEPARATOR);
	if (separatorAt <= 0 || separatorAt === cursor.length - 1) {
		throw new Error("Invalid conversation cursor");
	}
	return {
		lastMessageAt: cursor.slice(0, separatorAt),
		// The conversation id may itself contain the separator; only the first
		// occurrence splits (ISO timestamps never contain it).
		conversationId: cursor.slice(separatorAt + 1),
	};
}

function titleFromEventPayload(
	payload: Record<string, unknown> | undefined,
): string | undefined {
	return (
		stringFromPayload(nonNullRecord(payload?.conversation)?.title) ??
		stringFromPayload(payload?.title)
	);
}

function workspaceContextFromEventPayload(
	payload: Record<string, unknown> | undefined,
): {
	workspaceId: string | null;
	workpieceKind: "gadget" | "output" | null;
	workpieceId: string | null;
} {
	const metadata = nonNullRecord(payload?.metadata);
	const workspaceContext = nonNullRecord(metadata?.workspaceContext);
	const workspaceId = stringFromPayload(workspaceContext?.workspaceId) ?? null;
	const workpiece = nonNullRecord(workspaceContext?.workpiece);
	const kind = stringFromPayload(workpiece?.kind);
	return {
		workspaceId,
		workpieceKind: kind === "gadget" || kind === "output" ? kind : null,
		workpieceId: stringFromPayload(workpiece?.id) ?? null,
	};
}

/**
 * Soft-delete marker on a `conversation.updated` payload — sibling to
 * {@link titleFromEventPayload}. `kernelRuntime.deleteConversation` reuses the
 * SAME event kind `renameConversation` writes (never a new kind, never a hard
 * delete of the event row) with a `deletedAt` ISO timestamp instead of a
 * `title`. Once set, the projection's `deleted_at` column is sticky — a later
 * event for the conversation (e.g. a stray late-arriving message) must never
 * clear it back to visible.
 */
function deletedAtFromEventPayload(
	payload: Record<string, unknown> | undefined,
): string | undefined {
	return (
		stringFromPayload(nonNullRecord(payload?.conversation)?.deletedAt) ??
		stringFromPayload(payload?.deletedAt)
	);
}

/**
 * Pin marker on a `conversation.updated` payload — sibling to
 * {@link deletedAtFromEventPayload}. `kernelRuntime.pinConversation` reuses the
 * SAME event kind with a `pinned` boolean. Returns the boolean when the key is
 * present (`true` pins, `false` unpins), or `undefined` when this event is not a
 * pin event (a rename/delete) so the pin branch is skipped. Unlike deletedAt,
 * pinnedAt is CLEARABLE — an unpin event sets the projection column back to null.
 */
function pinnedFromEventPayload(
	payload: Record<string, unknown> | undefined,
): boolean | undefined {
	const nested = nonNullRecord(payload?.conversation)?.pinned;
	if (typeof nested === "boolean") return nested;
	return typeof payload?.pinned === "boolean" ? payload.pinned : undefined;
}

/** Clearable archive marker carried by `conversation.updated` events. */
function archivedFromEventPayload(
	payload: Record<string, unknown> | undefined,
): boolean | undefined {
	const nested = nonNullRecord(payload?.conversation)?.archived;
	if (typeof nested === "boolean") return nested;
	return typeof payload?.archived === "boolean" ? payload.archived : undefined;
}

function titleSourceFromEventPayload(
	payload: Record<string, unknown> | undefined,
): Exclude<KernelConversationTitleSource, "provisional"> {
	return stringFromPayload(payload?.source) === KERNEL_AUTO_TITLE_SOURCE
		? "autoTitle"
		: "rename";
}

/**
 * Write-through from the kernel event choke point. Cost per event:
 * - `message.received` / `message.completed`: ONE upsert (bump
 *   `last_message_at` monotonically, `message_count + 1`).
 * - `conversation.updated`: ONE upsert (title; rename always beats autoTitle).
 * - Every other kind: zero statements.
 *
 * FAIL-SOFT: never throws — a projection failure (including the table not
 * existing yet before the schema sync lands) must never break the event write.
 */
export async function applyKernelConversationEvent(
	db: BaseContext["db"],
	event: KernelRuntimeEvent,
): Promise<void> {
	try {
		if (MESSAGE_EVENT_KINDS.has(event.kind)) {
			const payload = nonNullRecord(event.payload);
			const workspaceContext = workspaceContextFromEventPayload(payload);
			const channel = stringFromPayload(payload?.channel) ?? null;
			// Instant provisional title: the FIRST user message of an untitled
			// topical Home conversation labels the sidebar synchronously (no LLM,
			// same statement as the recency/count bump) so a reload in the first
			// seconds never shows "New chat". `title_source='provisional'` is the
			// weakest source — the post-settle auto-title overwrites it, a rename
			// beats both. Projection-only by design: no `conversation.updated`
			// event, so the auto-title guard (which counts those events) is not
			// blocked and a ledger rebuild simply drops the placeholder.
			const provisionalTitle =
				event.kind === "message.received" &&
				stringFromPayload(payload?.role) === "user" &&
				event.conversationId !== HOME_MAIN_CONVERSATION_ID &&
				!isEphemeralHomeConversation(event.conversationId)
					? fallbackConversationTitle(stringFromPayload(payload?.content) ?? "")
					: null;
			await recordKernelConversationMessage(db, {
				organizationId: event.organizationId,
				conversationId: event.conversationId,
				channel,
				createdAt: event.createdAt,
				provisionalTitle,
				// Only the turn-ingress event carries a stamp (run-store.ts
				// `stampConversationOrigin`). `null` here means "this event says
				// nothing about origin" — the query leaves the column untouched
				// rather than writing a default, so a `message.completed` can never
				// reclassify a conversation and a ledger rebuild (which replays
				// unstamped historical events) leaves every legacy row human.
				origin: kernelConversationOriginFromPayload(payload),
				...workspaceContext,
			});
			return;
		}
		if (event.kind === "conversation.updated") {
			const payload = nonNullRecord(event.payload);
			const deletedAt = deletedAtFromEventPayload(payload);
			if (deletedAt) {
				// Legacy conversation.updated deletedAt frames and the permanent-delete
				// tombstone both hide the projection row.
				// Sticky: COALESCE never clears an already-set deletedAt back to
				// null, so a stray later event for a deleted conversation can never
				// resurrect it in the list.
				await recordKernelConversationDeleted(db, {
					organizationId: event.organizationId,
					conversationId: event.conversationId,
					createdAt: event.createdAt,
					deletedAt,
				});
				return;
			}
			const archived = archivedFromEventPayload(payload);
			if (archived !== undefined) {
				await recordKernelConversationArchived(db, {
					organizationId: event.organizationId,
					conversationId: event.conversationId,
					createdAt: event.createdAt,
					archived,
				});
				return;
			}
			const pinned = pinnedFromEventPayload(payload);
			if (pinned !== undefined) {
				// kernelRuntime.pinConversation — set/clear the pin marker. Unlike
				// deletedAt this is NOT sticky: an unpin (`pinned: false`) writes null.
				// A pin event does not bump recency (last_message_at only seeds a row
				// message events have not created yet).
				await recordKernelConversationPinned(db, {
					organizationId: event.organizationId,
					conversationId: event.conversationId,
					createdAt: event.createdAt,
					pinned,
				});
				return;
			}
			const title = titleFromEventPayload(payload);
			if (!title) return;
			const titleSource = titleSourceFromEventPayload(payload);
			await recordKernelConversationTitle(db, {
				organizationId: event.organizationId,
				conversationId: event.conversationId,
				createdAt: event.createdAt,
				title,
				titleSource,
			});
		}
	} catch (error) {
		console.warn("[kernelRuntime] conversation index write-through failed", {
			organizationId: event.organizationId,
			conversationId: event.conversationId,
			kind: event.kind,
			error: errorMessage(error),
		});
	}
}

/**
 * Indexed keyset page read: `ORDER BY last_message_at DESC, conversation_id
 * DESC`, cursor `(last_message_at, conversation_id) < (cursor)`.
 */
export async function selectKernelConversationIndexPage(
	db: BaseContext["db"],
	input: {
		organizationId: string;
		cursor: KernelConversationCursor | null;
		limit: number;
		workspaceId?: string;
		includeArchived?: boolean;
	},
): Promise<KernelConversationRow[]> {
	return listKernelConversationPage(db, {
		...input,
		// `isEphemeralHomeConversation` already declared these "never opened by a
		// human in the Tedix OS sidebar", but only auto-titling honoured that; without
		// it marker-per-run CI smoke threads crowd the list. Honour the existing
		// declaration on the list read too.
		hiddenPrefixes: EPHEMERAL_HOME_CONVERSATION_PREFIXES,
	});
}
