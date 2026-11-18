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

const uploadWorkspaceFile = vi.hoisted(() => vi.fn());
vi.mock("@/lib/workspace-file-upload", () => ({ uploadWorkspaceFile }));
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
vi.mock("@/components/workspace-file-preview", async (original) => ({
	...(await original<typeof import("@/components/workspace-file-preview")>()),
	WorkspaceFilePreview: ({ resourceId }: { resourceId: string }) => (
		<p data-testid="file-preview">{resourceId}</p>
	),
}));
import { WorkspaceChat } from "./workspace-chat";
import { fakeWorkspaceChatClient } from "./workspace-chat-test-client";
import { osQuery } from "@/lib/os-query-options";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;
let fake: ReturnType<typeof fakeWorkspaceChatClient>;
/** Uploads the test finishes by hand, by file name. */
let pending: Map<
	string,
	{
		progress: (percent: number) => void;
		resolve: (result: unknown) => void;
		reject: (error: Error) => void;
	}
>;

const file = (name: string, type = "text/plain") =>
	new File(["data"], name, { type });
const saved = (name: string) => ({
	outputId: `out-${name}`,
	resource: { name },
});

async function settle() {
	await act(async () => {
		for (let tick = 0; tick < 5; tick++)
			await new Promise((resolve) => setTimeout(resolve, 0));
	});
}
function drag(type: string, files: File[], types = ["Files"]) {
	const event = new Event(type, { bubbles: true, cancelable: true });
	Object.defineProperty(event, "dataTransfer", {
		value: { types, files, dropEffect: "none" },
	});
	act(() => {
		host.querySelector("textarea")!.dispatchEvent(event);
	});
	return event;
}
function paste(files: File[], text = "") {
	const event = new Event("paste", { bubbles: true, cancelable: true });
	Object.defineProperty(event, "clipboardData", {
		value: { files, getData: () => text },
	});
	act(() => {
		host.querySelector("textarea")!.dispatchEvent(event);
	});
	return event;
}
const chips = () =>
	host.querySelector('[aria-label="Files added to this message"]');
const dropTarget = () =>
	host.querySelector('[data-slot="attachment-dropzone"]');
const notice = () =>
	host.querySelector('[data-slot="attachment-error"]')?.textContent;
const sendButton = () =>
	host.querySelector<HTMLButtonElement>('[aria-label="Send"]')!;
const click = (label: string) =>
	act(async () =>
		host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)?.click(),
	);
async function type(text: string) {
	const textarea = host.querySelector("textarea")!;
	await act(async () => {
		Object.getOwnPropertyDescriptor(
			HTMLTextAreaElement.prototype,
			"value",
		)!.set!.call(textarea, text);
		textarea.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

function mount(viewOnly = false) {
	act(() => {
		root.render(
			<QueryClientProvider client={queryClient}>
				<WorkspaceChat
					conversationId="c1"
					createClient={fake.createClient}
					listOpen={false}
					onOpenList={() => {}}
					onSelectConversation={() => {}}
					viewOnly={viewOnly}
					workspaceId="ws-1"
				/>
			</QueryClientProvider>,
		);
	});
}

beforeEach(() => {
	window.sessionStorage.clear();
	pending = new Map();
	uploadWorkspaceFile.mockReset();
	uploadWorkspaceFile.mockImplementation(
		(_workspaceId: string, upload: File, progress: (n: number) => void) =>
			new Promise((resolve, reject) => {
				pending.set(upload.name, { progress, resolve, reject });
			}),
	);
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Infinity } },
	});
	fake = fakeWorkspaceChatClient("c1");
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
});

