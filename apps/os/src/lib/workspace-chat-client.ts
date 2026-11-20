/**
 * The browser side of a workspace object's chat lane.
 *
 * One socket per open workspace chat. It subscribes with the last folded seq,
 * folds replay and live frames through the same reducer, and when the socket
 * drops it reconnects on the shared backoff ladder (`nextBackoffDelayMs`) with
 * the cursor it already has. Nothing is lost on a drop: the object replays the
 * gap, in pages when the gap is large (`replay.more`), and this side asks for
 * each next page. The UI shows "Reconnecting" while this runs and never a dead
 * end.
 *
 * A connection counts as open only once the object answered `hello` (the
 * reference runtime proves each candidate with a ping before trusting it). A
 * socket that stays silent for longer than `LIVENESS_IDLE_MS` is pinged, and
 * dropped if the pong does not come, so a dead server behind a healthy socket
 * is caught as well.
 */

import { nextBackoffDelayMs } from "./conversation-stream";
import {
	type ApprovalDecision,
	isLedgerEvent,
	parseWorkspaceChatServerMessage,
	type WorkspaceChatClientMessage,
	type WorkspaceChatLedgerEvent,
	type WorkspaceChatServerMessage,
	workspaceChatSocketUrl,
} from "./workspace-chat-protocol";
import {
	type ApprovalNotice,
	type ApprovalRun,
	applyWorkspaceChatEvent,
	applyWorkspaceChatEvents,
	initialWorkspaceChatState,
	markPendingSend,
	markSendFailed,
	removeConversation,
	setConversations,
	setHasEarlier,
	setWaitingApprovals,
	setWorkspaceUsage,
	type WorkspaceChatState,
} from "./workspace-chat-state";

export const WORKSPACE_CHAT_LIVENESS_IDLE_MS = 30_000;
export const WORKSPACE_CHAT_PONG_TIMEOUT_MS = 10_000;
export const WORKSPACE_CHAT_HELLO_TIMEOUT_MS = 15_000;
export const WORKSPACE_CHAT_HISTORY_PAGE = 40;

export type WorkspaceChatConnection =
	| { phase: "connecting"; attempt: number }
	| { phase: "open"; since: number }
	| { phase: "reconnecting"; attempt: number; nextTryAt: number }
	/** This origin has no object lane yet; the ladder is parked until `retry()`. */
	| { phase: "unavailable" }
	| { phase: "closed" };

export type WorkspaceChatSnapshot = {
	state: WorkspaceChatState;
	connection: WorkspaceChatConnection;
	/** True until the object has replayed everything up to its cursor. */
	catchingUp: boolean;
};

export type SocketLike = {
	readyState: number;
	send(data: string): void;
	close(code?: number, reason?: string): void;
	onopen: ((event: unknown) => void) | null;
	onmessage: ((event: { data: unknown }) => void) | null;
	onclose: ((event: { code?: number; reason?: string }) => void) | null;
	onerror: ((event: unknown) => void) | null;
};

