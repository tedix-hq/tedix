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
import type { OsGadgetManifest } from "@tedix/api-contract/schemas/os-workspaces";
import type { AppRuntimeError } from "@/lib/app-runtime-protocol";
import {
	workspaceOpenQueryOptions,
	workspaceResourcesQueryOptions,
} from "@/lib/os-query-options";
import {
	hostWorkspaceChatDrafts,
	receiveWorkspaceChatDrafts,
} from "@/lib/workspace-chat-draft-handoff";
import { appErrorsMessage } from "./app-runtime-errors";
import { AppRuntimeSandbox } from "./app-runtime-panel";

const frame = vi.hoisted(() => ({
	onError: undefined as undefined | ((error: AppRuntimeError) => void),
}));
vi.mock("@/components/app-runtime-frame", () => ({
	AppRuntimeFrame: ({
		onError,
	}: {
		onError?: (error: AppRuntimeError) => void;
	}) => {
		frame.onError = onError;
		return <div data-app-frame />;
	},
}));

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const workspaceId = "11111111-1111-4111-8111-111111111111";
const gadgetId = "22222222-2222-4222-8222-222222222222";
const manifest = {
	entry: "tedix:runtime/v1",
	capabilities: [],
	config: { version: 1 },
} as unknown as OsGadgetManifest;
const filesA = { "server.js": "export class App {}", "client.js": "one();" };
const filesB = { "server.js": "export class App {}", "client.js": "two();" };

let host: HTMLDivElement;
let root: Root;
const cleanups: Array<() => void> = [];

beforeEach(() => {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	frame.onError = undefined;
});
afterEach(() => {
	act(() => root.unmount());
	host.remove();
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function mount(
	files: Record<string, string> = filesA,
	appManifest: OsGadgetManifest = manifest,
) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Infinity } },
	});
	client.setQueryData<unknown>(
		workspaceResourcesQueryOptions(workspaceId).queryKey,
		{ items: [] },
	);
	client.setQueryData<unknown>(
		workspaceOpenQueryOptions(workspaceId, gadgetId).queryKey,
		{ role: "build", isOwner: true },
	);
	const render = (next: Record<string, string>) =>
		act(() =>
			root.render(
				<QueryClientProvider client={client}>
					<AppRuntimeSandbox
						workspaceId={workspaceId}
						gadget={{ id: gadgetId, name: "Visit counter" }}
						manifest={appManifest}
						revision={1}
						revisionId="revision-1"
						files={next}
					/>
				</QueryClientProvider>,
			),
		);
	render(files);
	return { render };
}

const bar = () => host.querySelector("[data-app-runtime-errors]");
const button = (name: string) =>
	[...host.querySelectorAll("button")].find(
		(el) =>
			el.textContent?.trim() === name || el.getAttribute("aria-label") === name,
	);
const click = (el: Element | undefined) =>
	act(() => {
		el?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
const report = (error: AppRuntimeError) => act(() => frame.onError?.(error));

describe("errors of a running app", () => {
	it("shows nothing until the app reports an error, then counts them", () => {
		mount();
		expect(bar()).toBeNull();
		report({ kind: "error", message: "TypeError: rows is undefined", line: 4 });
		expect(bar()?.textContent).toContain("This app reported 1 error.");
		expect(bar()?.getAttribute("role")).toBe("status");
		report({ kind: "console", message: "Could not load" });
		expect(bar()?.textContent).toContain("This app reported 2 errors.");
	});

	it("offers to send them only where a chat can take them", () => {
		mount();
		report({ kind: "rejection", message: "Error: not_permitted" });
		expect(button("Send to the agent")).toBeUndefined();
		expect(button("Dismiss")).toBeDefined();
		let stop = () => {};
		act(() => {
			stop = hostWorkspaceChatDrafts(workspaceId, () => {});
		});
		cleanups.push(() => stop());
		expect(button("Send to the agent")).toBeDefined();
		act(() => stop());
		expect(button("Send to the agent")).toBeUndefined();
	});

	it("puts the errors into the chat's message box and sends nothing itself", () => {
		const reveal = vi.fn();
		const received: string[] = [];
		cleanups.push(
			hostWorkspaceChatDrafts(workspaceId, reveal),
			receiveWorkspaceChatDrafts(workspaceId, (text) => received.push(text)),
		);
		mount();
		report({ kind: "error", message: "TypeError: rows is undefined", line: 4 });
		report({ kind: "rejection", message: "Error: not_permitted" });
		report({ kind: "console", message: "Could not load ``` the sheet" });
		click(button("Send to the agent"));
		expect(reveal).toHaveBeenCalledTimes(1);
		expect(received).toEqual([
			[
				'The app "Visit counter" reported 3 errors while it was running. Please find the cause and fix it.',
				"```",
				"1. Error (client.js line 4): TypeError: rows is undefined",
				"2. Unhandled promise rejection: Error: not_permitted",
				"3. console.error: Could not load ''' the sheet",
				"```",
			].join("\n"),
		]);
		// Handed over: the bar is gone until the app reports again.
		expect(bar()).toBeNull();
		report({ kind: "error", message: "Again" });
		expect(bar()?.textContent).toContain("This app reported 1 error.");
	});

	it("keeps the last 20 of many and says so", () => {
		const received: string[] = [];
		cleanups.push(
			hostWorkspaceChatDrafts(workspaceId, () => {}),
			receiveWorkspaceChatDrafts(workspaceId, (text) => received.push(text)),
		);
		mount();
		for (let index = 1; index <= 25; index += 1)
			report({ kind: "error", message: `Error ${index}` });
		expect(bar()?.textContent).toContain("This app reported 25 errors.");
		click(button("Send to the agent"));
		const lines = received[0]!.split("\n");
		expect(lines[0]).toBe(
			'The app "Visit counter" reported 25 errors while it was running. These are the last 20. Please find the cause and fix it.',
		);
		expect(lines).toHaveLength(23);
		expect(lines[2]).toBe("1. Error: Error 6");
		expect(lines[21]).toBe("20. Error: Error 25");
	});

	it("forgets them on Dismiss and when the app's files change", () => {
		const { render } = mount();
		report({ kind: "error", message: "Old" });
		click(button("Dismiss the app's errors"));
		expect(bar()).toBeNull();
		report({ kind: "error", message: "Old again" });
		expect(bar()).not.toBeNull();
		render(filesB);
		expect(bar()).toBeNull();
	});

	it("does not watch the built-in editors", () => {
		mount(filesA, {
			...manifest,
			config: { version: 1, settings: { editor: "document-v3", slot: "doc" } },
		} as unknown as OsGadgetManifest);
		expect(frame.onError).toBeUndefined();
	});

	it("names an unnamed app plainly", () => {
		expect(
			appErrorsMessage(' "\n', {
				total: 1,
				recent: [{ kind: "error", message: "x" }],
			}).split("\n")[0],
		).toBe(
			'The app "This app" reported 1 error while it was running. Please find the cause and fix it.',
		);
	});
});
