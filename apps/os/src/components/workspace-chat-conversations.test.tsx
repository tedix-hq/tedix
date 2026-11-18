import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import type {
	ConversationChange,
	createWorkspaceChatClient,
	WorkspaceChatClient,
	WorkspaceChatSnapshot,
} from "@/lib/workspace-chat-client";
import type {
	ConversationSummary,
	WorkspaceChatLedgerEvent,
} from "@/lib/workspace-chat-protocol";
import {
	applyWorkspaceChatEvents,
	initialWorkspaceChatState,
	removeConversation,
	setConversations,
	setWorkspaceUsage,
} from "@/lib/workspace-chat-state";

vi.mock("@/lib/use-chat-model-preference", async (original) => ({
	...(await original<typeof import("@/lib/use-chat-model-preference")>()),
	useChatModelPreference: () => ({
		modelRef: null,
		settled: true,
		save: () => {},
	}),
}));
import { WorkspaceChat } from "./workspace-chat";
import {
	ConversationList,
	groupConversations,
} from "./workspace-chat-conversations";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// Wednesday 18 November 2026, local time.
const NOW = new Date(2026, 10, 18, 15, 0, 0);
const localIso = (day: number, hour = 10) =>
	new Date(2026, 10, day, hour, 0, 0).toISOString();
const conversation = (
	id: string,
	lastTurnAt: string,
	more: Partial<ConversationSummary> = {},
): ConversationSummary => ({
	id,
	title: `Conversation ${id}`,
	updatedAt: lastTurnAt,
	lastTurnAt,
	...more,
});

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW);
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
	vi.useRealTimers();
});

function button(label: string, within: ParentNode = document.body) {
	const found = [...within.querySelectorAll<HTMLElement>("button")].find(
		(item) =>
			item.getAttribute("aria-label") === label ||
			item.textContent?.trim() === label,
	);
	if (!found) throw new Error(`No button "${label}"`);
	return found;
}

function menuItem(label: string) {
	const found = [
		...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'),
	].find((item) => item.textContent?.trim() === label);
	if (!found) throw new Error(`No menu item "${label}"`);
	return found;
}

