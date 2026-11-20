import { DEFAULT_OS_USER_PREFERENCES } from "@tedix/api-contract/schemas/user-settings";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type {
	createWorkspaceChatClient,
	WorkspaceChatClient,
} from "@/lib/workspace-chat-client";
import { initialWorkspaceChatState } from "@/lib/workspace-chat-state";

/** The server's preference rows: one per signed-in person, shared by every browser. */
const server = vi.hoisted(() => ({
	signedIn: "ana",
	rows: new Map<string, { preferences: object; revision: number }>(),
	/** When set, each save waits here until the test lets it reach the server. */
	held: null as Array<() => void> | null,
}));
vi.mock("@/lib/api", async (original) => {
	const actual = await original<typeof import("@/lib/api")>();
	const userSettings = {
		getContext: async () => ({ authority: { permissions: [] } }),
		getPreferences: async () => {
			const row = server.rows.get(server.signedIn);
			return row
				? { ...row, source: "stored", updatedAt: null }
				: {
						preferences: DEFAULT_OS_USER_PREFERENCES,
						source: "default",
						revision: 0,
						updatedAt: null,
					};
		},
		updatePreferences: async (input: {
			preferences: object;
			expectedRevision: number;
		}) => {
			const held = server.held;
			if (held) await new Promise<void>((release) => held.push(release));
			const current = server.rows.get(server.signedIn)?.revision ?? 0;
			if (current !== input.expectedRevision)
				throw Object.assign(new Error("conflict"), { code: "CONFLICT" });
			const row = { preferences: input.preferences, revision: current + 1 };
			server.rows.set(server.signedIn, row);
			return { ...row, source: "stored", updatedAt: null };
		},
	};
	// The real client is a proxy, so spreading it copies nothing. Answer the
	// preference calls here and leave every other route to the real client:
	// the composer builds query options for routes these tests never call.
	return {
		...actual,
		osApi: new Proxy(actual.osApi, {
			get: (target, key, receiver) =>
				key === "userSettings"
					? userSettings
					: Reflect.get(target, key, receiver),
		}),
	};
});
// The administrator's default for a person's chat with a tedi.
vi.mock("@/lib/os-query-options", async (original) => ({
	...(await original<typeof import("@/lib/os-query-options")>()),
	modelCatalogQueryOptions: () => ({
		queryKey: ["test", "model-catalog"],
		queryFn: async () => ({
			models: [],
			personChatModelRef: "azure-openai/gpt-6.1-sol",
		}),
	}),
}));
import { WorkspaceChat } from "./workspace-chat";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const AZURE = { id: "azure-openai/gpt-5.6-sol", label: "Sol" };
const WORKERS = { id: "@cf/meta/llama-3.2-3b-instruct", label: "Llama" };

const TEDI_DEFAULT = { id: "azure-openai/gpt-6.1-sol", label: "Sol 6.1" };

const cleanups: Array<() => void> = [];
const storage = new Map<string, string>();
beforeEach(() => {
	server.signedIn = "ana";
	server.rows.clear();
	server.held = null;
	storage.clear();
	Object.defineProperty(window, "localStorage", {
		configurable: true,
		value: {
			getItem: (key: string) => storage.get(key) ?? null,
			setItem: (key: string, value: string) => void storage.set(key, value),
			removeItem: (key: string) => void storage.delete(key),
		},
	});
});
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

