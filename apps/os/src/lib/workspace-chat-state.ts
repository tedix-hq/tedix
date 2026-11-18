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
	UsageTotals,
	WaitingApprovalSummary,
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
	/** The start of what the step returned, as text. */
	result?: string;
};

export type ChatApproval = {
	approvalId: string;
	stepId: string;
	title: string;
	reason: string;
	policy?: string;
	input?: unknown;
	requestedAt: string;
	target?: { id: string; title: string };
	decision: ApprovalDecision | null;
	decidedBy?: string;
	decidedAt?: string;
	/** The change applied at once; it never waited for a person. */
	automatic?: boolean;
	execution?: {
		status: "applied" | "failed";
		error?: string;
		/** The file the write saved; revision 1 means it created the file. */
		output?: { outputId: string; revision: number };
		/** The app the write created. */
		app?: { appId: string; name: string };
	};
};

export type ChatView = {
	viewId: string;
	appSlug: string;
	resourceUri: string;
	title: string;
	toolResult: Record<string, unknown>;
};

/** A message sent while a turn was working. */
export type ChatQueuedMessage = {
	messageId: string;
	/** The working turn it was sent to, then the turn that read it. */
	turnId: string;
	text: string;
	at: string;
	authorId: string;
	authorKind: "person" | "tedi";
	attachments?: ChatTurn["attachments"];
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
	attachments?: Array<{
		outputId: string;
		title: string;
		revision: number;
		revisionId: string;
	}>;
	/** Assistant prose so far; grows with every delta and settles on done. */
	reply: string;
	replyDeltas?: Array<{ seq: number; text: string }>;
	replyMessageId: string | null;
	replyDone: boolean;
	steps: ChatStep[];
	approvals: ChatApproval[];
	/** Messages sent while this turn worked that the agent read, oldest first. */
	added?: ChatQueuedMessage[];
	/** Live views the agent put in its answer, in the order shown. */
	views?: ChatView[];
	/** Before this turn, earlier messages were summarised to fit the model. */
	summarizedEarlier?: boolean;
	status: "running" | TurnStatus;
	approvalUrl?: string;
	error?: string;
	finishedAt: string | null;
	durationMs?: number;
	usage?: TurnUsage;
	usageSeq?: number;
	model?: string;
	modelSeq?: number;
	/**
	 * Stable key for the assistant row from first token to settled message, so
	 * React never remounts it (the reference runtime's `answerKey`).
	 */
	replyKey: string;
};

/** A request waiting for a person, with the conversation that asked. */
export type WaitingApproval = ChatApproval & { conversationId: string };

/** Several requests being decided one after another, in this order. */
export type ApprovalRun = {
	runId: string;
	decision: ApprovalDecision;
	requests: WaitingApproval[];
};

/** What the person is owed after a decision did not go as asked. */
export type ApprovalNotice =
	| {
			/** A run stopped part-way; the requests after `request` still wait. */
			kind: "stopped";
			decision: ApprovalDecision;
			total: number;
			/** How many this run decided itself before it stopped. */
			done: number;
			request: WaitingApproval | null;
			reason: "failed" | "decided_otherwise";
			error?: string;
	  }
	| {
			/** Someone else had already decided it, the same way. */
			kind: "already_decided";
			request: WaitingApproval | null;
	  }
	| {
			/** The connection dropped before the answer came back. */
			kind: "disconnected";
			decision: ApprovalDecision;
	  };