describe("attaching files in workspace chat", () => {
	it("shows a drop target, uploads a dropped file and sends it with the message", async () => {
		mount();
		expect(dropTarget()).toBeNull();
		drag("dragenter", []);
		expect(dropTarget()?.textContent).toBe("Drop files to attach");
		const dropped = drag("drop", [file("report.csv", "text/csv")]);
		expect(dropped.defaultPrevented).toBe(true);
		expect(dropTarget()).toBeNull();
		expect(uploadWorkspaceFile).toHaveBeenCalledWith(
			"ws-1",
			expect.any(File),
			expect.any(Function),
			{ document: true },
		);
		act(() => pending.get("report.csv")!.progress(40));
		expect(chips()?.textContent).toBe("report.csvUploading 40%");
		await type("Total this");
		expect(sendButton().disabled).toBe(true);
		act(() => pending.get("report.csv")!.resolve(saved("report.csv")));
		await settle();
		expect(chips()?.textContent).toBe("report.csv");
		expect(sendButton().disabled).toBe(false);
		await act(async () => sendButton().click());
		expect(fake.calls).toContainEqual([
			"sendTurn",
			{ text: "Total this", attachments: [{ outputId: "out-report.csv" }] },
		]);
	});

	it("leaves a drag without files, and a view-only chat, alone", () => {
		mount();
		expect(drag("dragenter", [], ["text/plain"]).defaultPrevented).toBe(false);
		expect(dropTarget()).toBeNull();
		mount(true);
		expect(drag("drop", [file("a.txt")]).defaultPrevented).toBe(false);
		expect(uploadWorkspaceFile).not.toHaveBeenCalled();
	});

	it("attaches a pasted file and lets pasted text through", async () => {
		mount();
		expect(paste([], "hello").defaultPrevented).toBe(false);
		// A copied table cell carries its text and a picture of itself.
		const picture = file("image.png", "image/png");
		expect(paste([picture], "A1").defaultPrevented).toBe(false);
		expect(uploadWorkspaceFile).not.toHaveBeenCalled();
		expect(paste([picture]).defaultPrevented).toBe(true);
		expect(uploadWorkspaceFile).toHaveBeenCalledOnce();
		act(() => pending.get("image.png")!.resolve(saved("image.png")));
		await settle();
		expect(chips()?.textContent).toBe("image.png");
	});

	it("keeps a message to five files and says what was left out", async () => {
		mount();
		const names = ["1.txt", "2.txt", "3.txt", "4.txt", "5.txt", "6.txt"];
		drag(
			"drop",
			names.map((name) => file(name)),
		);
		expect(uploadWorkspaceFile).toHaveBeenCalledTimes(5);
		expect(notice()).toBe(
			"Messages are limited to 5 attachments; extra files were not added.",
		);
		drag("dragenter", []);
		expect(dropTarget()?.textContent).toBe(
			"Messages are limited to 5 attachments",
		);
		drag("drop", [file("7.txt")]);
		expect(uploadWorkspaceFile).toHaveBeenCalledTimes(5);
		expect(notice()).toBe("Messages are limited to 5 attachments.");
		act(() => {
			for (const name of names.slice(0, 5))
				pending.get(name)!.resolve(saved(name));
		});
		await settle();
		expect(chips()?.querySelectorAll("li")).toHaveLength(5);
		paste([file("8.txt")]);
		expect(uploadWorkspaceFile).toHaveBeenCalledTimes(5);
	});

	it("shows why one file failed, keeps the others, and removes either", async () => {
		mount();
		drag("drop", [file("good.txt"), file("huge.bin")]);
		act(() => {
			pending
				.get("huge.bin")!
				.reject(new Error("Choose a file between 1 byte and 200 MiB."));
			pending.get("good.txt")!.resolve(saved("good.txt"));
		});
		await settle();
		expect(chips()?.querySelector('[data-state="failed"]')?.textContent).toBe(
			"huge.binChoose a file between 1 byte and 200 MiB.",
		);
		expect(chips()?.textContent).toContain("good.txt");
		await type("Read this");
		// A failed file does not hold the message back.
		expect(sendButton().disabled).toBe(false);
		await click("Remove huge.bin");
		expect(chips()?.textContent).toBe("good.txt");
		await click("Remove good.txt");
		expect(chips()).toBeNull();
	});

	it("does not attach a file removed while it was uploading", async () => {
		mount();
		drag("drop", [file("slow.txt")]);
		await click("Remove slow.txt");
		act(() => pending.get("slow.txt")!.resolve(saved("slow.txt")));
		await settle();
		expect(chips()).toBeNull();
	});

	it("opens the file preview from a chip the preview can show", async () => {
		const resource = (name: string, mimeType: string) => {
			queryClient.setQueryData<unknown>(
				osQuery.osWorkspaces.resources.get.queryOptions({
					input: { workspaceId: "ws-1", resourceId: `out-${name}` },
				}).queryKey,
				{ resource: { resourceType: "file", name, metadata: { mimeType } } },
			);
		};
		resource("plan.xlsx", "application/octet-stream");
		resource("notes.zip", "application/zip");
		mount();
		drag("drop", [file("plan.xlsx"), file("notes.zip")]);
		act(() => {
			pending.get("plan.xlsx")!.resolve(saved("plan.xlsx"));
			pending.get("notes.zip")!.resolve(saved("notes.zip"));
		});
		await settle();
		expect(host.querySelector('[aria-label="Preview notes.zip"]')).toBeNull();
		await click("Preview plan.xlsx");
		await settle();
		expect(
			document.querySelector('[data-testid="file-preview"]')?.textContent,
		).toBe("out-plan.xlsx");
	});
});