export type WorkspaceChatClientOptions = {
	workspaceId: string;
	conversationId: string | null;
	origin?: string;
	/** Test seams. */
	createSocket?: (url: string) => SocketLike;
	setTimeoutFn?: (callback: () => void, ms: number) => unknown;
	clearTimeoutFn?: (handle: unknown) => void;
	nowFn?: () => number;
	randomFn?: () => number;
	newId?: () => string;
	/** Probe fetch for the lane; defaults to the page's fetch. */
	fetchFn?: (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>;
	/** Batches token renders; defaults to an animation frame. */
	scheduleFrame?: (callback: () => void) => void;
	/** A committed output write completed, including a resumed approval. */
	onOutputChanged?: () => void;
};

export type WorkspaceChatClient = {
	/** Leave `unavailable` and try to connect again now. */
	retry(): void;
	getSnapshot(): WorkspaceChatSnapshot;
	/** The conversation this socket follows; set by the object on the first turn. */
	getConversationId(): string | null;
	subscribe(listener: () => void): () => void;
	/** Returns the client turn id; the object echoes it in `turn.accepted`. */
	sendTurn(input: {
		text: string;
		newConversation?: boolean;
		tediId?: string;
		/** The person chose the workspace agent over the default tedi. */
		answerer?: "agent";
		modelId?: string;
		attachments?: Array<{ outputId: string }>;
		/** The workspace app the person asked from. */
		fromAppId?: string;
	}): string;
	decideApproval(approvalId: string, decision: ApprovalDecision): void;
	/**
	 * Decide several approvals one after another, in the order given. The
	 * object stops at the first that fails; the snapshot's `approvalRun` shows
	 * the run while it works and `approvalNotice` says where it stopped.
	 */
	decideApprovals(approvalIds: string[], decision: ApprovalDecision): void;
	/** The person has read what the last decision reported. */
	dismissApprovalNotice(): void;
	cancelTurn(turnId: string): void;
	/** Rename, archive, restore or delete a conversation of this workspace. */
	changeConversation(change: ConversationChange): void;
	loadEarlier(): void;
	/** Drop the socket now; the ladder reconnects. Used by the drop test. */
	forceDrop(): void;
	close(): void;
};

export type ConversationChange = Extract<
	WorkspaceChatClientMessage,
	{
		type:
			| "rename_conversation"
			| "archive_conversation"
			| "delete_conversation";
	}
>;

const OPEN = 1;

function defaultCreateSocket(url: string): SocketLike {
	return new WebSocket(url) as unknown as SocketLike;
}

export function createWorkspaceChatClient(
	options: WorkspaceChatClientOptions,
): WorkspaceChatClient {
	const {
		workspaceId,
		createSocket = defaultCreateSocket,
		setTimeoutFn = (callback, ms) => setTimeout(callback, ms),
		clearTimeoutFn = (handle) => clearTimeout(handle as number),
		nowFn = () => Date.now(),
		randomFn = Math.random,
		newId = () => crypto.randomUUID(),
		fetchFn = (probeUrl) => fetch(probeUrl, { credentials: "include" }),
		scheduleFrame = typeof requestAnimationFrame === "function"
			? (callback) => void requestAnimationFrame(callback)
			: (callback) => void setTimeout(callback, 16),
	} = options;
	const origin = options.origin ?? window.location.origin;
	const url = workspaceChatSocketUrl(origin, workspaceId);

	let conversationId = options.conversationId;
	let state = initialWorkspaceChatState(conversationId);
	let connection: WorkspaceChatConnection = { phase: "connecting", attempt: 0 };
	let catchingUp = true;
	/**
	 * How far a paged replay has come, until it is caught up. Live frames arrive
	 * between its pages and move `state.cursor` past events not replayed yet, so
	 * a drop in the middle resumes from here instead.
	 */
	let replayCursor: number | null = null;
	const resumeCursor = () => replayCursor ?? state.cursor;
	let snapshot: WorkspaceChatSnapshot = { state, connection, catchingUp };
	const listeners = new Set<() => void>();

	let socket: SocketLike | null = null;
	let closed = false;
	let attempt = 0;
	let openedAt = 0;
	/** The current attempt's socket opened but the object never said hello. */
	let sawOpen = false;
	let retryTimer: unknown = null;
	let helloTimer: unknown = null;
	let livenessTimer: unknown = null;
	let pongTimer: unknown = null;
	/**
	 * Keep sends until acceptance, including when the socket drops after commit.
	 * The object uses clientTurnId as its idempotent turn id on a retry.
	 */
	const outbox = new Map<
		string,
		Extract<WorkspaceChatClientMessage, { type: "send_turn" }>
	>();
	let draftEvents: WorkspaceChatLedgerEvent[] = [];
	/** Decisions sent and not answered yet, by run id. */
	const runs = new Map<string, ApprovalRun>();
	const completedSteps = new Map<
		string,
		Extract<WorkspaceChatLedgerEvent, { type: "step.finished" }>
	>();
	const notifiedOutputSteps = new Set<string>();
	/** Frames folded between animation frames; one render per frame. */
	let frameScheduled = false;
	let dirty = false;

	function publish(): void {
		snapshot = { state, connection, catchingUp };
		for (const listener of listeners) listener();
	}

	function scheduleRender(): void {
		dirty = true;
		if (frameScheduled) return;
		frameScheduled = true;
		scheduleFrame(() => {
			frameScheduled = false;
			if (dirty && !closed) {
				dirty = false;
				publish();
			}
		});
	}

	function setConnection(next: WorkspaceChatConnection): void {
		connection = next;
		publish();
	}

	function send(message: WorkspaceChatClientMessage): boolean {
		if (!socket || socket.readyState !== OPEN) return false;
		socket.send(JSON.stringify(message));
		return true;
	}

	/** Send a decision and remember what it was for until the object answers. */
	function decide(approvalIds: string[], decision: ApprovalDecision): void {
		const run: ApprovalRun = {
			runId: newId(),
			decision,
			requests: approvalIds.flatMap(
				(id) => state.waiting.find((item) => item.approvalId === id) ?? [],
			),
		};
		const [only] = approvalIds;
		const sent =
			approvalIds.length === 1 && only
				? send({
						type: "decide_approval",
						approvalId: only,
						decision,
						runId: run.runId,
					})
				: send({
						type: "decide_approvals",
						approvalIds,
						decision,
						runId: run.runId,
					});
		if (!sent) return;
		runs.set(run.runId, run);
		// A new decision replaces what the last one reported.
		if (approvalIds.length > 1 || state.approvalNotice) {
			state = {
				...state,
				...(approvalIds.length > 1 ? { approvalRun: run } : {}),
				approvalNotice: null,
			};
			publish();
		}
	}

	/** The socket is gone; no answer will come for what was being decided. */
	function abandonRuns(): void {
		runs.clear();
		if (!state.approvalRun) return;
		state = {
			...state,
			approvalNotice: {
				kind: "disconnected",
				decision: state.approvalRun.decision,
			},
			approvalRun: null,
		};
		publish();
	}

	function clearTimers(): void {
		for (const handle of [helloTimer, livenessTimer, pongTimer]) {
			if (handle !== null) clearTimeoutFn(handle);
		}
		helloTimer = livenessTimer = pongTimer = null;
	}

	function armLiveness(): void {
		if (livenessTimer !== null) clearTimeoutFn(livenessTimer);
		if (pongTimer !== null) {
			clearTimeoutFn(pongTimer);
			pongTimer = null;
		}
		livenessTimer = setTimeoutFn(() => {
			livenessTimer = null;
			if (!send({ type: "ping" })) return;
			pongTimer = setTimeoutFn(() => {
				pongTimer = null;
				dropSocket("silent");
			}, WORKSPACE_CHAT_PONG_TIMEOUT_MS);
		}, WORKSPACE_CHAT_LIVENESS_IDLE_MS);
	}

	function dropSocket(reason: string): void {
		const current = socket;
		socket = null;
		clearTimers();
		abandonRuns();
		if (current) {
			current.onopen =
				current.onmessage =
				current.onclose =
				current.onerror =
					null;
			try {
				current.close(4000, reason);
			} catch {
				// Already gone.
			}
		}
		scheduleReconnect();
	}

	/** True/false when the Worker answered, null when the probe itself failed. */
	async function probeLane(): Promise<boolean | null> {
		try {
			const response = await fetchFn(url.replace(/^ws/, "http"));
			if (!response.ok) return null;
			const body = (await response.json()) as { available?: unknown };
			return typeof body.available === "boolean" ? body.available : null;
		} catch {
			return null;
		}
	}

	function scheduleReconnect(): void {
		if (closed) return;
		// A connection that lived a while earns an instant retry (reference
		// runtime); only repeated failures climb the ladder.
		const livedLong = openedAt > 0 && nowFn() - openedAt > 5_000;
		if (livedLong) attempt = 0;
		openedAt = 0;
		const delay =
			attempt === 0 && livedLong ? 0 : nextBackoffDelayMs(attempt, randomFn);
		attempt += 1;
		setConnection({
			phase: "reconnecting",
			attempt,
			nextTryAt: nowFn() + delay,
		});
		retryTimer = setTimeoutFn(() => {
			retryTimer = null;
			establish();
		}, delay);
	}

	function establish(): void {
		if (closed) return;
		if (connection.phase !== "reconnecting")
			setConnection({ phase: "connecting", attempt });
		const from = resumeCursor();
		let candidate: SocketLike;
		try {
			// The cursor rides on the URL too, so the object can start its replay
			// before the first frame arrives.
			candidate = createSocket(from === null ? url : `${url}?after=${from}`);
		} catch {
			scheduleReconnect();
			return;
		}
		socket = candidate;
		catchingUp = true;
		sawOpen = false;
		candidate.onopen = () => {
			if (socket !== candidate) return;
			sawOpen = true;
			// Subscribe before anything else, so no frame falls into a gap.
			send({ type: "subscribe", conversationId, cursor: from });
			helloTimer = setTimeoutFn(() => {
				helloTimer = null;
				if (socket === candidate) dropSocket("no hello");
			}, WORKSPACE_CHAT_HELLO_TIMEOUT_MS);
		};
		candidate.onmessage = (event) => {
			if (socket !== candidate) return;
			const message = parseWorkspaceChatServerMessage(event.data);
			if (!message) return;
			handle(message);
		};
		candidate.onclose = () => {
			if (socket !== candidate) return;
			socket = null;
			clearTimers();
			abandonRuns();
			if (!sawOpen && connection.phase !== "open") {
				// Failed before the handshake: ask the Worker whether this origin
				// has an object lane at all before climbing the ladder.
				void probeLane().then((available) => {
					if (closed) return;
					if (available === false) setConnection({ phase: "unavailable" });
					else scheduleReconnect();
				});
				return;
			}
			scheduleReconnect();
		};
		candidate.onerror = () => {
			// `onclose` follows; nothing to do here.
		};
	}

	function notifyOutputChanges(events: readonly WorkspaceChatLedgerEvent[]) {
		for (const event of events) {
			// An approved write lands after its step has finished.
			if (
				event.conversationId === conversationId &&
				event.type === "approval.executed" &&
				event.status === "applied"
			)
				options.onOutputChanged?.();
			if (
				event.conversationId !== conversationId ||
				event.type !== "step.finished"
			)
				continue;
			const key = `${event.turnId}:${event.stepId}`;
			if ((completedSteps.get(key)?.seq ?? -1) < event.seq)
				completedSteps.set(key, event);
		}
		for (const [key, event] of completedSteps) {
			if (event.status !== "ok" || notifiedOutputSteps.has(key)) continue;
			const step = state.turns
				.find((turn) => turn.turnId === event.turnId)
				?.steps.find((item) => item.stepId === event.stepId);
			if (
				step?.kind === "write" &&
				["outputs.", "documents.", "sheets.", "presentations.", "apps."].some(
					(prefix) => step.tool?.startsWith(prefix),
				)
			) {
				notifiedOutputSteps.add(key);
				options.onOutputChanged?.();
			}
		}
	}

	function handle(message: WorkspaceChatServerMessage): void {
		armLiveness();
		if (isLedgerEvent(message)) {
			// sendTurn persists and broadcasts before turn.accepted names the draft.
			if (conversationId === null && state.pendingSend)
				draftEvents.push(message);
			const next = applyWorkspaceChatEvent(state, message);
			if (next !== state) {
				state = next;
				notifyOutputChanges([message]);
				if (message.type === "assistant.delta") scheduleRender();
				else publish();
			}
			return;
		}
		switch (message.type) {
			case "hello": {
				if (helloTimer !== null) {
					clearTimeoutFn(helloTimer);
					helloTimer = null;
				}
				attempt = 0;
				openedAt = nowFn();
				if (state.cursor !== null && message.cursor < state.cursor) {
					// The object's ledger is shorter than what this tab folded: it
					// was reset or replaced. Local state is stale, start over.
					state = {
						...initialWorkspaceChatState(conversationId),
						pendingSend: state.pendingSend,
					};
					draftEvents = [];
					completedSteps.clear();
					notifiedOutputSteps.clear();
					replayCursor = null;
					send({ type: "subscribe", conversationId, cursor: null });
				}
				state = {
					...setWaitingApprovals(
						setWorkspaceUsage(
							setConversations(state, [
								...message.conversations,
								...(message.archived ?? []),
							]),
							message.usage,
							message.cursor,
						),
						message.waiting,
					),
					models: message.models ?? [],
				};
				if (state.lastError?.code === "not_connected")
					state = { ...state, lastError: null };
				setConnection({ phase: "open", since: openedAt });
				for (const queued of outbox.values()) send(queued);
				return;
			}
			case "conversation.deleted":
				state = setWorkspaceUsage(
					removeConversation(state, message.conversationId),
					message.usage,
					message.cursor,
				);
				publish();
				return;
			case "caught_up":
				if (message.conversationId !== conversationId) return;
				replayCursor = null;
				catchingUp = false;
				publish();
				return;
			case "replay.more":
				if (message.conversationId !== conversationId) return;
				replayCursor = message.cursor;
				send({ type: "subscribe", conversationId, cursor: message.cursor });
				return;
			case "turn.accepted": {
				outbox.delete(message.clientTurnId);
				if (
					conversationId === null &&
					state.pendingSend?.clientTurnId === message.clientTurnId
				) {
					conversationId = message.conversationId;
					state = applyWorkspaceChatEvents(
						{ ...state, conversationId },
						draftEvents,
					);
					notifyOutputChanges(draftEvents);
					draftEvents = [];
					replayCursor = null;
					send({ type: "subscribe", conversationId, cursor: state.cursor });
				}
				publish();
				return;
			}
			case "ledger.page": {
				if (message.conversationId !== conversationId) return;
				state = setHasEarlier(
					applyWorkspaceChatEvents(state, message.events),
					message.hasMore,
				);
				notifyOutputChanges(message.events);
				publish();
				return;
			}
			case "approvals.decided": {
				const run = message.runId ? runs.get(message.runId) : undefined;
				if (message.runId) runs.delete(message.runId);
				const request = message.stopped
					? (run?.requests.find(
							(item) => item.approvalId === message.stopped?.approvalId,
						) ?? null)
					: (run?.requests[0] ?? null);
				const notice: ApprovalNotice | null = message.stopped
					? {
							kind: "stopped",
							decision: message.decision,
							total: message.total,
							done: message.done,
							request,
							reason: message.stopped.reason,
							...(message.stopped.error
								? { error: message.stopped.error }
								: {}),
						}
					: message.total === 1 && message.alreadyDecided === 1
						? { kind: "already_decided", request }
						: null;
				const ownRun = state.approvalRun?.runId === message.runId;
				if (!ownRun && !notice) return;
				state = {
					...state,
					...(ownRun ? { approvalRun: null } : {}),
					...(notice ? { approvalNotice: notice } : {}),
				};
				publish();
				return;
			}
			case "pong":
				return;
			case "error":
				if (message.clientTurnId) {
					outbox.delete(message.clientTurnId);
					if (
						state.pendingSend &&
						state.pendingSend.clientTurnId !== message.clientTurnId
					)
						return;
				}
				state = markSendFailed(state, {
					code: message.code,
					message: message.message,
					clientTurnId: message.clientTurnId,
				});
				// An error that is not about a message may be the run's: the
				// object answers a run it could not carry out with an error, so
				// the tray must not keep showing one that will never finish.
				if (!message.clientTurnId && state.approvalRun) {
					runs.delete(state.approvalRun.runId);
					state = { ...state, approvalRun: null };
				}
				publish();
				return;
		}
	}

	establish();

	return {
		getSnapshot: () => snapshot,
		getConversationId: () => conversationId,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		sendTurn(input) {
			if (input.newConversation) {
				conversationId = null;
				draftEvents = [];
				state = {
					...initialWorkspaceChatState(null),
					cursor: state.cursor,
					conversations: state.conversations,
					models: state.models,
				};
				replayCursor = null;
				send({ type: "subscribe", conversationId: null, cursor: state.cursor });
			}
			const clientTurnId = newId();
			state = markPendingSend(state, {
				clientTurnId,
				text: input.text,
				sentAt: nowFn(),
			});
			publish();
			const message: Extract<
				WorkspaceChatClientMessage,
				{ type: "send_turn" }
			> = {
				type: "send_turn",
				clientTurnId,
				conversationId,
				text: input.text,
				tediId: input.tediId,
				...(input.answerer ? { answerer: input.answerer } : {}),
				...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
				attachments: input.attachments,
				...(input.fromAppId ? { fromAppId: input.fromAppId } : {}),
			};
			outbox.set(clientTurnId, message);
			if (!send(message)) {
				state = {
					...state,
					lastError: {
						code: "not_connected",
						message:
							"Reconnecting to the workspace. Your message goes out as soon as it is back.",
					},
				};
				publish();
			}
			return clientTurnId;
		},
		decideApproval(approvalId, decision) {
			decide([approvalId], decision);
		},
		decideApprovals(approvalIds, decision) {
			if (approvalIds.length === 0) return;
			decide(approvalIds, decision);
		},
		dismissApprovalNotice() {
			if (!state.approvalNotice) return;
			state = { ...state, approvalNotice: null };
			publish();
		},
		cancelTurn(turnId) {
			send({ type: "cancel_turn", turnId });
		},
		changeConversation(change) {
			send(change);
		},
		loadEarlier() {
			if (!conversationId) return;
			const lowest = lowestSeq(state);
			if (lowest === null) return;
			send({
				type: "read_ledger",
				conversationId,
				before: lowest,
				limit: WORKSPACE_CHAT_HISTORY_PAGE,
			});
		},
		retry() {
			if (closed || socket) return;
			if (retryTimer !== null) {
				clearTimeoutFn(retryTimer);
				retryTimer = null;
			}
			attempt = 0;
			establish();
		},
		forceDrop() {
			dropSocket("forced");
		},
		close() {
			closed = true;
			if (retryTimer !== null) clearTimeoutFn(retryTimer);
			const current = socket;
			socket = null;
			clearTimers();
			if (current) {
				current.onclose = null;
				try {
					current.close(1000, "closed");
				} catch {
					// Already gone.
				}
			}
			setConnection({ phase: "closed" });
		},
	};
}

function lowestSeq(state: WorkspaceChatState): number | null {
	let lowest: number | null = null;
	for (const seq of state.seen) {
		if (lowest === null || seq < lowest) lowest = seq;
	}
	return lowest;
}