/** One browser: its own page, query cache and chat connection. */
async function openBrowser(
	workspaceId = "ws-1",
	chat: {
		conversationId: string | null;
		answeredBy?: string;
		tediId?: string;
		modelDefault?: "personChat";
	} = {
		conversationId: "c1",
	},
) {
	const sent: unknown[] = [];
	const client = {
		getSnapshot: () => snapshot,
		getConversationId: () => "c1",
		subscribe: () => () => {},
		sendTurn: (input: unknown) => (sent.push(input), "client-turn"),
		close() {},
	} as unknown as WorkspaceChatClient;
	const snapshot = {
		state: {
			...initialWorkspaceChatState("c1"),
			models: [AZURE, WORKERS, TEDI_DEFAULT],
			turns: chat.answeredBy
				? [
						{
							turnId: "t1",
							conversationId: "c1",
							startedAt: "2026-11-18T10:00:00.000Z",
							authorId: "ana",
							authorKind: "person" as const,
							text: "Count them",
							reply: "Three.",
							replyMessageId: "m1",
							replyDone: true,
							steps: [],
							approvals: [],
							status: "succeeded" as const,
							finishedAt: "2026-11-18T10:00:05.000Z",
							model: chat.answeredBy,
							replyKey: "reply-t1",
						},
					]
				: [],
		},
		connection: { phase: "open" as const, since: 0 },
		catchingUp: false,
	};
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	cleanups.push(() => {
		act(() => root.unmount());
		host.remove();
	});
	await act(async () => {
		root.render(
			<QueryClientProvider
				client={
					new QueryClient({ defaultOptions: { queries: { retry: false } } })
				}
			>
				<WorkspaceChat
					conversationId={chat.conversationId}
					createClient={
						(() => client) as unknown as typeof createWorkspaceChatClient
					}
					listOpen={false}
					onOpenList={() => {}}
					onSelectConversation={() => {}}
					tediId={chat.tediId}
					modelDefault={chat.modelDefault}
					workspaceId={workspaceId}
				/>
			</QueryClientProvider>,
		);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	const trigger = () =>
		host.querySelector<HTMLButtonElement>('[aria-label="Model"]')!;
	return {
		chosen: () => trigger().textContent,
		async choose(label: string) {
			await act(async () => trigger().click());
			const option = [
				...document.querySelectorAll<HTMLElement>('[role="option"]'),
			].find((entry) => entry.textContent === label)!;
			await act(async () => option.click());
			await act(async () => {
				await new Promise((resolve) => setTimeout(resolve, 0));
			});
		},
		send(text: string) {
			const textarea = host.querySelector("textarea")!;
			act(() => {
				Object.getOwnPropertyDescriptor(
					HTMLTextAreaElement.prototype,
					"value",
				)!.set!.call(textarea, text);
				textarea.dispatchEvent(new Event("input", { bubbles: true }));
			});
			act(() => {
				host
					.querySelector("form")!
					.dispatchEvent(
						new Event("submit", { bubbles: true, cancelable: true }),
					);
			});
			return sent.at(-1);
		},
	};
}

it("follows the person to another browser and workspace, and is not shown to the next person on this one", async () => {
	const first = await openBrowser();
	expect(first.chosen()).toBe("Sol");
	await first.choose("Llama");
	expect(first.chosen()).toBe("Llama");
	// The choice is stored as a catalog ref, which the tedi chat reads too.
	expect(server.rows.get("ana")?.preferences).toMatchObject({
		conversationModelRef: `workers-ai/${WORKERS.id}`,
	});
	expect(storage.size).toBe(0);

	const elsewhere = await openBrowser("ws-2");
	expect(elsewhere.chosen()).toBe("Llama");
	expect(elsewhere.send("Count them")).toEqual({
		text: "Count them",
		modelId: WORKERS.id,
	});

	server.signedIn = "ben";
	const nextPerson = await openBrowser();
	expect(nextPerson.chosen()).toBe("Sol");
});

it("uses the first offered model when the stored one is no longer offered", async () => {
	server.rows.set("ana", {
		preferences: {
			...DEFAULT_OS_USER_PREFERENCES,
			conversationModelRef: "azure-openai/withdrawn",
		},
		revision: 1,
	});
	const browser = await openBrowser();
	expect(browser.chosen()).toBe("Sol");
	expect(browser.send("Count them")).toEqual({
		text: "Count them",
		modelId: AZURE.id,
	});
});

it("ignores a choice an earlier version left in this browser", async () => {
	storage.set("tedix.workspace-chat.model.ws-1", WORKERS.id);
	const browser = await openBrowser();
	expect(browser.chosen()).toBe("Sol");
});

it("keeps a chat on the model that last answered in it, and starts a new chat on the remembered one", async () => {
	server.rows.set("ana", {
		preferences: {
			...DEFAULT_OS_USER_PREFERENCES,
			conversationModelRef: `workers-ai/${WORKERS.id}`,
		},
		revision: 1,
	});
	const earlierChat = await openBrowser("ws-1", {
		conversationId: "c1",
		answeredBy: AZURE.id,
	});
	expect(earlierChat.chosen()).toBe("Sol");
	const newChat = await openBrowser("ws-1", { conversationId: null });
	expect(newChat.chosen()).toBe("Llama");

	// A pick in the earlier chat applies there and becomes the remembered one.
	await earlierChat.choose("Llama");
	expect(earlierChat.chosen()).toBe("Llama");
});

it("starts a chat with a tedi on the configured chat default, sends every message to the tedi, and leaves the remembered model alone", async () => {
	server.rows.set("ana", {
		preferences: {
			...DEFAULT_OS_USER_PREFERENCES,
			conversationModelRef: `workers-ai/${WORKERS.id}`,
		},
		revision: 1,
	});
	const tediChat = await openBrowser("ws-1", {
		conversationId: null,
		tediId: "tedi-1",
	});
	expect(tediChat.chosen()).toBe("Sol 6.1");
	// No model is named until the person picks one: the workspace applies
	// the default, so a page that has not loaded it yet cannot override it.
	expect(tediChat.send("Hello")).toEqual({
		text: "Hello",
		tediId: "tedi-1",
	});

	const picking = await openBrowser("ws-1", {
		conversationId: null,
		tediId: "tedi-1",
	});
	await picking.choose("Sol");
	expect(picking.chosen()).toBe("Sol");
	expect(picking.send("Hello")).toMatchObject({ modelId: AZURE.id });
	expect(server.rows.get("ana")?.preferences).toMatchObject({
		conversationModelRef: `workers-ai/${WORKERS.id}`,
	});
});

it("starts a chat in the person's private workspace on the chat default with nobody picked, naming no model", async () => {
	server.rows.set("ana", {
		preferences: {
			...DEFAULT_OS_USER_PREFERENCES,
			conversationModelRef: `workers-ai/${WORKERS.id}`,
		},
		revision: 1,
	});
	const privateChat = await openBrowser("ws-1", {
		conversationId: null,
		modelDefault: "personChat",
	});
	expect(privateChat.chosen()).toBe("Sol 6.1");
	expect(privateChat.send("Hello")).toEqual({ text: "Hello" });
});

it("falls back to the remembered model when the one that answered is no longer offered", async () => {
	server.rows.set("ana", {
		preferences: {
			...DEFAULT_OS_USER_PREFERENCES,
			conversationModelRef: `workers-ai/${WORKERS.id}`,
		},
		revision: 1,
	});
	const browser = await openBrowser("ws-1", {
		conversationId: "c1",
		answeredBy: "azure-openai/withdrawn",
	});
	expect(browser.chosen()).toBe("Llama");
});

it("ends on the second of two quick picks, whichever save the server finishes first", async () => {
	const browser = await openBrowser();
	const held: Array<() => void> = [];
	server.held = held;
	await browser.choose("Llama");
	await browser.choose("Sol");
	while (held.length > 0) {
		held.pop()!();
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
	}
	expect(browser.chosen()).toBe("Sol");
	expect(server.rows.get("ana")?.preferences).toMatchObject({
		conversationModelRef: AZURE.id,
	});
});
