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
import { osQuery } from "@/lib/os-query-options";
import { markSendFailed } from "@/lib/workspace-chat-state";
import {
	useWorkspaceViewOnly,
	VIEW_ONLY_CHAT_REASON,
} from "@/lib/workspace-view-only";
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

const at = "2026-11-07T12:00:00.000Z";

let host: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;

beforeEach(() => {
	window.sessionStorage.clear();
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Infinity } },
	});
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
});

function mount(
	fake: ReturnType<typeof fakeWorkspaceChatClient>,
	options: { viewOnly: boolean; listOpen?: boolean },
) {
	act(() => {
		root.render(
			<QueryClientProvider client={queryClient}>
				<WorkspaceChat
					conversationId="c1"
					createClient={fake.createClient}
					listOpen={options.listOpen ?? false}
					onOpenList={() => {}}
					onSelectConversation={() => {}}
					viewOnly={options.viewOnly}
					workspaceId="ws-1"
				/>
			</QueryClientProvider>,
		);
	});
}

const note = () =>
	host.querySelector('[data-testid="workspace-chat-view-only"]');
const sent = (fake: ReturnType<typeof fakeWorkspaceChatClient>) =>
	fake.calls.filter((call) => call[0] === "sendTurn");

describe("workspace chat for a person with view-only access", () => {
	it.each([false, true])(
		"shows a disabled composer and says why (list=%s)",
		async (listOpen) => {
			window.sessionStorage.setItem(
				"tedix.workspace-chat.draft.ws-1.c1",
				"Typed before access changed",
			);
			const fake = fakeWorkspaceChatClient("c1");
			mount(fake, { viewOnly: true, listOpen });
			const textarea = host.querySelector("textarea")!;
			expect(textarea.disabled).toBe(true);
			expect(textarea.placeholder).toBe(VIEW_ONLY_CHAT_REASON);
			expect(note()?.textContent).toBe(
				"You can view this workspace. Ask an owner for build access to chat.",
			);
			expect(
				host.querySelector<HTMLButtonElement>('button[aria-label="Send"]')
					?.disabled,
			).toBe(true);
			await act(async () =>
				host
					.querySelector("form")
					?.dispatchEvent(
						new Event("submit", { bubbles: true, cancelable: true }),
					),
			);
			expect(sent(fake)).toEqual([]);
		},
	);

	it("does not show the refused message or offer to send again", () => {
		const fake = fakeWorkspaceChatClient("c1");
		mount(fake, { viewOnly: true });
		act(() => {
			fake.feed([
				{
					seq: 1,
					at,
					conversationId: "c1",
					turnId: "t1",
					type: "turn.started",
					text: "Earlier question",
					authorId: "p",
					authorKind: "person",
				},
				{
					seq: 2,
					at,
					conversationId: "c1",
					turnId: "t1",
					type: "turn.finished",
					status: "cancelled",
					durationMs: 1,
				},
			]);
			fake.set({
				state: markSendFailed(fake.client.getSnapshot().state, {
					code: "access_denied",
					message: "Workspace access denied",
				}),
			});
		});
		expect(host.textContent).toContain("Earlier question");
		expect(host.textContent).not.toContain("Workspace access denied");
		const labels = [...host.querySelectorAll("button")].map(
			(button) => button.textContent,
		);
		expect(labels).not.toContain("Continue");
		expect(labels).not.toContain("Retry");
	});

	it("leaves the composer alone for a person who can build", () => {
		const fake = fakeWorkspaceChatClient("c1");
		mount(fake, { viewOnly: false });
		expect(host.querySelector("textarea")?.disabled).toBe(false);
		expect(note()).toBeNull();
	});
});

describe("useWorkspaceViewOnly", () => {
	function Probe({ workspaceId }: { workspaceId: string | null }) {
		return <output>{String(useWorkspaceViewOnly(workspaceId))}</output>;
	}
	const WORKSPACE = "11111111-1111-4111-8111-111111111111";
	const role = (value: "use" | "build") =>
		queryClient.setQueryData(
			osQuery.osCollaborators.access.queryOptions({
				input: { workspaceId: WORKSPACE },
			}).queryKey,
			{ role: value, leave: "allowed" as const },
		);
	const read = (workspaceId: string | null) => {
		act(() =>
			root.render(
				<QueryClientProvider client={queryClient}>
					<Probe workspaceId={workspaceId} />
				</QueryClientProvider>,
			),
		);
		return host.querySelector("output")?.textContent;
	};

	it("is true only for the view-only role", () => {
		role("use");
		expect(read(WORKSPACE)).toBe("true");
		role("build");
		expect(read(WORKSPACE)).toBe("false");
	});

	it("is false while no workspace is open", () => {
		expect(read(null)).toBe("false");
	});
});
