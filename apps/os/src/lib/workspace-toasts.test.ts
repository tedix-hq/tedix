import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
	askedConversations,
	conversationOnScreen,
	noteChatAsked,
	rememberHandled,
	resetWorkspaceToasts,
	showConversationOnScreen,
	shownEvents,
	waitingForReplyElsewhere,
	workspaceToasts,
} from "./workspace-toasts";

const WS = "ws-1";
const item = (
	id: string,
	kind: "agent_reply" | "needs_decision" | "message" | "agent_stopped" | "file",
	conversationId?: string,
) => ({
	id,
	kind,
	byAgent: kind !== "message",
	actorId: "tedi-1",
	occurredAt: "2026-11-18T10:00:00.000Z",
	...(conversationId ? { conversationId } : {}),
});
const list = (...items: ReturnType<typeof item>[]) => ({
	total: items.length,
	groups: [
		{
			workspaceId: WS,
			workspaceName: "Launch",
			latestAt: "2026-11-18T10:00:00.000Z",
			items,
		},
	],
});
const nothing = {
	shown: new Set<string>(),
	asked: new Set<string>(),
	viewing: null,
};

afterEach(() => {
	vi.restoreAllMocks();
	resetWorkspaceToasts();
});

describe("workspaceToasts", () => {
	it("announces a reply only in a conversation the person asked in", () => {
		const unread = list(
			item("7", "agent_reply", "chat-1"),
			item("6", "agent_reply", "chat-2"),
		);
		const found = workspaceToasts(unread, {
			...nothing,
			asked: new Set([`${WS}:chat-1`]),
		});
		expect(found.toasts).toMatchObject([
			{
				key: `${WS}:agent_reply:7`,
				kind: "reply",
				workspaceId: WS,
				workspaceName: "Launch",
				item: { conversationId: "chat-1" },
			},
		]);
		expect(found.answered).toEqual([`${WS}:chat-1`]);
		// Both replies are remembered, so neither is looked at again.
		expect(found.events).toEqual([
			`${WS}:agent_reply:7`,
			`${WS}:agent_reply:6`,
		]);
	});

	it("announces an approval request whoever started the turn", () => {
		const found = workspaceToasts(
			list(item("9", "needs_decision", "chat-3")),
			nothing,
		);
		expect(found.toasts).toMatchObject([
			{ key: `${WS}:needs_decision:9`, kind: "approval" },
		]);
		expect(found.answered).toEqual([]);
	});

	it("ignores messages from people, stopped runs and file changes", () => {
		const found = workspaceToasts(
			list(
				item("3", "message", "chat-1"),
				item("2", "agent_stopped", "chat-1"),
				item("1", "file"),
			),
			{ ...nothing, asked: new Set([`${WS}:chat-1`]) },
		);
		expect(found).toEqual({ toasts: [], events: [], answered: [] });
	});

	it("stays quiet for the conversation on screen but still counts the reply as arrived", () => {
		const unread = list(
			item("7", "agent_reply", "chat-1"),
			item("8", "needs_decision", "chat-1"),
			item("9", "needs_decision", "chat-2"),
		);
		const found = workspaceToasts(unread, {
			...nothing,
			asked: new Set([`${WS}:chat-1`]),
			viewing: { workspaceId: WS, conversationId: "chat-1" },
		});
		expect(found.toasts.map((toast) => toast.key)).toEqual([
			`${WS}:needs_decision:9`,
		]);
		expect(found.answered).toEqual([`${WS}:chat-1`]);
		expect(found.events).toHaveLength(3);
		// The same conversation id in another workspace is not on screen.
		expect(
			workspaceToasts(unread, {
				...nothing,
				viewing: { workspaceId: "ws-2", conversationId: "chat-1" },
			}).toasts,
		).toHaveLength(2);
	});

	it("never repeats an event that was already handled", () => {
		const unread = list(
			item("7", "agent_reply", "chat-1"),
			item("9", "needs_decision", "chat-1"),
		);
		const asked = new Set([`${WS}:chat-1`]);
		const first = workspaceToasts(unread, { ...nothing, asked });
		expect(first.toasts).toHaveLength(2);
		const again = workspaceToasts(unread, {
			...nothing,
			asked,
			shown: new Set(first.events),
		});
		expect(again.toasts).toEqual([]);
		expect(again.answered).toEqual([]);
	});

	it("shows one notice of each kind per conversation, for the newest event", () => {
		const found = workspaceToasts(
			list(
				item("9", "needs_decision", "chat-1"),
				item("8", "needs_decision", "chat-1"),
				item("7", "needs_decision", "chat-2"),
			),
			nothing,
		);
		expect(found.toasts.map((toast) => toast.item.id)).toEqual(["9", "7"]);
		expect(found.events).toHaveLength(3);
	});
});

describe("what the browser remembers", () => {
	it("keeps a question until its reply is handled, and handled events for later", () => {
		noteChatAsked(WS, "chat-1", 1_000);
		noteChatAsked(WS, "chat-2", 2_000);
		expect(askedConversations(3_000)).toEqual(
			new Set([`${WS}:chat-1`, `${WS}:chat-2`]),
		);
		rememberHandled([`${WS}:agent_reply:7`], [`${WS}:chat-1`]);
		expect(askedConversations(3_000)).toEqual(new Set([`${WS}:chat-2`]));
		expect(shownEvents()).toEqual(new Set([`${WS}:agent_reply:7`]));
		// A question from yesterday no longer waits.
		expect(askedConversations(2_000 + 13 * 60 * 60_000)).toEqual(new Set());
	});

	it("still works when browser storage is unavailable", () => {
		vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
			throw new Error("blocked");
		});
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("blocked");
		});
		noteChatAsked(WS, "chat-1", 1_000);
		rememberHandled(["event-1"], []);
		expect(askedConversations(2_000)).toEqual(new Set([`${WS}:chat-1`]));
		expect(shownEvents()).toEqual(new Set(["event-1"]));
	});

	it("looks for a reply more often only after leaving the conversation asked in", () => {
		noteChatAsked(WS, "chat-1", 1_000);
		const leave = showConversationOnScreen({
			workspaceId: WS,
			conversationId: "chat-1",
		});
		expect(conversationOnScreen()).toEqual({
			workspaceId: WS,
			conversationId: "chat-1",
		});
		expect(waitingForReplyElsewhere(2_000)).toBe(false);
		leave();
		expect(conversationOnScreen()).toBeNull();
		expect(waitingForReplyElsewhere(2_000)).toBe(true);
		expect(waitingForReplyElsewhere(1_000 + 11 * 60_000)).toBe(false);
	});

	it("treats a hidden tab as showing nothing", () => {
		showConversationOnScreen({ workspaceId: WS, conversationId: "chat-1" });
		vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
		expect(conversationOnScreen()).toBeNull();
	});
});