export type WorkspaceChatState = {
	/** Highest seq folded; the resubscribe cursor. */
	cursor: number | null;
	/** Wall-clock time of the newest event, live or replayed. Drives the timer. */
	lastEventAt: number | null;
	conversationId: string | null;
	turns: ChatTurn[];
	/**
	 * Every request in the workspace still waiting for a person, oldest
	 * first, whichever conversation asked.
	 */
	waiting: WaitingApproval[];
	/** Several requests this tab is deciding one after another. */
	approvalRun: ApprovalRun | null;
	approvalNotice: ApprovalNotice | null;
	conversations: ConversationSummary[];
	models: Array<{ id: string; label: string }>;
	/** Older events exist before the first turn shown. */
	hasEarlier: boolean;
	/** Messages sent to a working turn that the agent has not read yet. */
	queued: ChatQueuedMessage[];
	/**
	 * Messages Stop handed back unread. The tab that sent one, or pressed
	 * Stop, puts its text back into the composer.
	 */
	returned: ChatQueuedMessage[];
	/** A turn sent from this tab, not yet echoed by the object. */
	pendingSend: { clientTurnId: string; text: string; sentAt: number } | null;
	lastError: { code: string; message: string; clientTurnId?: string } | null;
	/** Seqs already folded; shared between successive states, grows only. */
	seen: Set<number>;
	approvalDecisions: Record<
		string,
		{
			decision: ApprovalDecision;
			decidedBy: string;
			decidedAt: string;
			automatic?: boolean;
		}
	>;
	approvalExecutions: Record<string, NonNullable<ChatApproval["execution"]>>;
	/** The whole workspace's usage; `null` until a reply reports any. */
	usage: UsageTotals | null;
	/**
	 * The seq the usage totals already include. Only a later reply adds to
	 * them, so replay and history pages never count a reply twice.
	 */
	usageCursor: number | null;
};

