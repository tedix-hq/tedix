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

function harness(laneAvailable: boolean | null = true) {
	const sockets: FakeSocket[] = [];
	let now = 1_000_000;
	let timers: Timer[] = [];
	let nextId = 1;
	const client = createWorkspaceChatClient({
		workspaceId: "ws-1",
		conversationId: "c1",
		origin: "http://localhost",
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
		newId: () => "client-turn",
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

	it("posts approval decisions and cancellations to the object", () => {
		const { client, sockets, hello } = harness();
		const socket = sockets[0]!;
		socket.open();
		hello(socket);
		client.decideApproval("a1", "approve");
		client.cancelTurn("t1");
		expect(socket.sent.slice(-2)).toEqual([
			{ type: "decide_approval", approvalId: "a1", decision: "approve" },
			{ type: "cancel_turn", turnId: "t1" },
		]);
	});
});
