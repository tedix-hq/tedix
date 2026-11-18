import { describe, expect, it } from "vite-plus/test";
import {
	createWorkspaceChatClient,
	type SocketLike,
	WORKSPACE_CHAT_LIVENESS_IDLE_MS,
	WORKSPACE_CHAT_PONG_TIMEOUT_MS,
} from "./workspace-chat-client";
import type {
	WorkspaceChatClientMessage,
	WorkspaceChatServerMessage,
} from "./workspace-chat-protocol";

class FakeSocket implements SocketLike {
	readyState = 0;
	sent: WorkspaceChatClientMessage[] = [];
	onopen: ((event: unknown) => void) | null = null;
	onmessage: ((event: { data: unknown }) => void) | null = null;
	onclose: ((event: { code?: number; reason?: string }) => void) | null = null;
	onerror: ((event: unknown) => void) | null = null;
	closedWith: { code?: number; reason?: string } | null = null;
	send(data: string) {
		this.sent.push(JSON.parse(data) as WorkspaceChatClientMessage);
	}
	close(code?: number, reason?: string) {
		this.readyState = 3;
		this.closedWith = { code, reason };
	}
	open() {
		this.readyState = 1;
		this.onopen?.({});
	}
	receive(message: WorkspaceChatServerMessage) {
		this.onmessage?.({ data: JSON.stringify(message) });
	}
	drop() {
		this.readyState = 3;
		this.onclose?.({ code: 1006 });
	}
}

type Timer = { callback: () => void; at: number; id: number };

function harness(
	laneAvailable: boolean | null = true,
	onOutputChanged?: () => void,
	newId = () => "client-turn",
) {
	const sockets: FakeSocket[] = [];
	let now = 1_000_000;
	let timers: Timer[] = [];
	let nextId = 1;
	const client = createWorkspaceChatClient({
		workspaceId: "ws-1",
		conversationId: "c1",
		origin: "http://localhost",
		onOutputChanged,
		createSocket: () => {
			const socket = new FakeSocket();
			sockets.push(socket);
			return socket;
		},
		setTimeoutFn: (callback, ms) => {
			const id = nextId++;
			timers.push({ callback, at: now + ms, id });
			return id;
		},
		clearTimeoutFn: (handle) => {
			timers = timers.filter((timer) => timer.id !== handle);
		},
		nowFn: () => now,
		randomFn: () => 0.5,
		newId,
		fetchFn: async () =>
			laneAvailable === null
				? { ok: false, json: async () => ({}) }
				: { ok: true, json: async () => ({ available: laneAvailable }) },
		scheduleFrame: (callback) => {
			timers.push({ callback, at: now + 16, id: nextId++ });
		},
	});
	const advance = (ms: number) => {
		const target = now + ms;
		for (;;) {
			const due = timers
				.filter((timer) => timer.at <= target)
				.sort((a, b) => a.at - b.at);
			if (due.length === 0) break;
			const next = due[0]!;
			timers = timers.filter((timer) => timer.id !== next.id);
			now = next.at;
			next.callback();
		}
		now = target;
	};
	const hello = (socket: FakeSocket, cursor = 0) =>
		socket.receive({
			type: "hello",
			waiting: [],
			cursor,
			serverTime: new Date(now).toISOString(),
			conversations: [],
		});
	return { client, sockets, advance, hello, timers: () => timers };
}

const delta = (
	seq: number,
	text: string,
): Extract<WorkspaceChatServerMessage, { type: "assistant.delta" }> => ({
	type: "assistant.delta",
	seq,
	at: "2026-11-07T12:00:00.000Z",
	conversationId: "c1",
	turnId: "t1",
	messageId: "m1",
	text,
});

