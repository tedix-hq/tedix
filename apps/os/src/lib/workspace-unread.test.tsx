import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";

const unreadApi = vi.hoisted(() => ({
	summary: vi.fn(),
	list: vi.fn(),
	workspace: vi.fn(),
	markRead: vi.fn(),
	markAllRead: vi.fn(),
}));
vi.mock("@/lib/api", () => ({ osApi: { workspaceUnread: unreadApi } }));

import { publishOutputRevisionNotice } from "./output-revision-notices";
import { useUnreadTotal, useWorkspaceUnread } from "./workspace-unread";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const WS = "ws-1";
const state = (patch: Record<string, unknown> = {}) => ({
	workspaceId: WS,
	chat: 0,
	files: 0,
	total: 0,
	fileIds: [],
	conversations: [],
	...patch,
});
const cleanups: (() => void)[] = [];
let focused = true;
beforeEach(() => {
	vi.useFakeTimers();
	focused = true;
	vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
	unreadApi.markRead.mockImplementation(async () => state());
	unreadApi.summary.mockResolvedValue({ total: 0, workspaces: [] });
});
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	for (const mock of Object.values(unreadApi)) mock.mockReset();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

async function settle() {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(0);
	});
}

async function mount(element: React.ReactNode) {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	cleanups.push(() => {
		act(() => root.unmount());
		host.remove();
	});
	const render = async (next: React.ReactNode) => {
		await act(async () => {
			root.render(
				<QueryClientProvider client={client}>{next}</QueryClientProvider>,
			);
		});
		await settle();
	};
	await render(element);
	return { host, render };
}

function Probe(props: {
	signal?: unknown;
	conversationId?: string | null;
	outputId?: string | null;
}) {
	const unread = useWorkspaceUnread(WS, {
		signal: props.signal,
		viewing: {
			conversationId: props.conversationId,
			outputId: props.outputId,
		},
	});
	return (
		<output>{unread ? `${unread.chat}/${unread.files}` : "loading"}</output>
	);
}

const marks = () =>
	unreadApi.markRead.mock.calls.map(([input]) => input.target);

describe("useWorkspaceUnread", () => {
	it("records the visit once and marks nothing read that is not on screen", async () => {
		unreadApi.workspace.mockResolvedValue(
			state({
				chat: 2,
				files: 1,
				total: 3,
				fileIds: ["file-1"],
				conversations: [{ conversationId: "chat-1", count: 2 }],
			}),
		);
		unreadApi.markRead.mockImplementation(async () =>
			state({
				chat: 2,
				files: 1,
				total: 3,
				fileIds: ["file-1"],
				conversations: [{ conversationId: "chat-1", count: 2 }],
			}),
		);
		const { host } = await mount(<Probe conversationId="chat-2" />);
		expect(host.textContent).toBe("2/1");
		expect(marks()).toEqual([{ type: "visit" }]);
	});

	it("marks the open conversation and the open file read while the person is looking", async () => {
		const unreadState = state({
			chat: 1,
			files: 1,
			total: 2,
			fileIds: ["file-1"],
			conversations: [{ conversationId: "chat-1", count: 1 }],
		});
		unreadApi.workspace.mockResolvedValue(unreadState);
		unreadApi.markRead.mockImplementation(async ({ target }) =>
			target.type === "visit"
				? unreadState
				: target.type === "chat"
					? state({ files: 1, total: 1, fileIds: ["file-1"] })
					: state(),
		);
		const { host, render } = await mount(<Probe conversationId="chat-1" />);
		expect(marks()).toEqual([
			{ type: "visit" },
			{ type: "chat", conversationId: "chat-1" },
		]);
		expect(host.textContent).toBe("0/1");
		await render(<Probe conversationId="chat-1" outputId="file-1" />);
		expect(marks().at(-1)).toEqual({ type: "file", outputId: "file-1" });
		expect(host.textContent).toBe("0/0");
	});

	it("waits for the person to come back to the tab before marking read", async () => {
		focused = false;
		const unreadState = state({
			chat: 1,
			total: 1,
			conversations: [{ conversationId: "chat-1", count: 1 }],
		});
		unreadApi.workspace.mockResolvedValue(unreadState);
		unreadApi.markRead.mockImplementation(async ({ target }) =>
			target.type === "visit" ? unreadState : state(),
		);
		const { host } = await mount(<Probe conversationId="chat-1" />);
		expect(marks()).toEqual([{ type: "visit" }]);
		expect(host.textContent).toBe("1/0");
		focused = true;
		await act(async () => {
			window.dispatchEvent(new Event("focus"));
		});
		await settle();
		expect(marks().at(-1)).toEqual({ type: "chat", conversationId: "chat-1" });
		expect(host.textContent).toBe("0/0");
	});

	it("re-reads after a file is saved or chat activity is reported, not on a timer", async () => {
		unreadApi.workspace.mockResolvedValue(state());
		const { render } = await mount(<Probe signal="0:0" />);
		expect(unreadApi.workspace).toHaveBeenCalledTimes(1);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(120_000);
		});
		expect(unreadApi.workspace).toHaveBeenCalledTimes(1);
		publishOutputRevisionNotice({
			type: "revision",
			workspaceId: WS,
			outputId: "file-1",
			revisionId: "rev-2",
			revision: 2,
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(2_000);
		});
		expect(unreadApi.workspace).toHaveBeenCalledTimes(2);
		await render(<Probe signal="0:17" />);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(2_000);
		});
		expect(unreadApi.workspace).toHaveBeenCalledTimes(3);
	});
});

describe("useUnreadTotal", () => {
	it("gives the total for an app icon badge and 0 until it is known", async () => {
		let resolve: (value: unknown) => void = () => {};
		unreadApi.summary.mockReturnValue(
			new Promise((done) => {
				resolve = done;
			}),
		);
		function Total() {
			return <output>{useUnreadTotal()}</output>;
		}
		const { host } = await mount(<Total />);
		expect(host.textContent).toBe("0");
		resolve({
			total: 5,
			workspaces: [{ workspaceId: WS, chat: 3, files: 2, total: 5 }],
		});
		await settle();
		expect(host.textContent).toBe("5");
	});
});
