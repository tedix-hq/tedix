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
export type TurnStatus = "done" | "error" | "cancelled";

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
			attachments?: Array<{ outputId: string }>;
	  }
	| {
			type: "decide_approval";
			approvalId: string;
			decision: ApprovalDecision;
			note?: string;
	  }
	| { type: "cancel_turn"; turnId: string }
	| {
			type: "read_ledger";
			conversationId: string;
			/** Return events with seq below this one. */
			before: number;
			limit: number;
	  }
	| { type: "ping" };

export type ConversationSummary = {
	id: string;
	title: string | null;
	updatedAt: string;
	lastTurnAt: string | null;
};

export type TurnUsage = {
	inputTokens: number;
	outputTokens: number;
	cachedInputTokens?: number;
	costCents?: number;
};

type Stamped = {
	seq: number;
	at: string;
	conversationId: string;
};

/** Events the object writes to its ledger; each one carries a `seq`. */
export type WorkspaceChatLedgerEvent =
	| (Stamped & {
			type: "turn.started";
			turnId: string;
			text: string;
			authorId: string;
			authorKind: "person" | "tedi";
	  })
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
	  })
	| (Stamped & {
			type: "approval.requested";
			turnId: string;
			stepId: string;
			approvalId: string;
			title: string;
			reason: string;
			policy?: string;
			input?: unknown;
	  })
	| (Stamped & {
			type: "approval.decided";
			turnId: string;
			approvalId: string;
			decision: ApprovalDecision;
			by: string;
	  })
	| (Stamped & {
			type: "turn.finished";
			turnId: string;
			status: TurnStatus;
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
	  }
	| { type: "caught_up"; conversationId: string | null }
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
	| { type: "pong" }
	| { type: "error"; code: string; message: string; clientTurnId?: string };

export type WorkspaceChatServerMessage =
	| WorkspaceChatLedgerEvent
	| WorkspaceChatControlMessage;

const LEDGER_TYPES = new Set<WorkspaceChatLedgerEvent["type"]>([
	"turn.started",
	"assistant.delta",
	"assistant.done",
	"step.started",
	"step.finished",
	"approval.requested",
	"approval.decided",
	"turn.finished",
	"conversation.updated",
]);

const CONTROL_TYPES = new Set<WorkspaceChatControlMessage["type"]>([
	"hello",
	"caught_up",
	"turn.accepted",
	"ledger.page",
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
