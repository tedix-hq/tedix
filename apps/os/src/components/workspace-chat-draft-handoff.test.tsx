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
import {
	hostWorkspaceChatDrafts,
	offerWorkspaceChatDraft,
} from "@/lib/workspace-chat-draft-handoff";

vi.mock("@/lib/workspace-chat-notify", async (original) => ({
	...(await original<typeof import("@/lib/workspace-chat-notify")>()),
	notifyChatPosted: vi.fn(),
}));
vi.mock("@/lib/use-chat-model-preference", async (original) => ({
	...(await original<typeof import("@/lib/use-chat-model-preference")>()),
	useChatModelPreference: () => ({
		modelRef: null,
		settled: true,
		save: () => {},
	}),
}));
import { WorkspaceChat } from "./workspace-chat";
import { fakeWorkspaceChatClient } from "./workspace-chat-test-client";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const ERRORS = [
	'The app "Visit counter" reported 1 error while it was running. Please find the cause and fix it.',
	"```",
	"1. Error (client.js line 4): TypeError: rows is undefined",
	"```",
].join("\n");

let host: HTMLDivElement;
let root: Root;
let stopHost: () => void;

beforeEach(() => {
	window.sessionStorage.clear();
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	stopHost = hostWorkspaceChatDrafts("ws-1", () => {});
});
afterEach(() => {
	act(() => root.unmount());
	host.remove();
	stopHost();
});

function mount(fake: ReturnType<typeof fakeWorkspaceChatClient>) {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Infinity } },
	});
	act(() => {
		root.render(
			<QueryClientProvider client={queryClient}>
				<WorkspaceChat
					conversationId="c1"
					createClient={fake.createClient}
					listOpen={false}
					onOpenList={() => {}}
					onSelectConversation={() => {}}
					workspaceId="ws-1"
				/>
			</QueryClientProvider>,
		);
	});
}

const textarea = () => host.querySelector("textarea")!;
function type(text: string) {
	act(() => {
		Object.getOwnPropertyDescriptor(
			HTMLTextAreaElement.prototype,
			"value",
		)!.set!.call(textarea(), text);
		textarea().dispatchEvent(new Event("input", { bubbles: true }));
	});
}
const sends = (fake: ReturnType<typeof fakeWorkspaceChatClient>) =>
	fake.calls.filter(([name]) => name === "sendTurn");

describe("text handed to the workspace chat's message box", () => {
	it("lands in the message box for the person to change and send; nothing is sent for them", () => {
		const fake = fakeWorkspaceChatClient("c1");
		mount(fake);
		let offered = false;
		act(() => {
			offered = offerWorkspaceChatDraft("ws-1", ERRORS);
		});
		expect(offered).toBe(true);
		expect(textarea().value).toBe(ERRORS);
		expect(document.activeElement).toBe(textarea());
		expect(sends(fake)).toEqual([]);
		// It is a draft like any other: it survives a reload of the page.
		expect(
			window.sessionStorage.getItem("tedix.workspace-chat.draft.ws-1.c1"),
		).toBe(ERRORS);

		type(`${ERRORS}\n\nIt happens when the sheet is empty.`);
		act(() =>
			host
				.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!
				.click(),
		);
		expect(sends(fake)).toHaveLength(1);
		expect(sends(fake)[0]?.[1]).toMatchObject({
			text: `${ERRORS}\n\nIt happens when the sheet is empty.`,
		});
	});

	it("goes after what the person was already typing", () => {
		const fake = fakeWorkspaceChatClient("c1");
		mount(fake);
		type("While you are at it, rename the button.");
		act(() => {
			offerWorkspaceChatDraft("ws-1", ERRORS);
		});
		expect(textarea().value).toBe(
			`While you are at it, rename the button.\n\n${ERRORS}`,
		);
		expect(sends(fake)).toEqual([]);
	});

	it("waits for the message box when the chat is not on screen yet", () => {
		act(() => {
			offerWorkspaceChatDraft("ws-1", ERRORS);
		});
		const fake = fakeWorkspaceChatClient("c1");
		mount(fake);
		expect(textarea().value).toBe(ERRORS);
		expect(sends(fake)).toEqual([]);
	});

	it("leaves another workspace's message box alone", () => {
		const fake = fakeWorkspaceChatClient("c1");
		mount(fake);
		const stop = hostWorkspaceChatDrafts("ws-2", () => {});
		act(() => {
			offerWorkspaceChatDraft("ws-2", ERRORS);
		});
		stop();
		expect(textarea().value).toBe("");
	});
});
