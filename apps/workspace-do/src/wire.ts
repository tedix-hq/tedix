/**
 * The frames the chat UI reads and writes. Names follow the proposal from the
 * chat UI item (cc93f558): one reducer builds both history and live view.
 */

export type AuthorKind = "person" | "tedi";

export interface WireEventBase {
	/** Object-wide, monotonic, never reused. */
	seq: number;
	at: string;
	conversationId: string;
	turnId?: string;
}

export type WireEventBody =
	| {
			type: "turn.started";
			turnId: string;
			text: string;
			authorId: string;
			authorKind: AuthorKind;
	  }
	| { type: "assistant.delta"; turnId: string; messageId: string; text: string }
	| {
			type: "assistant.done";
			turnId: string;
			messageId: string;
			text: string;
			usage: {
				inputTokens: number;
				outputTokens: number;
				cachedInputTokens?: number;
			};
			model?: string;
	  }
	| {
			type: "step.started";
			turnId: string;
			stepId: string;
			label: string;
			kind: "read" | "write" | "code" | "tool" | "think";
			tool?: string;
			input?: unknown;
	  }
	| {
			type: "step.finished";
			turnId: string;
			stepId: string;
			status: "ok" | "error";
			summary?: string;
			durationMs: number;
			error?: string;
	  }
	| {
			type: "approval.requested";
			turnId: string;
			stepId: string;
			approvalId: string;
			title: string;
			reason: string;
			policy?: string;
			input?: unknown;
	  }
	| {
			type: "approval.decided";
			approvalId: string;
			decision: "approve" | "deny";
			by: string;
			at: string;
	  }
	| {
			type: "turn.finished";
			turnId: string;
			status: "done" | "error" | "cancelled";
			error?: string;
			durationMs: number;
	  }
	| {
			type: "conversation.updated";
			conversationId: string;
			title?: string;
			archivedAt?: string | null;
	  };

export type WireEvent = WireEventBase & WireEventBody;

/** Frames without a seq: not in the ledger. */
export type WireControlFrame =
	| {
			type: "hello";
			cursor: number;
			serverTime: string;
			conversations: ConversationSummary[];
	  }
	| { type: "caught_up"; cursor: number; conversationId: string | null }
	| {
			type: "ledger.page";
			conversationId: string;
			events: WireEvent[];
			hasMore: boolean;
	  }
	| {
			type: "turn.accepted";
			clientTurnId: string;
			turnId: string;
			conversationId: string;
	  }
	| { type: "pong" }
	| { type: "error"; code: string; message: string; clientTurnId?: string };

export type ClientFrame =
	| { type: "subscribe"; conversationId: string | null; cursor: number | null }
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
			decision: "approve" | "deny";
			note?: string;
	  }
	| { type: "cancel_turn"; turnId: string }
	| {
			type: "read_ledger";
			conversationId: string;
			before: number | null;
			limit?: number;
	  }
	| { type: "ping" };

export interface ConversationSummary {
	id: string;
	title: string | null;
	updatedAt: string;
	lastTurnAt: string | null;
}

/** Plain labels for the steps a turn takes, by binding and method. */
export function stepLabel(
	binding: string,
	method: string,
): { label: string; kind: "read" | "write" } {
	const table: Record<string, Record<string, string>> = {
		outputs: {
			list: "Listing documents and sheets",
			get: "Reading a document or sheet",
			create: "Creating a new output",
			revise: "Saving a new revision",
		},
		apps: { list: "Listing apps" },
		resources: { list: "Listing resources" },
		work: { list: "Reading Work items", listOpen: "Reading open Work items" },
	};
	const write = method === "create" || method === "revise";
	return {
		label: table[binding]?.[method] ?? `${binding}.${method}`,
		kind: write ? "write" : "read",
	};
}
