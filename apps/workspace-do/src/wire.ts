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

export interface TurnUsage {
	inputTokens: number;
	outputTokens: number;
	cachedInputTokens?: number;
	partial?: boolean;
	/** Governed-rate price of the finished turn, in US dollars. */
	costUsd?: number;
	/** Why the finished turn has no price; set exactly when `costUsd` is absent. */
	costUnavailable?: string;
}

/** What finished replies have used so far, summed from their `assistant.done` usage. */
export interface UsageTotals {
	inputTokens: number;
	outputTokens: number;
	/** Sum of the priced replies, in US dollars; absent when none has a price. */
	costUsd?: number;
	/** Replies with usage but no price, so `costUsd` covers only part of it. */
	unpricedReplies?: number;
}

/** A message sent to a working turn, as each of its events repeats it. */
export interface QueuedMessageBody {
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
	authorKind: AuthorKind;
	/** The workspace app the person asked from. */
	fromAppId?: string;
}

export type WireEventBody =
	| {
			type: "turn.started";
			turnId: string;
			text: string;
			displayText?: string;
			attachments?: Array<{
				outputId: string;
				title: string;
				revision: number;
				revisionId: string;
			}>;
			authorId: string;
			authorKind: AuthorKind;
			/** The workspace app the person asked from. */
			fromAppId?: string;
			/** The tedi answering; null or absent for the workspace agent. */
			respondingTediId?: string | null;
			/** Why the workspace agent answers instead of the default tedi. */
			answererNote?: string;
			/**
			 * Set when the previous answerer handed this turn over: that tedi, or
			 * null for the workspace agent. `displayText` is the one-line note.
			 */
			handedFrom?: { tediId: string | null };
	  }
	| ({
			/**
			 * A message sent while `turnId` was working. It waits for that turn's
			 * next model call; `message.read` or `message.returned` settles it, or
			 * a `turn.started` whose `turnId` is this `messageId`.
			 */
			type: "message.queued";
	  } & QueuedMessageBody)
	| ({
			/** The working turn read the message; it is part of `turnId` now. */
			type: "message.read";
	  } & QueuedMessageBody)
	| ({
			/** The turn was stopped first: no turn read the message. */
			type: "message.returned";
	  } & QueuedMessageBody)
	| { type: "agent_run.ended"; turnId: string; text: string }
	| { type: "turn.model"; turnId: string; model: string }
	| { type: "turn.usage"; turnId: string; usage: TurnUsage }
	| { type: "assistant.delta"; turnId: string; messageId: string; text: string }
	| {
			type: "assistant.done";
			turnId: string;
			messageId: string;
			text: string;
			usage?: TurnUsage;
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
			tool?: string;
			status: "ok" | "error";
			summary?: string;
			durationMs: number;
			error?: string;
			/** The start of what the step returned, as text; a few KB at most. */
			result?: string;
	  }
	| {
			/** Earlier messages of the conversation were summarised to fit the model. */
			type: "conversation.summarized";
			turnId: string;
	  }
	| {
			type: "approval.requested";
			/** Who sent the turn that asked. */
			requester?: { id: string; kind: AuthorKind };
			/** The tedi that applies the change, when a person addressed one. */
			actingTediId?: string;
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
	  }
	| {
			type: "approval.decided";
			approvalId: string;
			decision: "approve" | "deny";
			by: string;
			at: string;
			/** Recorded for a change that applied at once, not decided by hand. */
			automatic?: true;
	  }
	| {
			type: "approval.executed";
			approvalId: string;
			status: "applied" | "failed";
			error?: string;
			/** The file the write saved; revision 1 means it created the file. */
			output?: { outputId: string; revision: number };
			/** The app the write created. */
			app?: { appId: string; name: string };
	  }
	| {
			type: "schedule.registered";
			turnId: string;
			gadgetId: string;
			triggerId: string;
			name: string;
	  }
	| {
			/** A live view for the turn's answer, rendered in the widget frame. */
			type: "view.shown";
			turnId: string;
			viewId: string;
			appSlug: string;
			resourceUri: string;
			title: string;
			toolResult: Record<string, unknown>;
	  }
	| {
			/**
			 * The agent asked for an account a connected source needs. The chat
			 * shows a "Connect" card; nothing changed and nothing waits on it.
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
	  }
	| {
			/**
			 * A guest tedi's tool call waits for a person's decision in Tedix's
			 * approvals. The chat links there; approving runs that exact call
			 * once and its result does not come back into the chat.
			 */
			type: "tedi_approval.requested";
			turnId: string;
			approvalId: string;
			tediId: string;
			tool: string;
			description: string;
			url: string | null;
	  }
	| {
			type: "turn.finished";
			turnId: string;
			status: "done" | "error" | "cancelled" | "waiting";
			approvalUrl?: string;
			error?: string;
			durationMs: number;
	  }
	| {
			type: "conversation.updated";
			conversationId: string;
			title?: string;
			archivedAt?: string | null;
			/** The tedi that answered the latest turn; null when the workspace agent did. */
			tediId?: string | null;
	  };

export type WireEvent = WireEventBase & WireEventBody;

