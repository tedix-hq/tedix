/**
 * Wire format between the browser and a workspace object's chat lane.
 *
 * The browser opens `wss://<os-host>/workspace/{workspaceId}/chat`. The OS
 * Worker authenticates the cookie and hands the upgrade to the workspace
 * object, which replays its ledger from the client's cursor and then streams
 * live. Every event the object emits carries an object-wide `seq`; the client
 * keeps the highest seq it has folded and resubscribes with it, so a dropped
 * socket costs nothing but the gap.
 *
 * The same event objects come back from the object's ledger for history, so one
 * reducer (`workspace-chat-state.ts`) builds both the replay and the live view.
 *
 * Agreed with the workspace-object session on Work Item d6de51a5; change both
 * ends together.
 */

export const WORKSPACE_CHAT_PATH_PREFIX = "/workspace/";
export const WORKSPACE_CHAT_PATH_SUFFIX = "/chat";

export function workspaceChatSocketUrl(
	origin: string,
	workspaceId: string,
): string {
	const url = new URL(
		`${WORKSPACE_CHAT_PATH_PREFIX}${encodeURIComponent(workspaceId)}${WORKSPACE_CHAT_PATH_SUFFIX}`,
		origin,
	);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	return url.toString();
}

/** `/workspace/{id}/chat` → the workspace id, or null for any other path. */
export function parseWorkspaceChatPath(pathname: string): string | null {
	if (
		!pathname.startsWith(WORKSPACE_CHAT_PATH_PREFIX) ||
		!pathname.endsWith(WORKSPACE_CHAT_PATH_SUFFIX)
	)
		return null;
	const id = decodeURIComponent(
		pathname.slice(
			WORKSPACE_CHAT_PATH_PREFIX.length,
			-WORKSPACE_CHAT_PATH_SUFFIX.length,
		),
	);
	return id && !id.includes("/") ? id : null;
}

export type ApprovalDecision = "approve" | "deny";
export type StepKind = "read" | "write" | "code" | "tool" | "think";
export type TurnStatus = "done" | "error" | "cancelled" | "waiting";

export type WorkspaceChatClientMessage =
	| {
			type: "subscribe";
			conversationId: string | null;
			/** Highest seq already folded; null asks for the recent history. */
			cursor: number | null;
	  }
	| {
			type: "send_turn";
			clientTurnId: string;
			conversationId: string | null;
			text: string;
			tediId?: string;
			modelId?: string;
			attachments?: Array<{ outputId: string }>;
	  }
	| {
			type: "decide_approval";
			approvalId: string;
			decision: ApprovalDecision;
			note?: string;
			/** Echoed in the `approvals.decided` answer. */
			runId?: string;
	  }
	| {
			/**
			 * Decide several approvals one at a time in the order given, from any
			 * conversation; each conversation continues with one turn.
			 */
			type: "decide_approvals";
			approvalIds: string[];
			decision: ApprovalDecision;
			/** Echoed in the `approvals.decided` answer. */
			runId?: string;
	  }
	| { type: "cancel_turn"; turnId: string }
	| { type: "rename_conversation"; conversationId: string; title: string }
	| {
			/** `archived: false` puts the conversation back in the list. */
			type: "archive_conversation";
			conversationId: string;
			archived: boolean;
	  }
	| { type: "delete_conversation"; conversationId: string }
	| {
			type: "read_ledger";
			conversationId: string;
			/** Return events with seq below this one. */
			before: number;
			limit: number;
	  }
	| { type: "ping" };

type WorkspaceChatAuthorIdentity = {
	id: string;
	kind: "person" | "tedi";
};

/** A request waiting for a person, as its `approval.requested` event told it. */
export type WaitingApprovalSummary = {
	requester?: WorkspaceChatAuthorIdentity;
	approvalId: string;
	conversationId: string;
	turnId: string;
	stepId: string;
	title: string;
	reason: string;
	policy?: string;
	input?: unknown;
	target?: { id: string; title: string };
	/** When it was asked for. */
	at: string;
};

export type ConversationSummary = {
	id: string;
	title: string | null;
	updatedAt: string;
	lastTurnAt: string | null;
	/** A turn in this conversation is still working. */
	running?: boolean;
	/** How many changes in this conversation wait for a decision. */
	pendingApprovals?: number;
	/** Set while the conversation is archived. */
	archivedAt?: string;
	/** Absent until a reply in this conversation reports usage. */
	usage?: UsageTotals;
	/**
	 * Set when the first message came from an agent rather than a person: a
	 * tedi (`id` is the tedi) or a connected app's agent. It never changes, so
	 * the conversation stays that agent's run when a person writes in it later.
	 */
	startedBy?: { kind: "tedi" | "agent"; id: string };
};

