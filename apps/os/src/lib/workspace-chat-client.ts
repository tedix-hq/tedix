/**
 * The browser side of a workspace object's chat lane.
 *
 * One socket per open workspace chat. It subscribes with the last folded seq,
 * folds replay and live frames through the same reducer, and when the socket
 * drops it reconnects on the shared backoff ladder (`nextBackoffDelayMs`) with
 * the cursor it already has. Nothing is lost on a drop: the object replays the
 * gap. The UI shows "Reconnecting" while this runs and never a dead end.
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
	type WorkspaceChatServerMessage,
	workspaceChatSocketUrl,
} from "./workspace-chat-protocol";
import {
	applyWorkspaceChatEvent,
	applyWorkspaceChatEvents,
	initialWorkspaceChatState,
	markPendingSend,
	markSendFailed,
	setConversations,
	setHasEarlier,
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
	/** Batches token renders; defaults to an animation frame. */
	scheduleFrame?: (callback: () => void) => void;
};

export type WorkspaceChatClient = {
	getSnapshot(): WorkspaceChatSnapshot;
	/** The conversation this socket follows; set by the object on the first turn. */
	getConversationId(): string | null;
	subscribe(listener: () => void): () => void;
	/** Returns the client turn id; the object echoes it in `turn.accepted`. */
	sendTurn(input: {
		text: string;
		tediId?: string;
		attachments?: Array<{ outputId: string }>;
	}): string;
	decideApproval(approvalId: string, decision: ApprovalDecision): void;
	cancelTurn(turnId: string): void;
	loadEarlier(): void;
	/** Drop the socket now; the ladder reconnects. Used by the drop test. */
	forceDrop(): void;
	close(): void;
};

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
	let snapshot: WorkspaceChatSnapshot = { state, connection, catchingUp };
	const listeners = new Set<() => void>();

	let socket: SocketLike | null = null;
	let closed = false;
	let attempt = 0;
	let openedAt = 0;
	let retryTimer: unknown = null;
	let helloTimer: unknown = null;
	let livenessTimer: unknown = null;
	let pongTimer: unknown = null;
	/**
	 * Turns written while the socket is away. They go out in order as soon as
	 * the object says hello again, so a send during a blink is never lost.
	 */
	const outbox: WorkspaceChatClientMessage[] = [];
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
		let candidate: SocketLike;
		try {
			candidate = createSocket(url);
		} catch {
			scheduleReconnect();
			return;
		}
		socket = candidate;
		catchingUp = true;
		candidate.onopen = () => {
			if (socket !== candidate) return;
			// Subscribe before anything else, so no frame falls into a gap.
			send({ type: "subscribe", conversationId, cursor: state.cursor });
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
			scheduleReconnect();
		};
		candidate.onerror = () => {
			// `onclose` follows; nothing to do here.
		};
	}

	function handle(message: WorkspaceChatServerMessage): void {
		armLiveness();
		if (isLedgerEvent(message)) {
			const next = applyWorkspaceChatEvent(state, message);
			if (next !== state) {
				state = next;
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
					state = initialWorkspaceChatState(conversationId);
					send({ type: "subscribe", conversationId, cursor: null });
				}
				state = setConversations(state, message.conversations);
				if (state.lastError?.code === "not_connected")
					state = { ...state, lastError: null };
				setConnection({ phase: "open", since: openedAt });
				for (const queued of outbox.splice(0)) send(queued);
				return;
			}
			case "caught_up":
				catchingUp = false;
				publish();
				return;
			case "turn.accepted": {
				if (conversationId === null) {
					conversationId = message.conversationId;
					state = { ...state, conversationId };
				}
				publish();
				return;
			}
			case "ledger.page": {
				state = setHasEarlier(
					applyWorkspaceChatEvents(state, message.events),
					message.hasMore,
				);
				publish();
				return;
			}
			case "pong":
				return;
			case "error":
				state = markSendFailed(state, {
					code: message.code,
					message: message.message,
				});
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
			const clientTurnId = newId();
			state = markPendingSend(state, {
				clientTurnId,
				text: input.text,
				sentAt: nowFn(),
			});
			publish();
			const message: WorkspaceChatClientMessage = {
				type: "send_turn",
				clientTurnId,
				conversationId,
				text: input.text,
				tediId: input.tediId,
				attachments: input.attachments,
			};
			if (!send(message)) {
				outbox.push(message);
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
			send({ type: "decide_approval", approvalId, decision });
		},
		cancelTurn(turnId) {
			send({ type: "cancel_turn", turnId });
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