describe("createWorkspaceChatClient", () => {
	it("restores persisted conversation summaries on reconnect without needing their creation events", () => {
		const { client, sockets, advance } = harness();
		const conversations = [
			{
				id: "c1",
				title: "Saved chat",
				updatedAt: "2026-11-07T12:00:00.000Z",
				lastTurnAt: "2026-11-07T12:00:00.000Z",
			},
		];
		const hello = {
			type: "hello" as const,
			waiting: [],
			cursor: 40,
			serverTime: "2026-11-07T12:00:00.000Z",
			conversations,
		};
		const first = sockets[0]!;
		first.open();
		first.receive(hello);
		expect(client.getSnapshot().state.conversations).toEqual(conversations);
		advance(6_000);
		first.drop();
		advance(0);
		const second = sockets[1]!;
		second.open();
		second.receive({
			...hello,
			conversations: [
				...conversations,
				{ ...conversations[0]!, id: "c2", title: "Another saved chat" },
			],
		});
		expect(
			client.getSnapshot().state.conversations.map((row) => row.title),
		).toEqual(["Saved chat", "Another saved chat"]);
		expect(client.getSnapshot().state.turns).toEqual([]);
	});

	it("subscribes with no cursor first, and only counts as open after hello", () => {
		const { client, sockets, hello } = harness();
		expect(client.getSnapshot().connection.phase).toBe("connecting");
		const socket = sockets[0]!;
		socket.open();
		expect(socket.sent[0]).toEqual({
			type: "subscribe",
			conversationId: "c1",
			cursor: null,
		});
		expect(client.getSnapshot().connection.phase).toBe("connecting");
		hello(socket);
		expect(client.getSnapshot().connection.phase).toBe("open");
	});

	it("resubscribes from its cursor after a drop and folds nothing twice", () => {
		const { client, sockets, hello, advance } = harness();
		const first = sockets[0]!;
		first.open();
		hello(first);
		first.receive({
			type: "turn.started",
			seq: 1,
			at: "2026-11-07T12:00:00.000Z",
			conversationId: "c1",
			turnId: "t1",
			text: "hi",
			authorId: "p",
			authorKind: "person",
		});
		first.receive(delta(2, "Hel"));
		advance(20);
		expect(client.getSnapshot().state.turns[0]?.reply).toBe("Hel");

		advance(6_000);
		first.drop();
		const after = client.getSnapshot();
		expect(after.connection.phase).toBe("reconnecting");
		// The timer keeps its source: the last event time survives the drop.
		expect(after.state.lastEventAt).toBe(
			Date.parse("2026-11-07T12:00:00.000Z"),
		);

		// A socket that lived a while retries at once.
		advance(0);
		const second = sockets[1]!;
		expect(second).toBeDefined();
		second.open();
		expect(second.sent[0]).toEqual({
			type: "subscribe",
			conversationId: "c1",
			cursor: 2,
		});
		hello(second, 3);
		// The object replays from the cursor; an overlap is harmless.
		second.receive(delta(2, "Hel"));
		second.receive(delta(3, "lo"));
		advance(20);
		expect(client.getSnapshot().connection.phase).toBe("open");
		expect(client.getSnapshot().state.turns[0]?.reply).toBe("Hello");
	});

	it("asks for each next page of a long replay and resumes a dropped one where it stopped", () => {
		const { client, sockets, hello, advance } = harness();
		const first = sockets[0]!;
		first.open();
		hello(first, 9);
		first.receive(delta(1, "a"));
		// Another conversation's replay is not this tab's to continue.
		first.receive({ type: "replay.more", cursor: 1, conversationId: "other" });
		expect(first.sent).toHaveLength(1);
		first.receive({ type: "replay.more", cursor: 1, conversationId: "c1" });
		expect(first.sent.at(-1)).toEqual({
			type: "subscribe",
			conversationId: "c1",
			cursor: 1,
		});
		expect(client.getSnapshot().catchingUp).toBe(true);
		// A live frame runs ahead of the replay, then the socket drops.
		first.receive(delta(9, "z"));
		advance(6_000);
		first.drop();
		advance(0);
		const second = sockets[1]!;
		second.open();
		expect(second.sent[0]).toEqual({
			type: "subscribe",
			conversationId: "c1",
			cursor: 1,
		});
		hello(second, 9);
		second.receive(delta(2, "b"));
		second.receive({ type: "caught_up", conversationId: "c1" });
		advance(20);
		expect(client.getSnapshot().catchingUp).toBe(false);
		expect(client.getSnapshot().state.turns[0]?.reply).toBe("abz");
		// Caught up: the next drop resumes from the newest folded event.
		advance(6_000);
		second.drop();
		advance(0);
		const third = sockets[2]!;
		third.open();
		expect(third.sent[0]).toEqual({
			type: "subscribe",
			conversationId: "c1",
			cursor: 9,
		});
	});

	it("climbs the backoff ladder while the object stays away", () => {
		const { client, sockets, advance } = harness();
		sockets[0]!.open();
		sockets[0]!.drop();
		const firstWait = client.getSnapshot().connection;
		expect(firstWait.phase).toBe("reconnecting");
		advance(60_000);
		sockets.at(-1)!.open();
		sockets.at(-1)!.drop();
		const secondWait = client.getSnapshot().connection;
		expect(secondWait.phase).toBe("reconnecting");
		expect(secondWait.phase === "reconnecting" && secondWait.attempt).toBe(2);
		expect(sockets.length).toBe(2);
	});

	it("parks on 'unavailable' when the origin has no object lane, until retry", async () => {
		const { client, sockets, hello } = harness(false);
		sockets[0]!.drop();
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		expect(client.getSnapshot().connection.phase).toBe("unavailable");
		expect(sockets).toHaveLength(1);
		client.retry();
		expect(sockets).toHaveLength(2);
		sockets[1]!.open();
		hello(sockets[1]!);
		expect(client.getSnapshot().connection.phase).toBe("open");
	});

	it("keeps climbing the ladder when a failed handshake cannot be explained", async () => {
		const { client, sockets, advance } = harness(null);
		sockets[0]!.drop();
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		expect(client.getSnapshot().connection.phase).toBe("reconnecting");
		advance(60_000);
		expect(sockets).toHaveLength(2);
	});

	it("pings a silent socket and drops it when no pong comes", () => {
		const { client, sockets, hello, advance } = harness();
		const socket = sockets[0]!;
		socket.open();
		hello(socket);
		advance(WORKSPACE_CHAT_LIVENESS_IDLE_MS);
		expect(socket.sent.at(-1)).toEqual({ type: "ping" });
		advance(WORKSPACE_CHAT_PONG_TIMEOUT_MS);
		expect(socket.closedWith?.reason).toBe("silent");
		expect(client.getSnapshot().connection.phase).toBe("reconnecting");
	});

	it("keeps the configured model on a request and its reconnect retry", () => {
		const { client, sockets, hello, advance } = harness();
		const first = sockets[0]!;
		first.open();
		first.receive({
			type: "hello",
			waiting: [],
			cursor: 0,
			serverTime: "2026-11-07T12:00:00Z",
			conversations: [],
			models: [
				{ id: "azure-openai/configured", label: "Configured deployment" },
			],
		});
		expect(client.getSnapshot().state.models).toEqual([
			{ id: "azure-openai/configured", label: "Configured deployment" },
		]);
		client.sendTurn({
			text: "Use this model",
			modelId: "azure-openai/configured",
		});
		const request = first.sent.at(-1);
		expect(request).toMatchObject({
			type: "send_turn",
			modelId: "azure-openai/configured",
		});
		first.drop();
		advance(60_000);
		const second = sockets[1]!;
		second.open();
		hello(second);
		expect(second.sent.at(-1)).toEqual(request);
		client.close();
	});

	it("sends a turn with a client id and shows it as pending until echoed", () => {
		const { client, sockets, hello } = harness();
		const socket = sockets[0]!;
		socket.open();
		hello(socket);
		const id = client.sendTurn({ text: "Count them" });
		expect(id).toBe("client-turn");
		expect(socket.sent.at(-1)).toMatchObject({
			type: "send_turn",
			clientTurnId: "client-turn",
			text: "Count them",
		});
		expect(client.getSnapshot().state.pendingSend?.text).toBe("Count them");
		socket.receive({
			type: "turn.accepted",
			clientTurnId: "client-turn",
			turnId: "t9",
			conversationId: "c1",
		});
		socket.receive({
			type: "turn.started",
			seq: 1,
			at: "2026-11-07T12:00:00.000Z",
			conversationId: "c1",
			turnId: "t9",
			text: "Count them",
			authorId: "p",
			authorKind: "person",
		});
		expect(client.getSnapshot().state.pendingSend).toBeNull();
	});

	it("correlates a rejected send with its draft without resending it", () => {
		const { client, sockets, hello, advance } = harness();
		const socket = sockets[0]!;
		socket.open();
		hello(socket);
		const clientTurnId = client.sendTurn({
			text: "Read this",
			attachments: [{ outputId: "unavailable" }],
		});
		socket.receive({
			type: "error",
			code: "failed",
			message: "File unavailable",
			clientTurnId,
		});
		expect(client.getSnapshot().state.lastError).toEqual({
			code: "failed",
			message: "File unavailable",
			clientTurnId,
		});
		expect(client.getSnapshot().state.pendingSend).toBeNull();
		advance(6_000);
		socket.drop();
		advance(0);
		const replacement = sockets[1]!;
		replacement.open();
		hello(replacement);
		expect(replacement.sent.some((frame) => frame.type === "send_turn")).toBe(
			false,
		);
	});

	it("holds a turn written during a drop and sends it once the object is back", () => {
		const { client, sockets, hello, advance } = harness();
		const first = sockets[0]!;
		first.open();
		hello(first);
		advance(6_000);
		first.drop();
		client.sendTurn({ text: "While away" });
		expect(client.getSnapshot().state.pendingSend?.text).toBe("While away");
		expect(client.getSnapshot().state.lastError?.code).toBe("not_connected");
		advance(0);
		const second = sockets[1]!;
		second.open();
		hello(second);
		expect(second.sent.at(-1)).toMatchObject({
			type: "send_turn",
			text: "While away",
		});
		expect(client.getSnapshot().state.lastError).toBeNull();
	});

	it("starts over when the object's cursor is behind what it already folded", () => {
		const { client, sockets, hello, advance } = harness();
		const first = sockets[0]!;
		first.open();
		hello(first);
		first.receive(delta(5, "old"));
		advance(6_000);
		first.drop();
		advance(0);
		const second = sockets[1]!;
		second.open();
		hello(second, 0);
		expect(second.sent.at(-1)).toEqual({
			type: "subscribe",
			conversationId: "c1",
			cursor: null,
		});
		expect(client.getSnapshot().state.turns).toHaveLength(0);
		second.receive(delta(1, "new"));
		advance(20);
		expect(client.getSnapshot().state.turns[0]?.reply).toBe("new");
	});

	it("adopts the conversation the object assigns to a first turn", () => {
		const sockets: FakeSocket[] = [];
		const client = createWorkspaceChatClient({
			workspaceId: "ws-1",
			conversationId: null,
			origin: "http://localhost",
			createSocket: () => {
				const socket = new FakeSocket();
				sockets.push(socket);
				return socket;
			},
			setTimeoutFn: () => 0,
			clearTimeoutFn: () => {},
		});
		sockets[0]!.open();
		const clientTurnId = client.sendTurn({ text: "First" });
		sockets[0]!.receive({
			type: "turn.accepted",
			clientTurnId,
			turnId: "t1",
			conversationId: "conv-new",
		});
		expect(client.getConversationId()).toBe("conv-new");
	});

	it("resends the same turn id after a lost acceptance without losing its first prompt", () => {
		const { client, sockets, hello, advance } = harness();
		const first = sockets[0]!;
		first.open();
		hello(first);
		client.sendTurn({ text: "First prompt", newConversation: true });
		const original = first.sent.at(-1);
		first.receive({
			type: "turn.started",
			seq: 1,
			at: "2026-11-07T12:00:00.000Z",
			conversationId: "new",
			turnId: "client-turn",
			text: "First prompt",
			authorId: "person",
			authorKind: "person",
		});
		first.receive({
			...delta(2, "Reply"),
			conversationId: "new",
			turnId: "client-turn",
		});
		advance(6000);
		first.drop();
		advance(0);
		const second = sockets[1]!;
		second.open();
		hello(second, 2);
		expect(second.sent.at(-1)).toEqual(original);
		second.receive({
			type: "turn.accepted",
			clientTurnId: "client-turn",
			turnId: "client-turn",
			conversationId: "new",
		});
		expect(
			client.getSnapshot().state.turns.map((turn) => [turn.text, turn.reply]),
		).toEqual([["First prompt", "Reply"]]);
		advance(6000);
		second.drop();
		advance(0);
		const third = sockets[2]!;
		third.open();
		hello(third, 2);
		expect(
			third.sent.filter((message) => message.type === "send_turn"),
		).toEqual([]);
	});

	it("does not adopt or fail an older send after the person starts another draft", () => {
		let nextId = 0;
		const { client, sockets, hello } = harness(
			true,
			undefined,
			() => `client-${++nextId}`,
		);
		const socket = sockets[0]!;
		socket.open();
		hello(socket);
		client.sendTurn({ text: "Older draft", newConversation: true });
		client.sendTurn({ text: "Selected draft", newConversation: true });
		socket.receive({
			type: "turn.accepted",
			clientTurnId: "client-1",
			turnId: "client-1",
			conversationId: "older",
		});
		socket.receive({
			type: "error",
			clientTurnId: "client-1",
			code: "old",
			message: "Older send failed",
		});
		expect(client.getConversationId()).toBeNull();
		expect(client.getSnapshot().state.pendingSend?.text).toBe("Selected draft");
		expect(client.getSnapshot().state.lastError).toBeNull();
		socket.receive({
			type: "turn.accepted",
			clientTurnId: "client-2",
			turnId: "client-2",
			conversationId: "selected",
		});
		expect(client.getConversationId()).toBe("selected");
	});

	it("keeps a new conversation blank and retains events emitted before acceptance", () => {
		const { client, sockets, hello, advance } = harness();
		const socket = sockets[0]!;
		socket.open();
		hello(socket);
		socket.receive(delta(1, "Old conversation"));
		advance(20);
		client.sendTurn({ text: "First prompt", newConversation: true });
		expect(client.getSnapshot().state.turns).toEqual([]);
		expect(socket.sent.at(-1)).toMatchObject({
			type: "send_turn",
			conversationId: null,
		});
		socket.receive({ ...delta(2, "Unrelated"), conversationId: "other" });
		socket.receive({
			type: "turn.started",
			seq: 3,
			at: "2026-11-07T12:00:00.000Z",
			conversationId: "new",
			turnId: "t-new",
			text: "First prompt",
			authorId: "p",
			authorKind: "person",
		});
		socket.receive({
			...delta(4, "First reply"),
			conversationId: "new",
			turnId: "t-new",
		});
		socket.receive({
			type: "turn.accepted",
			clientTurnId: "someone-else",
			conversationId: "other",
			turnId: "other",
		});
		expect(client.getConversationId()).toBeNull();
		expect(client.getSnapshot().state.turns).toEqual([]);
		socket.receive({
			type: "turn.accepted",
			clientTurnId: "client-turn",
			conversationId: "new",
			turnId: "t-new",
		});
		expect(
			client.getSnapshot().state.turns.map((turn) => [turn.text, turn.reply]),
		).toEqual([["First prompt", "First reply"]]);
		expect(client.getSnapshot().state.pendingSend).toBeNull();
		expect(socket.sent.at(-1)).toEqual({
			type: "subscribe",
			conversationId: "new",
			cursor: 4,
		});
	});

	it("ignores history pages for another selected conversation", () => {
		const { client, sockets, hello } = harness();
		const socket = sockets[0]!;
		socket.open();
		hello(socket);
		socket.receive({
			type: "ledger.page",
			conversationId: "other",
			events: [],
			hasMore: true,
		});
		expect(client.getSnapshot().state.hasEarlier).toBe(false);
	});

	it("refreshes outputs only after an approved write succeeds, including its finished original turn", () => {
		let changes = 0;
		const { sockets, hello } = harness(true, () => {
			changes += 1;
		});
		const socket = sockets[0]!;
		socket.open();
		hello(socket);
		const start: Extract<WorkspaceChatServerMessage, { type: "step.started" }> =
			{
				type: "step.started",
				seq: 1,
				at: "2026-11-07T12:00:00.000Z",
				conversationId: "c1",
				turnId: "original",
				stepId: "held",
				kind: "write",
				tool: "outputs.create",
				label: "Create document",
			};
		socket.receive(start);
		socket.receive({
			type: "approval.requested",
			seq: 2,
			at: start.at,
			conversationId: "c1",
			turnId: "original",
			stepId: "held",
			approvalId: "a1",
			title: "Create document",
			reason: "Approval required",
		});
		socket.receive({
			type: "step.finished",
			seq: 3,
			at: start.at,
			conversationId: "c1",
			turnId: "original",
			stepId: "held",
			status: "error",
			durationMs: 1,
		});
		socket.receive({
			type: "turn.finished",
			seq: 4,
			at: start.at,
			conversationId: "c1",
			turnId: "original",
			status: "done",
			durationMs: 1,
		});
		socket.receive({
			type: "approval.decided",
			seq: 5,
			at: start.at,
			conversationId: "c1",
			approvalId: "a1",
			decision: "approve",
			by: "person",
		});
		expect(changes).toBe(0);
		socket.receive({ ...start, seq: 6, stepId: "applied" });
		const finished: Extract<
			WorkspaceChatServerMessage,
			{ type: "step.finished" }
		> = {
			type: "step.finished",
			seq: 7,
			at: start.at,
			conversationId: "c1",
			turnId: "original",
			stepId: "applied",
			status: "ok",
			durationMs: 1,
		};
		socket.receive(finished);
		expect(changes).toBe(1);
		socket.receive(finished);
		socket.receive({
			...start,
			seq: 8,
			stepId: "read",
			kind: "read",
			tool: "outputs.list",
		});
		socket.receive({ ...finished, seq: 9, stepId: "read" });
		expect(changes).toBe(1);
	});

	it("recognizes successful output writes when earlier pages supply step metadata later", () => {
		let changes = 0;
		const { sockets, hello } = harness(true, () => {
			changes += 1;
		});
		const socket = sockets[0]!;
		socket.open();
		hello(socket);
		const at = "2026-11-07T12:00:00.000Z";
		socket.receive({
			type: "step.finished",
			seq: 2,
			at,
			conversationId: "c1",
			turnId: "t1",
			stepId: "write",
			status: "ok",
			durationMs: 1,
		});
		expect(changes).toBe(0);
		socket.receive({
			type: "ledger.page",
			conversationId: "c1",
			hasMore: false,
			events: [
				{
					type: "step.started",
					seq: 1,
					at,
					conversationId: "c1",
					turnId: "t1",
					stepId: "write",
					kind: "write",
					tool: "outputs.revise",
					label: "Revise document",
				},
			],
		});
		expect(changes).toBe(1);
	});

	it.each([
		["apps", "revise"],
		["documents", "replace"],
		["documents", "edit"],
		["sheets", "replace"],
		["sheets", "edit"],
		["presentations", "replace"],
		["presentations", "edit"],
	])("refreshes files after %s.%s but not reads", (binding, method) => {
		let changes = 0;
		const { sockets, hello } = harness(true, () => {
			changes += 1;
		});
		const socket = sockets[0]!;
		socket.open();
		hello(socket);
		const at = "2026-11-07T12:00:00.000Z";
		socket.receive({
			type: "step.started",
			seq: 1,
			at,
			conversationId: "c1",
			turnId: "t1",
			stepId: "read",
			kind: "read",
			tool: `${binding}.read`,
			label: "Read document",
		});
		socket.receive({
			type: "step.finished",
			seq: 2,
			at,
			conversationId: "c1",
			turnId: "t1",
			stepId: "read",
			status: "ok",
			durationMs: 1,
		});
		expect(changes).toBe(0);
		socket.receive({
			type: "step.started",
			seq: 3,
			at,
			conversationId: "c1",
			turnId: "t1",
			stepId: "write",
			kind: "write",
			tool: `${binding}.${method}`,
			label: "Edit document",
		});
		socket.receive({
			type: "step.finished",
			seq: 4,
			at,
			conversationId: "c1",
			turnId: "t1",
			stepId: "write",
			status: "ok",
			durationMs: 1,
		});
		expect(changes).toBe(1);
	});

	it("posts approval decisions and cancellations to the object", () => {
		const { client, sockets, hello } = harness();
		const socket = sockets[0]!;
		socket.open();
		hello(socket);
		client.decideApproval("a1", "approve");
		client.cancelTurn("t1");
		expect(socket.sent.slice(-2)).toEqual([
			{
				type: "decide_approval",
				approvalId: "a1",
				decision: "approve",
				runId: "client-turn",
			},
			{ type: "cancel_turn", turnId: "t1" },
		]);
	});

	const waitingRequest = (approvalId: string, conversationId: string) => ({
		approvalId,
		conversationId,
		turnId: `t-${approvalId}`,
		stepId: `s-${approvalId}`,
		title: "Editing document blocks",
		reason: "approval_pending",
		target: { id: `out-${approvalId}`, title: `Plan ${approvalId}` },
		at: "2026-11-18T10:00:00.000Z",
	});

	it("keeps the whole workspace's waiting requests, also from other conversations", () => {
		const { client, sockets } = harness();
		const socket = sockets[0]!;
		socket.open();
		socket.receive({
			type: "hello",
			cursor: 10,
			serverTime: "2026-11-18T10:00:00.000Z",
			conversations: [],
			waiting: [waitingRequest("a1", "c1"), waitingRequest("a2", "c2")],
		});
		const waiting = () =>
			client
				.getSnapshot()
				.state.waiting.map((item) => [item.approvalId, item.conversationId]);
		expect(waiting()).toEqual([
			["a1", "c1"],
			["a2", "c2"],
		]);
		// A request the hello already accounted for is not added by a replay.
		socket.receive({
			seq: 4,
			at: "2026-11-18T09:59:00.000Z",
			conversationId: "c2",
			type: "approval.requested",
			turnId: "t-old",
			stepId: "s-old",
			approvalId: "old",
			title: "Editing document blocks",
			reason: "approval_pending",
		});
		socket.receive({
			seq: 11,
			at: "2026-11-18T10:01:00.000Z",
			conversationId: "c3",
			type: "approval.requested",
			turnId: "t3",
			stepId: "s3",
			approvalId: "a3",
			title: "Filing a Work Item",
			reason: "approval_pending",
		});
		socket.receive({
			seq: 12,
			at: "2026-11-18T10:02:00.000Z",
			conversationId: "c2",
			type: "approval.decided",
			approvalId: "a2",
			decision: "deny",
			by: "u2",
		});
		expect(waiting()).toEqual([
			["a1", "c1"],
			["a3", "c3"],
		]);
		socket.receive({
			type: "conversation.deleted",
			conversationId: "c3",
			cursor: 13,
		});
		expect(waiting()).toEqual([["a1", "c1"]]);
	});

	it("shows a run while it works and says where it stopped", () => {
		const { client, sockets } = harness(true, undefined, () => "run-1");
		const socket = sockets[0]!;
		socket.open();
		socket.receive({
			type: "hello",
			cursor: 10,
			serverTime: "2026-11-18T10:00:00.000Z",
			conversations: [],
			waiting: [
				waitingRequest("a1", "c1"),
				waitingRequest("a2", "c2"),
				waitingRequest("a3", "c1"),
			],
		});
		client.decideApprovals(["a1", "a2", "a3"], "approve");
		expect(socket.sent.at(-1)).toEqual({
			type: "decide_approvals",
			approvalIds: ["a1", "a2", "a3"],
			decision: "approve",
			runId: "run-1",
		});
		expect(client.getSnapshot().state.approvalRun).toMatchObject({
			runId: "run-1",
			decision: "approve",
		});
		socket.receive({
			type: "approvals.decided",
			runId: "run-1",
			decision: "approve",
			total: 3,
			done: 1,
			alreadyDecided: 0,
			stopped: { approvalId: "a2", reason: "failed", error: "Stale revision" },
		});
		const { approvalRun, approvalNotice } = client.getSnapshot().state;
		expect(approvalRun).toBeNull();
		expect(approvalNotice).toMatchObject({
			kind: "stopped",
			decision: "approve",
			total: 3,
			done: 1,
			reason: "failed",
			error: "Stale revision",
			request: { approvalId: "a2", conversationId: "c2" },
		});
		client.dismissApprovalNotice();
		expect(client.getSnapshot().state.approvalNotice).toBeNull();
	});

	it("tells the person when someone else had already decided", () => {
		const { client, sockets } = harness(true, undefined, () => "run-1");
		const socket = sockets[0]!;
		socket.open();
		socket.receive({
			type: "hello",
			cursor: 10,
			serverTime: "2026-11-18T10:00:00.000Z",
			conversations: [],
			waiting: [waitingRequest("a1", "c1")],
		});
		client.decideApproval("a1", "approve");
		expect(client.getSnapshot().state.approvalRun).toBeNull();
		socket.receive({
			type: "approvals.decided",
			runId: "run-1",
			decision: "approve",
			total: 1,
			done: 0,
			alreadyDecided: 1,
		});
		expect(client.getSnapshot().state.approvalNotice).toMatchObject({
			kind: "already_decided",
			request: { approvalId: "a1" },
		});
	});

	it("ends a run the object answered with an error", () => {
		const { client, sockets } = harness(true, undefined, () => "run-1");
		const socket = sockets[0]!;
		socket.open();
		socket.receive({
			type: "hello",
			cursor: 10,
			serverTime: "2026-11-18T10:00:00.000Z",
			conversations: [],
			waiting: [waitingRequest("a1", "c1"), waitingRequest("a2", "c1")],
		});
		client.decideApprovals(["a1", "a2"], "approve");
		expect(client.getSnapshot().state.approvalRun).not.toBeNull();
		socket.receive({
			type: "error",
			code: "failed",
			message: "Unknown approval",
		});
		expect(client.getSnapshot().state).toMatchObject({
			approvalRun: null,
			lastError: { message: "Unknown approval" },
		});
	});

	it("ends a run with a notice when the connection drops under it", () => {
		const { client, sockets } = harness(true, undefined, () => "run-1");
		const socket = sockets[0]!;
		socket.open();
		socket.receive({
			type: "hello",
			cursor: 10,
			serverTime: "2026-11-18T10:00:00.000Z",
			conversations: [],
			waiting: [waitingRequest("a1", "c1"), waitingRequest("a2", "c1")],
		});
		client.decideApprovals(["a2", "a1"], "deny");
		socket.drop();
		expect(client.getSnapshot().state).toMatchObject({
			approvalRun: null,
			approvalNotice: { kind: "disconnected", decision: "deny" },
		});
	});
});