/** What finished replies have used so far, summed from their `assistant.done` usage. */
export type UsageTotals = {
	inputTokens: number;
	outputTokens: number;
	/** Sum of the priced replies, in US dollars; absent when none has a price. */
	costUsd?: number;
	/** Replies with usage but no price, so `costUsd` covers only part of it. */
	unpricedReplies?: number;
};

export type TurnUsage = {
	inputTokens: number;
	outputTokens: number;
	cachedInputTokens?: number;
	partial?: boolean;
	/** Governed-rate price of the finished turn, in US dollars. */
	costUsd?: number;
	/** Why the finished turn has no price. */
	costUnavailable?: string;
};

type Stamped = {
	seq: number;
	at: string;
	conversationId: string;
};

/** A message sent while a turn was working, as each of its events repeats it. */
type QueuedMessage = Stamped & {
	/** The working turn it was sent to, then the turn that read it. */
	turnId: string;
	messageId: string;
	text: string;
	displayText?: string;
	attachments?: Array<{
		outputId: string;
		title: string;
		revision: number;
		revisionId: string;
	}>;
	authorId: string;
	authorKind: "person" | "tedi";
};

/** Events the object writes to its ledger; each one carries a `seq`. */
export type WorkspaceChatLedgerEvent =
	/**
	 * Sent while `turnId` was working: it waits for that turn's next step.
	 * `message.read`, `message.returned` or a `turn.started` whose `turnId` is
	 * this `messageId` settles it.
	 */
	| (QueuedMessage & { type: "message.queued" })
	/** The working turn read it. */
	| (QueuedMessage & { type: "message.read" })
	/** The turn was stopped first; no turn read it. */
	| (QueuedMessage & { type: "message.returned" })
	| (Stamped & {
			type: "turn.started";
			turnId: string;
			displayText?: string;
			attachments?: Array<{
				outputId: string;
				title: string;
				revision: number;
				revisionId: string;
			}>;
			text: string;
			respondingTediId?: string | null;
			authorId: string;
			authorKind: "person" | "tedi";
	  })
	| (Stamped & { type: "turn.model"; turnId: string; model: string })
	| (Stamped & { type: "turn.usage"; turnId: string; usage: TurnUsage })
	| (Stamped & {
			type: "assistant.delta";
			turnId: string;
			messageId: string;
			text: string;
	  })
	| (Stamped & {
			type: "assistant.done";
			turnId: string;
			messageId: string;
			text: string;
			usage?: TurnUsage;
			model?: string;
	  })
	| (Stamped & {
			type: "step.started";
			turnId: string;
			stepId: string;
			label: string;
			kind: StepKind;
			tool?: string;
			input?: unknown;
	  })
	| (Stamped & {
			type: "step.finished";
			turnId: string;
			stepId: string;
			status: "ok" | "error";
			summary?: string;
			durationMs: number;
			error?: string;
			/** The start of what the step returned, as text; a few KB at most. */
			result?: string;
	  })
	| (Stamped & {
			/** Earlier messages of the conversation were summarised to fit the model. */
			type: "conversation.summarized";
			turnId: string;
	  })
	| (Stamped & {
			type: "approval.requested";
			requester?: WorkspaceChatAuthorIdentity;
			turnId: string;
			stepId: string;
			approvalId: string;
			title: string;
			reason: string;
			policy?: string;
			input?: unknown;
			target?: { id: string; title: string };
			/** The change applies at once; it is not waiting for anyone. */
			automatic?: true;
	  })
	| (Stamped & {
			type: "approval.decided";
			turnId?: string;
			approvalId: string;
			decision: ApprovalDecision;
			by: string;
			/** The change applied at once; nobody decided it by hand. */
			automatic?: true;
	  })
	| (Stamped & {
			type: "approval.executed";
			approvalId: string;
			status: "applied" | "failed";
			error?: string;
			/** The file the write saved; revision 1 means it created the file. */
			output?: { outputId: string; revision: number };
			/** The app the write created. */
			app?: { appId: string; name: string };
	  })
	| (Stamped & {
			/** A live view for the answer, rendered in the sandboxed widget frame. */
			type: "view.shown";
			turnId: string;
			viewId: string;
			appSlug: string;
			resourceUri: string;
			title: string;
			toolResult: Record<string, unknown>;
	  })
	| (Stamped & {
			/**
			 * The agent asked for an account a connected source needs. Shown as a
			 * "Connect" card; nothing changed and nothing waits on it.
			 */
			type: "connection.requested";
			turnId: string;
			requestId: string;
			resourceId: string;
			resourceName: string;
			providerId: string;
			/** The service's display name. */
			service: string;
			/** Whose account is missing: the person's own, or the organization's. */
			connectionScope: "personal" | "organization";
			reason?: string;
	  })
	| (Stamped & {
			type: "turn.finished";
			turnId: string;
			status: TurnStatus;
			approvalUrl?: string;
			error?: string;
			durationMs: number;
	  })
	| (Stamped & {
			type: "conversation.updated";
			title?: string | null;
			archivedAt?: string | null;
	  });