export function initialWorkspaceChatState(
	conversationId: string | null,
): WorkspaceChatState {
	return {
		cursor: null,
		lastEventAt: null,
		conversationId,
		turns: [],
		waiting: [],
		approvalRun: null,
		approvalNotice: null,
		conversations: [],
		models: [],
		hasEarlier: false,
		queued: [],
		returned: [],
		pendingSend: null,
		lastError: null,
		seen: new Set(),
		approvalDecisions: {},
		approvalExecutions: {},
		usage: null,
		usageCursor: null,
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
		attachments: event.attachments,
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
	if (
		event.type === "assistant.done" &&
		event.usage &&
		state.usageCursor !== null &&
		event.seq > state.usageCursor
	)
		state = addReplyToUsage(
			state,
			event.conversationId,
			event.usage,
			event.seq,
		);
	if (event.type === "turn.started") {
		const previous = state.conversations.find(
			(row) => row.id === event.conversationId,
		);
		const conversation: ConversationSummary = {
			id: event.conversationId,
			title:
				previous?.title ??
				(event.displayText ?? event.text).replace(/\s+/g, " ").slice(0, 80),
			updatedAt:
				previous && previous.updatedAt > event.at
					? previous.updatedAt
					: event.at,
			lastTurnAt:
				previous?.lastTurnAt && previous.lastTurnAt > event.at
					? previous.lastTurnAt
					: event.at,
			// An older history page must not revive a turn that already finished.
			running:
				previous?.running === true ||
				state.cursor === null ||
				event.seq > state.cursor,
			...(previous?.pendingApprovals
				? { pendingApprovals: previous.pendingApprovals }
				: {}),
			...(previous?.archivedAt ? { archivedAt: previous.archivedAt } : {}),
			...(previous?.usage ? { usage: previous.usage } : {}),
		};
		state = {
			...state,
			conversations: [
				...state.conversations.filter((row) => row.id !== conversation.id),
				conversation,
			].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
		};
	}
	if (event.type === "conversation.updated") {
		if (event.conversationId === state.conversationId)
			state.seen.add(event.seq);
		const previous = state.conversations.find(
			(conversation) => conversation.id === event.conversationId,
		);
		if (previous && previous.updatedAt > event.at)
			return withCursor(state, event);
		const archivedAt =
			event.archivedAt === undefined ? previous?.archivedAt : event.archivedAt;
		const conversation: ConversationSummary = {
			id: event.conversationId,
			title:
				event.title === undefined ? (previous?.title ?? null) : event.title,
			updatedAt: event.at,
			lastTurnAt: previous?.lastTurnAt ?? null,
			...(previous?.running ? { running: true } : {}),
			...(previous?.pendingApprovals
				? { pendingApprovals: previous.pendingApprovals }
				: {}),
			...(archivedAt ? { archivedAt } : {}),
			...(previous?.usage ? { usage: previous.usage } : {}),
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
	if (event.type === "turn.finished") {
		const finished = state.conversations.find(
			(row) => row.id === event.conversationId && row.running,
		);
		if (finished)
			state = {
				...state,
				conversations: state.conversations.map((row) =>
					row === finished ? { ...row, running: false } : row,
				),
			};
	}
	// The object's hello counted the waiting changes up to `usageCursor`;
	// only a later event moves a count, so a replay never counts one twice.
	if (
		(event.type === "approval.requested" ||
			event.type === "approval.decided") &&
		// A change that applies at once was never waiting.
		!event.automatic &&
		state.usageCursor !== null &&
		event.seq > state.usageCursor
	) {
		const change = event.type === "approval.requested" ? 1 : -1;
		state = {
			...state,
			conversations: state.conversations.map((row) =>
				row.id === event.conversationId
					? {
							...row,
							pendingApprovals: Math.max(
								0,
								(row.pendingApprovals ?? 0) + change,
							),
						}
					: row,
			),
		};
	}
	state = foldWaiting(state, event);
	if (event.conversationId !== state.conversationId)
		return withCursor(state, event);

	const at = event.at;
	let turns = state.turns;
	let pendingSend = state.pendingSend;
	let queued = state.queued;
	let returned = state.returned;
	const settled = (messageId: string) =>
		returned.some((message) => message.messageId === messageId) ||
		turns.some(
			(turn) =>
				turn.turnId === messageId ||
				turn.added?.some((message) => message.messageId === messageId),
		);
	const unqueue = (messageId: string) => {
		if (queued.some((message) => message.messageId === messageId))
			queued = queued.filter((message) => message.messageId !== messageId);
		if (pendingSend?.clientTurnId === messageId) pendingSend = null;
	};
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
					attachments: event.attachments,
					authorId: event.authorId,
					authorKind: event.authorKind,
				}),
			);
			if (pendingSend && pendingSend.text === event.text) pendingSend = null;
			// A message the working turn never read starts this turn instead.
			unqueue(event.turnId);
			break;
		}
		case "message.queued":
			if (pendingSend?.clientTurnId === event.messageId) pendingSend = null;
			// An older history page must not bring back a message already settled.
			if (
				!settled(event.messageId) &&
				!queued.some((message) => message.messageId === event.messageId)
			)
				queued = [...queued, queuedMessage(event)].sort((a, b) =>
					a.at.localeCompare(b.at),
				);
			break;
		case "message.read":
			unqueue(event.messageId);
			turns = place(event.turnId)((turn) =>
				turn.added?.some((message) => message.messageId === event.messageId)
					? turn
					: {
							...turn,
							added: [...(turn.added ?? []), queuedMessage(event)].sort(
								(a, b) => a.at.localeCompare(b.at),
							),
						},
			);
			break;
		case "message.returned":
			unqueue(event.messageId);
			if (!returned.some((message) => message.messageId === event.messageId))
				returned = [...returned, queuedMessage(event)];
			break;
		// A completed reply is authoritative even if a facet progress RPC arrives late.
		case "turn.usage":
			turns = place(event.turnId)((turn) =>
				!turn.replyDone && event.seq > (turn.usageSeq ?? -1)
					? { ...turn, usage: event.usage, usageSeq: event.seq }
					: turn,
			);
			break;
		case "turn.model":
			turns = place(event.turnId)((turn) =>
				!turn.replyDone && event.seq > (turn.modelSeq ?? -1)
					? { ...turn, model: event.model, modelSeq: event.seq }
					: turn,
			);
			break;
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
				...(event.usage ? { usage: event.usage, usageSeq: event.seq } : {}),
				...(event.model ? { model: event.model, modelSeq: event.seq } : {}),
			}));
			break;
		case "view.shown":
			turns = place(event.turnId)((turn) =>
				turn.views?.some((view) => view.viewId === event.viewId)
					? turn
					: {
							...turn,
							views: [
								...(turn.views ?? []),
								{
									viewId: event.viewId,
									appSlug: event.appSlug,
									resourceUri: event.resourceUri,
									title: event.title,
									toolResult: event.toolResult,
								},
							],
						},
			);
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
										result: event.result,
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
								result: event.result,
							},
						];
				return { ...turn, steps };
			});
			break;
		case "conversation.summarized":
			turns = place(event.turnId)((turn) => ({
				...turn,
				summarizedEarlier: true,
			}));
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
									target: event.target,
									// A change that applies at once never waits for a person,
									// even before its decision arrives.
									...(event.automatic
										? { decision: "approve" as const, automatic: true }
										: { decision: null }),
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
					...(event.automatic ? { automatic: true } : {}),
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
								...(event.automatic ? { automatic: true } : {}),
							}
						: approval,
				),
			}));
			break;
		case "approval.executed": {
			const execution = {
				status: event.status,
				error: event.error,
				...(event.output ? { output: event.output } : {}),
				...(event.app ? { app: event.app } : {}),
			};
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
				approvalUrl: event.approvalUrl,
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
		queued,
		returned,
		pendingSend,
		approvalDecisions,
		approvalExecutions,
	};
}

