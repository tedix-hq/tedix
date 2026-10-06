/** Durable chat dispatch uses the canonical runtime ledger for task acknowledgement. */
import { buildTediTurnRuntimeEvent } from "@tedix/api-contract/utils/runtime-events";
import { isEphemeralSessionKey } from "@tedix/api-contract/utils/runtime-identity";
import { runEventsToTaskState } from "@tedix/mcp-shared/tasks";
import type { TediRuntimeEvent } from "@tedix/api-contract/schemas/cognitive-runtime";

/** Persist the existing queued lifecycle event before exposing a pollable task.
 * The same run:1 identity is used by settlement, so redelivery cannot add a
 * second lifecycle event or replace an existing terminal outcome.
 */
export async function recordQueuedChatTurn(
	platform: {
		recordRuntimeEvent(event: TediRuntimeEvent): Promise<unknown>;
	} | null,
	input: {
		tediId: string;
		runId: string;
		conversationId: string;
		userTs: number;
		sessionKey: string;
		traceId?: string;
	},
): Promise<void> {
	if (isEphemeralSessionKey(input.sessionKey)) return;
	try {
		if (!platform) throw new Error("runtime ledger unavailable");
		await platform.recordRuntimeEvent(
			buildTediTurnRuntimeEvent({
				tediId: input.tediId,
				runId: input.runId,
				conversationId: input.conversationId,
				kind: "run.started",
				idSuffix: 1,
				sequence: 1,
				payload: { status: "queued" },
				runtimeBackend: "cloudflare-agents",
				traceId: input.traceId,
				createdAt: new Date(input.userTs).toISOString(),
			}),
		);
	} catch (cause) {
		throw new Error(
			`Tedi run ${input.runId} was dispatched but acknowledgement is unknown. Read its status or retry with the same client_request_id.`,
			{ cause },
		);
	}
}

export class ChatTurnReceiptError extends Error {
	constructor(
		message: string,
		readonly outcome: "unknown" | "failed" | "cancelled" = "unknown",
	) {
		super(message);
	}
}

/** Replaying a cached assistant never dispatches again: it may precede the
 * terminal ledger write, or be a failure notice rather than a successful reply.
 */
export async function settledChatTurnReceipt(
	platform: {
		listRuntimeEvents(input: {
			runId: string;
			limit: number;
		}): Promise<{ events: TediRuntimeEvent[] }>;
	} | null,
	input: {
		runId: string;
		sessionKey: string;
		assistant: {
			content: string;
			ts: number;
			modelIdentity?: { provider: string; model: string };
		};
	},
) {
	const receipt = {
		ok: true as const,
		run_id: input.runId,
		session_key: input.sessionKey,
	};
	if (!isEphemeralSessionKey(input.sessionKey)) {
		if (!platform)
			throw new ChatTurnReceiptError(
				`Cannot read tedi run ${input.runId}: runtime ledger unavailable`,
			);
		const { events } = await platform.listRuntimeEvents({
			runId: input.runId,
			limit: 500,
		});
		if (!events.length)
			throw new ChatTurnReceiptError(
				`Tedi run ${input.runId} has a cached reply but its canonical outcome is unknown. Read its status or retry with the same client_request_id.`,
			);
		const state = runEventsToTaskState(input.runId, events);
		if (state.status === "failed" || state.status === "cancelled")
			throw new ChatTurnReceiptError(
				`Tedi run ${input.runId} ${state.status}: ${state.error?.message ?? "read the run ledger for details"}`,
				state.status,
			);
		if (state.status !== "completed")
			return { ...receipt, assistant: null, pending: true as const };
	}
	return {
		...receipt,
		assistant: {
			role: "assistant" as const,
			content: input.assistant.content,
			ts: input.assistant.ts,
		},
		...(input.assistant.modelIdentity
			? { model_identity: input.assistant.modelIdentity }
			: {}),
	};
}

/** Keep stable recovery identity even when publication or replay fails. */
export function chatTurnErrorResponse(
	error: unknown,
	input: { runId: string; sessionKey: string; clientRequestId: string },
): Response {
	return Response.json(
		{
			ok: false,
			success: false,
			error: error instanceof Error ? error.message : String(error),
			run_id: input.runId,
			session_key: input.sessionKey,
			client_request_id: input.clientRequestId,
			outcome:
				error instanceof ChatTurnReceiptError ? error.outcome : "unknown",
		},
		{ status: 500 },
	);
}

/** Only a duplicate instance is an idempotent dispatch success. */
export function isDuplicateWorkflowInstanceError(error: unknown): boolean {
	const message =
		error instanceof Error
			? error.message
			: typeof error === "string"
				? error
				: "";
	return /already[_ ]exists|already being tracked|already exists/i.test(
		message,
	);
}

// ── Dangling-turn detection ───────────────────────────────────────────────────

/**
 * A session's last cached turn is a USER turn older than this lease ⇒ emit a
 * "dangling_turn" diagnostic. This is transcript-tail telemetry, not proof
 * that the canonical D1 run ledger lacks a terminal: cache/windowing and a
 * later terminal write can produce the same shape. Correlate it with the
 * organization-scoped orphan-run health predicate before making settlement
 * or watchdog decisions.
 */
export const DANGLING_TURN_LEASE_MS = 15 * 60_000;

export interface DanglingTurnCandidate {
	role: "user" | "assistant";
	ts: number;
}

/**
 * Pure detector: returns the age (ms) of a trailing cached user turn, or null
 * for an empty/assistant-tailed/recent cache. A null/non-null result is not a
 * canonical run-health verdict.
 */
export function findDanglingUserTurnAgeMs(
	turns: ReadonlyArray<DanglingTurnCandidate>,
	nowMs: number,
	leaseMs: number = DANGLING_TURN_LEASE_MS,
): number | null {
	const last = turns.length > 0 ? turns[turns.length - 1] : undefined;
	if (last?.role !== "user") return null;
	const age = nowMs - last.ts;
	return age >= leaseMs ? age : null;
}