function type(input: HTMLInputElement, value: string) {
	const setter = Object.getOwnPropertyDescriptor(
		HTMLInputElement.prototype,
		"value",
	)?.set;
	act(() => {
		setter?.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

function submit(input: HTMLInputElement) {
	act(() => {
		input.form?.dispatchEvent(
			new Event("submit", { bubbles: true, cancelable: true }),
		);
	});
}

describe("groupConversations", () => {
	it("puts conversations under the day they were last used, newest first", () => {
		const groups = groupConversations(
			[
				conversation("last-week", localIso(13)),
				conversation("monday", localIso(16)),
				conversation("yesterday", localIso(17)),
				conversation("this-morning", localIso(18, 8)),
				conversation("just-now", localIso(18, 14)),
			],
			NOW,
		);
		expect(
			groups.map((group) => [
				group.label,
				group.conversations.map((row) => row.id),
			]),
		).toEqual([
			["Today", ["just-now", "this-morning"]],
			["Yesterday", ["yesterday"]],
			["Earlier this week", ["monday"]],
			["Earlier", ["last-week"]],
		]);
	});

	it("leaves out an empty section and files a renamed conversation by its last message", () => {
		const groups = groupConversations(
			[
				conversation("old", localIso(2), { updatedAt: localIso(18, 14) }),
				conversation("new", localIso(18, 9)),
			],
			NOW,
		);
		expect(groups.map((group) => group.label)).toEqual(["Today", "Earlier"]);
	});

	it("has no 'Earlier this week' on a Monday", () => {
		const monday = new Date(2026, 10, 16, 15, 0, 0);
		expect(
			groupConversations(
				[
					conversation("sunday", localIso(15)),
					conversation("friday", localIso(13)),
				],
				monday,
			).map((group) => [group.label, group.conversations.length]),
		).toEqual([
			["Yesterday", 1],
			["Earlier", 1],
		]);
	});
});

describe("ConversationList", () => {
	function mount(
		conversations: ConversationSummary[],
		props: Partial<Parameters<typeof ConversationList>[0]> = {},
	) {
		const changes: ConversationChange[] = [];
		const selected: Array<string | null> = [];
		act(() => {
			root.render(
				<ConversationList
					activeId={null}
					activePendingApprovals={0}
					activeRunning={false}
					conversations={conversations}
					onChange={(change) => changes.push(change)}
					onSelect={(id) => selected.push(id)}
					{...props}
				/>,
			);
		});
		return { changes, selected };
	}
	const sections = () =>
		[...host.querySelectorAll("section")].map((section) => [
			section.getAttribute("aria-label"),
			[...section.querySelectorAll(".workspace-chat-list-row")].map(
				(row) => row.querySelector("span")?.textContent,
			),
		]);

	it("groups the list and keeps archived conversations out of it", () => {
		mount([
			conversation("a", localIso(18, 9)),
			conversation("b", localIso(17)),
			conversation("c", localIso(3)),
			conversation("z", localIso(18, 11), { archivedAt: localIso(18, 12) }),
		]);
		expect(sections()).toEqual([
			["Today", ["Conversation a"]],
			["Yesterday", ["Conversation b"]],
			["Earlier", ["Conversation c"]],
		]);
	});

	it("marks a conversation with changes waiting, beside the working dot", () => {
		mount(
			[
				conversation("waiting", localIso(18, 9), {
					pendingApprovals: 2,
					running: true,
				}),
				conversation("quiet", localIso(18, 8)),
				// The open conversation shows what this tab sees, not the summary.
				conversation("open", localIso(18, 7), { pendingApprovals: 1 }),
				conversation("open-waiting", localIso(18, 6)),
			],
			{ activeId: "open" },
		);
		const rows = [...host.querySelectorAll(".workspace-chat-list-row")];
		expect(
			rows.map((row) => row.textContent?.includes("Needs approval")),
		).toEqual([true, false, false, false]);
		expect(rows[0]?.querySelector('[aria-label="Working"]')).not.toBeNull();
		expect(rows[1]?.querySelector('[aria-label="Working"]')).toBeNull();

		mount([conversation("open-waiting", localIso(18, 6))], {
			activeId: "open-waiting",
			activePendingApprovals: 1,
		});
		expect(host.textContent).toContain("Needs approval");
	});

	it("renames from the row menu", () => {
		const { changes } = mount([conversation("a", localIso(18, 9))]);
		act(() => button("Actions for Conversation a").click());
		act(() => menuItem("Rename").click());
		const input = host.querySelector<HTMLInputElement>(
			'input[aria-label="Conversation name"]',
		);
		if (!input) throw new Error("No name field");
		expect(input.value).toBe("Conversation a");
		type(input, "  Launch   plan ");
		submit(input);
		expect(changes).toEqual([
			{
				type: "rename_conversation",
				conversationId: "a",
				title: "Launch plan",
			},
		]);
		expect(host.querySelector("input")).toBeNull();
	});

	it("does not rename to an empty or unchanged name", () => {
		const { changes } = mount([conversation("a", localIso(18, 9))]);
		for (const value of ["   ", "Conversation a"]) {
			act(() => button("Actions for Conversation a").click());
			act(() => menuItem("Rename").click());
			const input = host.querySelector<HTMLInputElement>("input");
			if (!input) throw new Error("No name field");
			type(input, value);
			submit(input);
		}
		expect(changes).toEqual([]);
	});

	it("archives from the menu and restores from the Archived view", () => {
		const { changes } = mount([
			conversation("a", localIso(18, 9)),
			conversation("z", localIso(17), { archivedAt: localIso(18, 12) }),
		]);
		act(() => button("Actions for Conversation a").click());
		act(() => menuItem("Archive").click());
		expect(changes).toEqual([
			{ type: "archive_conversation", conversationId: "a", archived: true },
		]);

		act(() => button("Archived (1)").click());
		expect(sections()).toEqual([["Yesterday", ["Conversation z"]]]);
		act(() => button("Actions for Conversation z").click());
		act(() => menuItem("Restore").click());
		expect(changes.at(-1)).toEqual({
			type: "archive_conversation",
			conversationId: "z",
			archived: false,
		});
		act(() => button("Conversations").click());
		expect(sections()).toEqual([["Today", ["Conversation a"]]]);
	});

	it("has no Archived view while nothing is archived", () => {
		mount([conversation("a", localIso(18, 9))]);
		expect(host.textContent).not.toContain("Archived");
	});

	it("deletes only after a confirmation that says it cannot be undone", () => {
		const { changes } = mount([conversation("a", localIso(18, 9))]);
		act(() => button("Actions for Conversation a").click());
		act(() => menuItem("Delete").click());
		const dialog = document.body.querySelector('[role="alertdialog"]');
		expect(dialog?.textContent).toContain("Conversation a");
		expect(dialog?.textContent).toContain("This cannot be undone.");
		expect(changes).toEqual([]);
		act(() => button("Delete", dialog!).click());
		expect(changes).toEqual([
			{ type: "delete_conversation", conversationId: "a" },
		]);
	});

	it("keeps the conversation when the confirmation is cancelled", () => {
		const { changes } = mount([conversation("a", localIso(18, 9))]);
		act(() => button("Actions for Conversation a").click());
		act(() => menuItem("Delete").click());
		act(() =>
			button(
				"Cancel",
				document.body.querySelector('[role="alertdialog"]')!,
			).click(),
		);
		expect(changes).toEqual([]);
	});

	it("offers no changes while the chat is not connected", () => {
		mount([conversation("a", localIso(18, 9))], { onChange: null });
		expect(
			(button("Actions for Conversation a") as HTMLButtonElement).disabled,
		).toBe(true);
	});
});

describe("conversation changes in the chat state", () => {
	const event = (
		seq: number,
		body: Record<string, unknown>,
	): WorkspaceChatLedgerEvent =>
		({
			seq,
			at: new Date(NOW.getTime() + seq).toISOString(),
			conversationId: "c2",
			...body,
		}) as WorkspaceChatLedgerEvent;
	const start = () =>
		setWorkspaceUsage(
			setConversations(initialWorkspaceChatState("c1"), [
				conversation("c1", localIso(18, 9)),
				conversation("c2", localIso(18, 8), { pendingApprovals: 1 }),
			]),
			undefined,
			10,
		);
	const row = (state: ReturnType<typeof start>, id: string) =>
		state.conversations.find((item) => item.id === id);

	it("archives, restores and renames a conversation this chat does not follow", () => {
		let state = applyWorkspaceChatEvents(start(), [
			event(11, { type: "conversation.updated", title: "Budget" }),
			event(12, {
				type: "conversation.updated",
				archivedAt: "2026-11-18T14:00:00.000Z",
			}),
		]);
		expect(row(state, "c2")).toMatchObject({
			title: "Budget",
			archivedAt: "2026-11-18T14:00:00.000Z",
			pendingApprovals: 1,
		});
		state = applyWorkspaceChatEvents(state, [
			event(13, { type: "conversation.updated", archivedAt: null }),
		]);
		expect(row(state, "c2")).toMatchObject({ title: "Budget" });
		expect(row(state, "c2")?.archivedAt).toBeUndefined();
	});

	it("counts changes that start or stop waiting after the object's hello", () => {
		const requested = {
			type: "approval.requested",
			turnId: "t",
			stepId: "s",
			approvalId: "a2",
			title: "Create Budget",
			reason: "Writes need approval",
		};
		let state = applyWorkspaceChatEvents(start(), [
			// Already counted by the hello.
			event(9, requested),
			event(11, requested),
		]);
		expect(row(state, "c2")?.pendingApprovals).toBe(2);
		state = applyWorkspaceChatEvents(state, [
			event(12, {
				type: "approval.decided",
				approvalId: "a2",
				decision: "approve",
				by: "u1",
			}),
		]);
		expect(row(state, "c2")?.pendingApprovals).toBe(1);
	});

	it("drops a deleted conversation and says so when it was the open one", () => {
		const other = removeConversation(start(), "c2");
		expect(other.conversations.map((item) => item.id)).toEqual(["c1"]);
		expect(other.lastError).toBeNull();
		const open = removeConversation(start(), "c1");
		expect(open.conversations.map((item) => item.id)).toEqual(["c2"]);
		expect(open.lastError).toEqual({
			code: "conversation_deleted",
			message: "This conversation was deleted.",
		});
	});
});

describe("WorkspaceChat conversation management", () => {
	function mountChat(listOpen: boolean) {
		let snapshot: WorkspaceChatSnapshot = {
			state: setConversations(initialWorkspaceChatState("c1"), [
				conversation("c1", localIso(18, 9), { title: "Launch" }),
			]),
			connection: { phase: "open", since: 0 },
			catchingUp: false,
		};
		const listeners = new Set<() => void>();
		const changes: ConversationChange[] = [];
		const client: WorkspaceChatClient = {
			getSnapshot: () => snapshot,
			getConversationId: () => snapshot.state.conversationId,
			subscribe(listener) {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			sendTurn: () => "client-turn",
			decideApproval() {},
			decideApprovals() {},
			setAutoApproval() {},
			cancelTurn() {},
			changeConversation: (change) => changes.push(change),
			loadEarlier() {},
			forceDrop() {},
			retry() {},
			close() {},
		};
		const createClient: typeof createWorkspaceChatClient = () => client;
		const selected: Array<string | null> = [];
		const onOpenList = vi.fn();
		act(() => {
			root.render(
				<QueryClientProvider client={new QueryClient()}>
					<WorkspaceChat
						conversationId="c1"
						createClient={createClient}
						listOpen={listOpen}
						onOpenList={onOpenList}
						onSelectConversation={(id) => selected.push(id)}
						workspaceId="ws-1"
					/>
				</QueryClientProvider>,
			);
		});
		const set = (state: WorkspaceChatSnapshot["state"]) => {
			snapshot = { ...snapshot, state };
			act(() => {
				for (const listener of listeners) listener();
			});
		};
		return { changes, selected, onOpenList, set, state: () => snapshot.state };
	}

	it("renames the open conversation from its title in the header", () => {
		const { changes } = mountChat(false);
		act(() => button("Launch").click());
		const input = host.querySelector<HTMLInputElement>(
			'input[aria-label="Conversation name"]',
		);
		if (!input) throw new Error("No name field");
		type(input, "Launch plan");
		submit(input);
		expect(changes).toEqual([
			{
				type: "rename_conversation",
				conversationId: "c1",
				title: "Launch plan",
			},
		]);
	});

	it("goes back to the list when the open conversation is deleted", () => {
		const { selected, onOpenList, set, state } = mountChat(false);
		set(removeConversation(state(), "c1"));
		expect(selected).toEqual([null]);
		expect(onOpenList).toHaveBeenCalledTimes(1);
	});
});