/** Control frames: not in the ledger, no `seq`. */
export type WorkspaceChatControlMessage =
	| {
			type: "hello";
			cursor: number;
			serverTime: string;
			conversations: ConversationSummary[];
			/** Archived conversations, each with `archivedAt`; not in `conversations`. */
			archived?: ConversationSummary[];
			/**
			 * Every request in the workspace waiting for a person up to `cursor`,
			 * oldest first, whichever conversation asked.
			 */
			waiting: WaitingApprovalSummary[];
			models?: Array<{ id: string; label: string }>;
			/** The whole workspace, archived conversations included, up to `cursor`. */
			usage?: UsageTotals;
	  }
	| {
			/** A conversation and everything in it is gone; every open chat gets it. */
			type: "conversation.deleted";
			conversationId: string;
			/** The ledger position `usage` is counted up to. */
			cursor: number;
			/** The workspace's usage without the deleted conversation. */
			usage?: UsageTotals;
	  }
	| { type: "caught_up"; conversationId: string | null }
	| {
			/** The replay stopped at `cursor`; subscribe again from it for the rest. */
			type: "replay.more";
			cursor: number;
			conversationId: string | null;
	  }
	| {
			type: "turn.accepted";
			clientTurnId: string;
			turnId: string;
			conversationId: string;
	  }
	| {
			type: "ledger.page";
			conversationId: string;
			events: WorkspaceChatLedgerEvent[];
			/** Older events exist below the first one returned. */
			hasMore: boolean;
	  }
	| {
			/**
			 * The answer to `decide_approval` and `decide_approvals`, sent to the
			 * socket that decided: how far the run got and why it stopped.
			 */
			type: "approvals.decided";
			runId?: string;
			decision: ApprovalDecision;
			/** How many requests the run was given. */
			total: number;
			/** How many of them this run decided itself and, on approve, applied. */
			done: number;
			/** How many someone else had decided first; those were left as they are. */
			alreadyDecided: number;
			/** Where the run stopped; every request after it still waits. */
			stopped?: {
				approvalId: string;
				reason: "failed" | "decided_otherwise";
				error?: string;
			};
	  }
	| { type: "pong" }
	| { type: "error"; code: string; message: string; clientTurnId?: string };

export type WorkspaceChatServerMessage =
	| WorkspaceChatLedgerEvent
	| WorkspaceChatControlMessage;

const LEDGER_TYPES = new Set<WorkspaceChatLedgerEvent["type"]>([
	"turn.started",
	"message.queued",
	"message.read",
	"message.returned",
	"turn.model",
	"turn.usage",
	"assistant.delta",
	"assistant.done",
	"step.started",
	"step.finished",
	"conversation.summarized",
	"approval.requested",
	"approval.decided",
	"approval.executed",
	"view.shown",
	"connection.requested",
	"turn.finished",
	"conversation.updated",
]);

const CONTROL_TYPES = new Set<WorkspaceChatControlMessage["type"]>([
	"hello",
	"conversation.deleted",
	"caught_up",
	"replay.more",
	"turn.accepted",
	"ledger.page",
	"approvals.decided",
	"pong",
	"error",
]);

export function isLedgerEvent(
	message: WorkspaceChatServerMessage,
): message is WorkspaceChatLedgerEvent {
	return LEDGER_TYPES.has(message.type as WorkspaceChatLedgerEvent["type"]);
}

/**
 * Structural check on a decoded frame. A frame from an object we do not
 * recognise is dropped, never thrown on: one bad frame must not kill the lane.
 */
export function parseWorkspaceChatServerMessage(
	raw: unknown,
): WorkspaceChatServerMessage | null {
	const data = typeof raw === "string" ? safeJsonParse(raw) : raw;
	if (!data || typeof data !== "object") return null;
	const type = (data as { type?: unknown }).type;
	if (typeof type !== "string") return null;
	if (LEDGER_TYPES.has(type as WorkspaceChatLedgerEvent["type"])) {
		const event = data as Partial<WorkspaceChatLedgerEvent>;
		if (
			typeof event.seq !== "number" ||
			typeof event.at !== "string" ||
			typeof event.conversationId !== "string"
		)
			return null;
		return event as WorkspaceChatLedgerEvent;
	}
	if (CONTROL_TYPES.has(type as WorkspaceChatControlMessage["type"]))
		return data as WorkspaceChatControlMessage;
	return null;
}

function safeJsonParse(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}