/** Frames without a seq: not in the ledger. */
export type WireControlFrame =
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
			waiting: WaitingApproval[];
			models?: Array<{ id: string; label: string }>;
			/** The whole workspace, archived conversations included, up to `cursor`. */
			usage?: UsageTotals;
	  }
	| {
			/**
			 * A conversation and everything in it is gone. Its events left the
			 * ledger with it, so this is a control frame; every open chat gets it.
			 */
			type: "conversation.deleted";
			conversationId: string;
			/** The ledger position `usage` is counted up to. */
			cursor: number;
			/** The workspace's usage without the deleted conversation. */
			usage?: UsageTotals;
	  }
	| { type: "caught_up"; cursor: number; conversationId: string | null }
	| {
			/**
			 * The replay stopped at `cursor` with events still to come. The client
			 * subscribes again from it, so no page outgrows the object's memory.
			 */
			type: "replay.more";
			cursor: number;
			conversationId: string | null;
	  }
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
	| {
			/**
			 * The answer to `decide_approval` and `decide_approvals`, sent to the
			 * socket that decided: how far the run got and why it stopped.
			 */
			type: "approvals.decided";
			runId?: string;
			decision: "approve" | "deny";
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

export type ClientFrame =
	| { type: "subscribe"; conversationId: string | null; cursor: number | null }
	| {
			type: "send_turn";
			clientTurnId: string;
			conversationId: string | null;
			text: string;
			tediId?: string;
			/** The person chose the workspace agent: no default tedi answers. */
			answerer?: "agent";
			modelId?: string;
			attachments?: Array<{ outputId: string }>;
			/** The workspace app the person asked from. */
			fromAppId?: string;
	  }
	| {
			type: "decide_approval";
			approvalId: string;
			decision: "approve" | "deny";
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
			decision: "approve" | "deny";
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
			before: number | null;
			limit?: number;
	  }
	| { type: "ping" };

/** A request waiting for a person, as its `approval.requested` event told it. */
export interface WaitingApproval {
	requester?: { id: string; kind: AuthorKind };
	actingTediId?: string;
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
}

export interface ConversationSummary {
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
	/** The tedi that answered the latest turn; null when the workspace agent did. */
	tediId: string | null;
}

/** What a create call is making, by name: "the sheet Trip budget". */
function createdThing(binding: string, input: unknown): string | null {
	if (binding !== "apps" && binding !== "outputs") return null;
	if (typeof input !== "object" || input === null) return null;
	const { title, name, content } = input as Record<string, unknown>;
	const named = binding === "apps" ? name : title;
	if (typeof named !== "string" || !named.trim()) return null;
	const kind =
		binding === "apps" ? "app" : (content as { kind?: unknown } | null)?.kind;
	const noun =
		typeof kind === "string" &&
		["app", "document", "sheet", "presentation"].includes(kind)
			? kind
			: "file";
	return `the ${noun} ${named.trim().slice(0, 80)}`;
}

/**
 * Plain labels for the steps a turn takes, by binding and method. With the
 * call's input, a create step names what it makes.
 */
export function stepLabel(
	binding: string,
	method: string,
	input?: unknown,
): { label: string; kind: "read" | "write" } {
	const table: Record<string, Record<string, string>> = {
		outputs: {
			list: "Listing documents and sheets",
			get: "Reading a document or sheet",
			readFileText: "Reading part of an uploaded file",
			searchFileText: "Searching an uploaded file",
			create: "Creating a new output",
			revise: "Saving a new revision",
		},
		documents: {
			read: "Reading a document",
			replace: "Saving a document revision",
			edit: "Editing document blocks",
		},
		sheets: {
			read: "Reading a sheet",
			replace: "Saving a sheet revision",
			edit: "Editing sheet cells",
		},
		presentations: {
			read: "Reading slides",
			replace: "Saving a presentation revision",
			edit: "Editing slides",
		},
		apps: {
			list: "Listing apps",
			getCode: "Reading app source",
			versions: "Listing app versions",
			readFile: "Reading an app file",
			grep: "Searching app files",
			create: "Creating a new app",
			allowRead: "Letting an app read workspace files",
			registerSchedule: "Registering a scheduled run",
			editFile: "Editing an app draft",
			writeFile: "Writing an app draft file",
			restoreVersion: "Staging an earlier app version",
		},
		resources: {
			list: "Listing connected sources",
			requestConnection: "Asking for a connected account",
		},
		accounts: {
			list: "Listing linked accounts",
			describe: "Looking up connected account read tools",
			read: "Reading from a connected account",
		},
		views: { show: "Showing a view" },
		web: { fetch: "Reading a web page" },
		person: { memory: "Reading your personal memory" },
		chat: { handTo: "Handing the conversation to a tedi" },
		tedi: {
			list: "Looking up the tedi's skills and tools",
			describe: "Reading a tool's arguments",
			call: "Using the tedi's tool",
		},
		machine: {
			list: "Listing machines",
			call: "Using a machine",
			read: "Reading a machine's answer",
		},
		work: {
			list: "Reading Work items",
			listOpen: "Reading open Work items",
			create: "Filing a Work Item",
			listProjects: "Listing projects",
			startRun: "Starting a run",
			readRun: "Reading a coding run",
			sendRunMessage: "Sending a follow-up to the run",
			stopRun: "Stopping a coding run",
		},
	};
	const write =
		(binding === "apps" &&
			[
				"editFile",
				"writeFile",
				"restoreVersion",
				"registerSchedule",
				"allowRead",
			].includes(method)) ||
		(binding === "work" &&
			["startRun", "sendRunMessage", "stopRun"].includes(method)) ||
		method === "create" ||
		method === "revise" ||
		(["documents", "sheets", "presentations"].includes(binding) &&
			(method === "replace" || method === "edit"));
	const created = method === "create" ? createdThing(binding, input) : null;
	return {
		label: created
			? `Creating ${created}`
			: (table[binding]?.[method] ?? `${binding}.${method}`),
		kind: write ? "write" : "read",
	};
}