function queuedMessage(
	event: Extract<
		WorkspaceChatLedgerEvent,
		{ type: "message.queued" | "message.read" | "message.returned" }
	>,
): ChatQueuedMessage {
	return {
		messageId: event.messageId,
		turnId: event.turnId,
		text: event.displayText ?? event.text,
		at: event.at,
		authorId: event.authorId,
		authorKind: event.authorKind,
		...(event.attachments?.length ? { attachments: event.attachments } : {}),
	};
}

/** The object has a message sent from this tab: as a turn, queued, read or handed back. */
export function messageAccepted(
	state: Pick<WorkspaceChatState, "turns" | "queued" | "returned">,
	messageId: string,
): boolean {
	return (
		state.queued.some((message) => message.messageId === messageId) ||
		state.returned.some((message) => message.messageId === messageId) ||
		state.turns.some(
			(turn) =>
				turn.turnId === messageId ||
				turn.added?.some((message) => message.messageId === messageId) === true,
		)
	);
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
	error: { code: string; message: string; clientTurnId?: string },
): WorkspaceChatState {
	return { ...state, pendingSend: null, lastError: error };
}

/**
 * Keeps the workspace's waiting requests current. The object's hello lists
 * them up to `usageCursor`; only a later event adds one, so a replay or an
 * older history page never brings back a request that was already decided.
 */
function foldWaiting(
	state: WorkspaceChatState,
	event: WorkspaceChatLedgerEvent,
): WorkspaceChatState {
	if (event.type === "approval.decided") {
		return state.waiting.some((item) => item.approvalId === event.approvalId)
			? {
					...state,
					waiting: state.waiting.filter(
						(item) => item.approvalId !== event.approvalId,
					),
				}
			: state;
	}
	if (
		event.type !== "approval.requested" ||
		// A change that applies at once was never waiting.
		event.automatic ||
		(state.usageCursor !== null && event.seq <= state.usageCursor) ||
		state.approvalDecisions[event.approvalId] ||
		state.waiting.some((item) => item.approvalId === event.approvalId)
	)
		return state;
	return {
		...state,
		waiting: [
			...state.waiting,
			waitingApproval({
				approvalId: event.approvalId,
				conversationId: event.conversationId,
				turnId: event.turnId,
				stepId: event.stepId,
				title: event.title,
				reason: event.reason,
				policy: event.policy,
				input: event.input,
				target: event.target,
				at: event.at,
			}),
		],
	};
}

