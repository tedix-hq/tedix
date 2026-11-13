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
}));
vi.mock("@/lib/api", async (original) => {
	const actual = await original<typeof import("@/lib/api")>();
	return {
		...actual,
		osApi: {
			...actual.osApi,
			userSettings: {
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
					const current = server.rows.get(server.signedIn)?.revision ?? 0;
					if (current !== input.expectedRevision)
						throw Object.assign(new Error("conflict"), { code: "CONFLICT" });
					const row = { preferences: input.preferences, revision: current + 1 };
					server.rows.set(server.signedIn, row);
					return { ...row, source: "stored", updatedAt: null };
				},
			},
		},
	};
});
import { WorkspaceChat } from "./workspace-chat";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const AZURE = { id: "azure-openai/gpt-5.6-sol", label: "Sol" };
const WORKERS = { id: "@cf/meta/llama-3.2-3b-instruct", label: "Llama" };

const cleanups: Array<() => void> = [];
const storage = new Map<string, string>();
beforeEach(() => {
	server.signedIn = "ana";
	server.rows.clear();
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
async function openBrowser(workspaceId = "ws-1") {
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
			models: [AZURE, WORKERS],
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
					conversationId="c1"
					createClient={
						(() => client) as unknown as typeof createWorkspaceChatClient
					}
					listOpen={false}
					onOpenList={() => {}}
					onSelectConversation={() => {}}
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
