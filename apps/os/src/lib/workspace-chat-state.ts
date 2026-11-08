/**
 * Pure fold of workspace-object events into the chat view model.
 *
 * One reducer serves the ledger replay, the live stream and the "load earlier"
 * page: every event carries a `seq`, folding is idempotent (a seq already seen
 * is ignored) and order-independent within a turn, so a socket drop followed
 * by a replay from the cursor converges on the same state.
 */

import type {
	ApprovalDecision,
	ConversationSummary,
	StepKind,
	TurnStatus,
	TurnUsage,
	WorkspaceChatLedgerEvent,
} from "./workspace-chat-protocol";

export type ChatStep = {
	stepId: string;
	label: string;
	kind: StepKind;
	tool?: string;
	input?: unknown;
	startedAt: string;
	finishedAt: string | null;
	status: "running" | "ok" | "error";
	summary?: string;
	durationMs?: number;
	error?: string;
};

export type ChatApproval = {
	approvalId: string;
	stepId: string;
	title: string;
	reason: string;
	policy?: string;
	input?: unknown;
	requestedAt: string;
	decision: ApprovalDecision | null;
	decidedBy?: string;
	decidedAt?: string;
	execution?: { status: "applied" | "failed"; error?: string };
};

export type ChatTurn = {
	turnId: string;
	conversationId: string;
	/** Set while the turn is only known locally (sent, not yet accepted). */
	clientTurnId?: string;
	startedAt: string;
	authorId: string;
	authorKind: "person" | "tedi";
	text: string;
	/** Assistant prose so far; grows with every delta and settles on done. */
	reply: string;
	replyDeltas?: Array<{ seq: number; text: string }>;
	replyMessageId: string | null;
	replyDone: boolean;
	steps: ChatStep[];
	approvals: ChatApproval[];
	status: "running" | TurnStatus;
	error?: string;
	finishedAt: string | null;
	durationMs?: number;
	usage?: TurnUsage;
	model?: string;
	/**
	 * Stable key for the assistant row from first token to settled message, so
	 * React never remounts it (the reference runtime's `answerKey`).
	 */
	replyKey: string;
};

export type WorkspaceChatState = {
	/** Highest seq folded; the resubscribe cursor. */
	cursor: number | null;
	/** Wall-clock time of the newest event, live or replayed. Drives the timer. */
	lastEventAt: number | null;
	conversationId: string | null;
	turns: ChatTurn[];
	conversations: ConversationSummary[];
	/** Older events exist before the first turn shown. */
	hasEarlier: boolean;
	/** A turn sent from this tab, not yet echoed by the object. */
	pendingSend: { clientTurnId: string; text: string; sentAt: number } | null;
	lastError: { code: string; message: string } | null;
	/** Seqs already folded; shared between successive states, grows only. */
	seen: Set<number>;
	approvalDecisions: Record<
		string,
		{ decision: ApprovalDecision; decidedBy: string; decidedAt: string }
	>;
	approvalExecutions: Record<string, NonNullable<ChatApproval["execution"]>>;
};

export function initialWorkspaceChatState(
	conversationId: string | null,
): WorkspaceChatState {
	return {
		cursor: null,
		lastEventAt: null,
		conversationId,
		turns: [],
		conversations: [],
		hasEarlier: false,
		pendingSend: null,
		lastError: null,
		seen: new Set(),
		approvalDecisions: {},
		approvalExecutions: {},
	};
}

function newTurn(
	event: Extract<WorkspaceChatLedgerEvent, { type: "turn.started" }>,
): ChatTurn {
	return {
		turnId: event.turnId,
		conversationId: event.conversationId,
		startedAt: event.at,
		authorId: event.authorId,
		authorKind: event.authorKind,
		text: event.displayText ?? event.text,
		reply: "",
		replyMessageId: null,
		replyDone: false,
		steps: [],
		approvals: [],
		status: "running",
		finishedAt: null,
		replyKey: `reply-${event.turnId}`,
	};
}

/** A turn referenced before its `turn.started` (out-of-order page edge). */
function placeholderTurn(
	turnId: string,
	conversationId: string,
	at: string,
): ChatTurn {
	return {
		turnId,
		conversationId,
		startedAt: at,
		authorId: "",
		authorKind: "person",
		text: "",
		reply: "",
		replyMessageId: null,
		replyDone: false,
		steps: [],
		approvals: [],
		status: "running",
		finishedAt: null,
		replyKey: `reply-${turnId}`,
	};
}