function waitingApproval(summary: WaitingApprovalSummary): WaitingApproval {
	return {
		approvalId: summary.approvalId,
		conversationId: summary.conversationId,
		stepId: summary.stepId,
		title: summary.title,
		reason: summary.reason,
		policy: summary.policy,
		input: summary.input,
		requestedAt: summary.at,
		target: summary.target,
		decision: null,
	};
}

/** The object's hello: everything waiting in the workspace right now. */
export function setWaitingApprovals(
	state: WorkspaceChatState,
	waiting: readonly WaitingApprovalSummary[],
): WorkspaceChatState {
	return { ...state, waiting: waiting.map(waitingApproval) };
}

export function setConversations(
	state: WorkspaceChatState,
	conversations: ConversationSummary[],
): WorkspaceChatState {
	return { ...state, conversations };
}

/**
 * A conversation was deleted. A chat that had it open keeps nothing of it and
 * says so; `conversation_deleted` tells the pane to go back to the list.
 */
export function removeConversation(
	state: WorkspaceChatState,
	conversationId: string,
): WorkspaceChatState {
	const conversations = state.conversations.filter(
		(row) => row.id !== conversationId,
	);
	// Its requests went with it.
	const waiting = state.waiting.filter(
		(item) => item.conversationId !== conversationId,
	);
	if (state.conversationId !== conversationId)
		return { ...state, conversations, waiting };
	return {
		...state,
		conversations,
		waiting,
		turns: [],
		hasEarlier: false,
		pendingSend: null,
		lastError: {
			code: "conversation_deleted",
			message: "This conversation was deleted.",
		},
	};
}

/** Totals from the object's hello: everything up to and including `cursor`. */
export function setWorkspaceUsage(
	state: WorkspaceChatState,
	usage: UsageTotals | undefined,
	cursor: number,
): WorkspaceChatState {
	return { ...state, usage: usage ?? null, usageCursor: cursor };
}

/** Adds one finished reply to a running total; old zero receipts add nothing. */
export function addUsage(
	totals: UsageTotals | undefined | null,
	usage: TurnUsage,
): UsageTotals | null {
	const cost =
		usage.costUsd !== undefined && Number.isFinite(usage.costUsd)
			? usage.costUsd
			: undefined;
	if (cost === undefined && usage.inputTokens + usage.outputTokens === 0)
		return totals ?? null;
	const costUsd =
		cost === undefined ? totals?.costUsd : (totals?.costUsd ?? 0) + cost;
	const unpricedReplies =
		(totals?.unpricedReplies ?? 0) + (cost === undefined ? 1 : 0);
	return {
		inputTokens: (totals?.inputTokens ?? 0) + usage.inputTokens,
		outputTokens: (totals?.outputTokens ?? 0) + usage.outputTokens,
		...(costUsd === undefined ? {} : { costUsd }),
		...(unpricedReplies > 0 ? { unpricedReplies } : {}),
	};
}

function addReplyToUsage(
	state: WorkspaceChatState,
	conversationId: string,
	usage: TurnUsage,
	seq: number,
): WorkspaceChatState {
	return {
		...state,
		usageCursor: seq,
		usage: addUsage(state.usage, usage),
		conversations: state.conversations.map((row) => {
			if (row.id !== conversationId) return row;
			const next = addUsage(row.usage, usage);
			return next ? { ...row, usage: next } : row;
		}),
	};
}

