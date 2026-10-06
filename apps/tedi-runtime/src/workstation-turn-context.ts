import { traceBundleId } from "@tedix/context-core/harness-version";

export interface WorkstationTurnIdentity {
	conversationId: string;
	homeRunId?: string;
	runId: string;
	sessionKey?: string;
	traceId?: string;
	workItemId?: string;
}

export type WorkstationTurnContext = Partial<WorkstationTurnIdentity>;

/** Only the captured runtime turn may bind a native process to a conversation. */
export function workstationProcessConversationProvenance(
	request: { kernelRunId?: string },
	identity: WorkstationTurnIdentity | null,
): { conversationId: string; runId: string } | null {
	if (
		!identity?.conversationId?.trim() ||
		!identity.runId?.trim() ||
		request.kernelRunId !== identity.runId
	) {
		return null;
	}
	return {
		conversationId: identity.conversationId,
		runId: identity.runId,
	};
}

/** Capture the dispatch's wake destination before ambient turn state changes. */
export function captureWorkstationTurnContext(
	input: WorkstationTurnIdentity & { sessionKey: string },
): WorkstationTurnIdentity & { sessionKey: string } {
	return {
		conversationId: input.conversationId,
		runId: input.runId,
		sessionKey: input.sessionKey,
		workItemId: input.workItemId,
		homeRunId: input.homeRunId,
		traceId: input.traceId ?? input.runId,
	};
}

type WorkstationCorrelationInput = {
	[key: string]: unknown;
	kernelRunId?: string;
	traceBundleId?: string;
	traceId?: string;
	workItemId?: string;
};

function hasIdentity(value: string | undefined): boolean {
	return Boolean(value?.trim());
}

/**
 * Prefer the explicit tool-dispatch identity over mutable DO-global turn state.
 * Matching active state may contribute fields the dispatcher omitted; state
 * from another run must never bleed into the workstation request or evidence.
 */
export function resolveWorkstationTurnIdentity(
	active: WorkstationTurnIdentity | null,
	explicit?: WorkstationTurnContext,
): WorkstationTurnIdentity | null {
	const runId = explicit?.runId;
	const conversationId = explicit?.conversationId;
	if (!runId || !conversationId) return active;
	if (active?.runId === runId && active.conversationId === conversationId) {
		return { ...active, ...explicit, conversationId, runId };
	}
	return { ...explicit, conversationId, runId };
}

/**
 * Add ambient turn correlation only when the caller supplied no authoritative
 * execution scope. An explicit Kernel run or Work Item identifies a direct
 * call and must never be combined with mutable state left by another turn.
 */
export function withWorkstationTurnContext<
	T extends WorkstationCorrelationInput,
>(input: T, active: WorkstationTurnIdentity | null): T {
	if (
		hasIdentity(input.kernelRunId) ||
		hasIdentity(input.workItemId) ||
		(!active?.runId && !active?.traceId)
	) {
		return input;
	}
	return {
		...input,
		kernelRunId: active.runId,
		traceId: input.traceId ?? active.traceId ?? active.runId,
		workItemId: active.workItemId,
		traceBundleId:
			input.traceBundleId ??
			(active.homeRunId
				? traceBundleId(active.homeRunId)
				: active.runId
					? traceBundleId(active.runId)
					: undefined),
	};
}