function upsertTurn(
	turns: ChatTurn[],
	turnId: string,
	make: () => ChatTurn,
	patch: (turn: ChatTurn) => ChatTurn,
): ChatTurn[] {
	const index = turns.findIndex((turn) => turn.turnId === turnId);
	if (index === -1) {
		const next = [...turns, patch(make())];
		next.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
		return next;
	}
	const next = turns.slice();
	next[index] = patch(turns[index]!);
	next.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
	return next;
}

/** Fold one ledger event. Returns the same state object when nothing changed. */
export function applyWorkspaceChatEvent(
	state: WorkspaceChatState,
	event: WorkspaceChatLedgerEvent,
): WorkspaceChatState {
	if (state.seen.has(event.seq)) return state;
	if (event.type === "conversation.updated") {
		if (event.conversationId === state.conversationId)
			state.seen.add(event.seq);
		const previous = state.conversations.find(
			(conversation) => conversation.id === event.conversationId,
		);
		if (previous && previous.updatedAt > event.at)
			return withCursor(state, event);
		const conversation = {
			id: event.conversationId,
			title:
				event.title === undefined ? (previous?.title ?? null) : event.title,
			updatedAt: event.at,
			lastTurnAt: previous?.lastTurnAt ?? null,
		};
		return {
			...state,
			cursor: Math.max(state.cursor ?? -1, event.seq),
			conversations: [
				...state.conversations.filter(
					(item) => item.id !== event.conversationId,
				),
				conversation,
			].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
		};
	}
	if (event.conversationId !== state.conversationId)
		return withCursor(state, event);

	const at = event.at;
	let turns = state.turns;
	let pendingSend = state.pendingSend;
	let approvalDecisions = state.approvalDecisions;
	let approvalExecutions = state.approvalExecutions;
	const place = (turnId: string) => (patch: (turn: ChatTurn) => ChatTurn) =>
		upsertTurn(
			turns,
			turnId,
			() => placeholderTurn(turnId, event.conversationId, at),
			patch,
		);

	switch (event.type) {
		case "turn.started": {
			turns = upsertTurn(
				turns,
				event.turnId,
				() => newTurn(event),
				(turn) => ({
					...turn,
					startedAt: event.at,
					text: event.displayText ?? event.text,
					authorId: event.authorId,
					authorKind: event.authorKind,
				}),
			);
			if (pendingSend && pendingSend.text === event.text) pendingSend = null;
			break;
		}
		case "assistant.delta":
			turns = place(event.turnId)((turn) => {
				if (
					turn.replyDone &&
					turn.replyDeltas === undefined &&
					turn.replyMessageId === event.messageId
				)
					return turn;
				const replyDeltas = [
					...(turn.replyDeltas ?? []),
					{ seq: event.seq, text: event.text },
				].sort((a, b) => a.seq - b.seq);
				return {
					...turn,
					replyDeltas,
					reply: replyDeltas.map((delta) => delta.text).join(""),
					replyMessageId: event.messageId,
				};
			});
			break;
		case "assistant.done":
			turns = place(event.turnId)((turn) => ({
				...turn,
				reply: event.text,
				replyMessageId: event.messageId,
				replyDone: true,
				replyDeltas: undefined,
				usage: event.usage ?? turn.usage,
				model: event.model ?? turn.model,
			}));
			break;
		case "step.started":
			turns = place(event.turnId)((turn) =>
				turn.steps.some((step) => step.stepId === event.stepId)
					? {
							...turn,
							steps: turn.steps.map((step) =>
								step.stepId === event.stepId
									? {
											...step,
											label: event.label,
											kind: event.kind,
											tool: event.tool,
											input: event.input,
											startedAt: event.at,
										}
									: step,
							),
						}
					: {
							...turn,
							steps: [
								...turn.steps,
								{
									stepId: event.stepId,
									label: event.label,
									kind: event.kind,
									tool: event.tool,
									input: event.input,
									startedAt: event.at,
									finishedAt: null,
									status: "running",
								},
							],
						},
			);
			break;
		case "step.finished":
			turns = place(event.turnId)((turn) => {
				const exists = turn.steps.some((step) => step.stepId === event.stepId);
				const steps = exists
					? turn.steps.map((step) =>
							step.stepId === event.stepId
								? {
										...step,
										finishedAt: event.at,
										status: event.status,
										summary: event.summary,
										durationMs: event.durationMs,
										error: event.error,
									}
								: step,
						)
					: [
							...turn.steps,
							{
								stepId: event.stepId,
								label: event.summary ?? "Step",
								kind: "tool" as const,
								startedAt: event.at,
								finishedAt: event.at,
								status: event.status,
								summary: event.summary,
								durationMs: event.durationMs,
								error: event.error,
							},
						];
				return { ...turn, steps };
			});
			break;
		case "approval.requested":
			turns = place(event.turnId)((turn) =>
				turn.approvals.some(
					(approval) => approval.approvalId === event.approvalId,
				)
					? turn
					: {
							...turn,
							approvals: [
								...turn.approvals,
								{
									approvalId: event.approvalId,
									stepId: event.stepId,
									title: event.title,
									reason: event.reason,
									policy: event.policy,
									input: event.input,
									requestedAt: event.at,
									decision: null,
									...approvalDecisions[event.approvalId],
									execution: approvalExecutions[event.approvalId],
								},
							],
						},
			);
			break;
		case "approval.decided":
			approvalDecisions = {
				...approvalDecisions,
				[event.approvalId]: {
					decision: event.decision,
					decidedBy: event.by,
					decidedAt: event.at,
				},
			};
			turns = turns.map((turn) => ({
				...turn,
				approvals: turn.approvals.map((approval) =>
					approval.approvalId === event.approvalId
						? {
								...approval,
								decision: event.decision,
								decidedBy: event.by,
								decidedAt: event.at,
							}
						: approval,
				),
			}));
			break;
		case "approval.executed": {
			const execution = { status: event.status, error: event.error };
			approvalExecutions = {
				...approvalExecutions,
				[event.approvalId]: execution,
			};
			turns = turns.map((turn) => ({
				...turn,
				approvals: turn.approvals.map((approval) =>
					approval.approvalId === event.approvalId
						? { ...approval, execution }
						: approval,
				),
			}));
			break;
		}
		case "turn.finished":
			turns = place(event.turnId)((turn) => ({
				...turn,
				status: event.status,
				error: event.error,
				finishedAt: event.at,
				durationMs: event.durationMs,
				replyDone: true,
				steps: turn.steps.map((step) =>
					step.status === "running"
						? {
								...step,
								status: event.status === "done" ? "ok" : "error",
								finishedAt: event.at,
							}
						: step,
				),
			}));
			break;
	}

	state.seen.add(event.seq);
	return {
		...state,
		cursor: Math.max(state.cursor ?? -1, event.seq),
		lastEventAt: Math.max(state.lastEventAt ?? 0, Date.parse(event.at) || 0),
		turns,
		pendingSend,
		approvalDecisions,
		approvalExecutions,
	};
}