/** Usage of the conversation in view, if any reply in it reported some. */
export function conversationUsage(
	state: Pick<WorkspaceChatState, "conversations" | "conversationId">,
): UsageTotals | null {
	if (state.conversationId === null) return null;
	return (
		state.conversations.find((row) => row.id === state.conversationId)?.usage ??
		null
	);
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

/**
 * Every request in the workspace still waiting for a decision, oldest first:
 * the open conversation's and the ones other conversations raised.
 */
export function waitingForDecision(
	state: WorkspaceChatState,
): WaitingApproval[] {
	return state.waiting;
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

/** A finished turn's cost, or nothing when none was recorded. Never a made-up zero. */
export function formatTurnCost(usage: TurnUsage | undefined): string | null {
	if (usage?.costUsd === undefined || !Number.isFinite(usage.costUsd))
		return null;
	return usage.costUsd > 0 && usage.costUsd < 0.0001
		? "Cost <$0.0001"
		: `Cost $${usage.costUsd.toFixed(4)}`;
}

function formatUsd(cost: number, digits: number): string {
	if (cost >= 1) return `$${cost.toFixed(2)}`;
	const floor = 10 ** -digits;
	if (cost > 0 && cost < floor) return `<$${floor.toFixed(digits)}`;
	return `$${cost.toFixed(digits)}`;
}

/**
 * The cost part of a running total, or nothing when no reply has a price.
 * A trailing "+" says some replies have no price, so the total is higher.
 */
function formatTotalCost(totals: UsageTotals, digits: number): string | null {
	if (totals.costUsd === undefined || !Number.isFinite(totals.costUsd))
		return null;
	return `${formatUsd(totals.costUsd, digits)}${totals.unpricedReplies ? "+" : ""}`;
}

/** Why a total carries a "+", for its tooltip. */
export function usageTotalsNote(totals: UsageTotals): string | null {
	return totals.costUsd !== undefined && totals.unpricedReplies
		? "Some replies have no price, so the cost shown covers only the priced ones."
		: null;
}

/** "24,399 tokens · $0.047" for a conversation; tokens only when unpriced. */
export function formatConversationUsage(
	totals: UsageTotals | null,
): string | null {
	if (!totals) return null;
	const tokens = totals.inputTokens + totals.outputTokens;
	const cost = formatTotalCost(totals, 3);
	if (tokens === 0 && cost === null) return null;
	return [`${tokens.toLocaleString()} tokens`, cost]
		.filter(Boolean)
		.join(" · ");
}

/** The workspace's spend so far ("$0.09"), or its tokens when unpriced. */
export function formatWorkspaceUsage(
	totals: UsageTotals | null,
): string | null {
	if (!totals) return null;
	const cost = formatTotalCost(totals, 2);
	if (cost) return cost;
	const tokens = totals.inputTokens + totals.outputTokens;
	return tokens > 0 ? `${tokens.toLocaleString()} tokens` : null;
}

/** What is known about a finished turn. Missing parts are left out. */
export function turnDetails(
	turn: Pick<ChatTurn, "durationMs" | "usage">,
	modelLabel?: string | null,
): string[] {
	return [
		turn.durationMs !== undefined
			? `Took ${elapsedLabel(turn.durationMs)}`
			: null,
		modelLabel || null,
		turn.usage ? formatUsage(turn.usage) : null,
		formatTurnCost(turn.usage),
	].filter((part): part is string => Boolean(part));
}

/** Token counts, or nothing when the provider reported none. */
export function formatUsage(usage: TurnUsage): string | null {
	// Older runtimes wrote zeroes when no provider usage was available.
	if (
		usage.partial === undefined &&
		usage.inputTokens === 0 &&
		usage.outputTokens === 0
	)
		return null;
	const parts = [
		`${usage.inputTokens.toLocaleString()} input · ${usage.outputTokens.toLocaleString()} output tokens`,
	];
	if (usage.cachedInputTokens !== undefined)
		parts.push(`${usage.cachedInputTokens.toLocaleString()} cached input`);
	if (usage.partial) parts.push("partial usage");
	return parts.join(" · ");
}