function withCursor(
	state: WorkspaceChatState,
	event: WorkspaceChatLedgerEvent,
): WorkspaceChatState {
	if (state.cursor !== null && event.seq <= state.cursor) return state;
	return { ...state, cursor: event.seq };
}

export function applyWorkspaceChatEvents(
	state: WorkspaceChatState,
	events: readonly WorkspaceChatLedgerEvent[],
): WorkspaceChatState {
	let next = state;
	for (const event of events) next = applyWorkspaceChatEvent(next, event);
	return next;
}

export function markPendingSend(
	state: WorkspaceChatState,
	send: { clientTurnId: string; text: string; sentAt: number },
): WorkspaceChatState {
	return { ...state, pendingSend: send, lastError: null };
}

export function markSendFailed(
	state: WorkspaceChatState,
	error: { code: string; message: string },
): WorkspaceChatState {
	return { ...state, pendingSend: null, lastError: error };
}

export function setConversations(
	state: WorkspaceChatState,
	conversations: ConversationSummary[],
): WorkspaceChatState {
	return { ...state, conversations };
}

export function setHasEarlier(
	state: WorkspaceChatState,
	hasEarlier: boolean,
): WorkspaceChatState {
	if (state.hasEarlier === hasEarlier) return state;
	return { ...state, hasEarlier };
}

/** The newest turn still running, if any. */
export function activeTurn(state: WorkspaceChatState): ChatTurn | null {
	for (let index = state.turns.length - 1; index >= 0; index -= 1) {
		const turn = state.turns[index]!;
		if (turn.status === "running") return turn;
	}
	return null;
}

/** The approval the object is waiting on, if any. */
export function pendingApproval(turn: ChatTurn | null): ChatApproval | null {
	if (!turn) return null;
	return turn.approvals.find((approval) => approval.decision === null) ?? null;
}

export function elapsedLabel(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	return `${minutes}m ${rest.toString().padStart(2, "0")}s`;
}

export function formatUsage(usage: TurnUsage): string {
	const parts = [
		`${(usage.inputTokens + usage.outputTokens).toLocaleString()} tokens`,
	];
	if (usage.costCents !== undefined)
		parts.push(
			`€${(usage.costCents / 100).toFixed(usage.costCents < 100 ? 3 : 2)}`,
		);
	return parts.join(" · ");
}
