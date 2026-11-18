import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useEffect, useId, useState } from "react";
import { createRoot } from "react-dom/client";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";

import { useWorkspaceVerificationPaused } from "@/lib/workspace-verification";
import { osQuery } from "@/lib/os-query-options";
const mocks = vi.hoisted(() => ({
	access: vi.fn(),
	events: vi.fn(),
	dispose: vi.fn(),
	retired: vi.fn(),
	reopened: vi.fn(),
}));
vi.mock("@/lib/api", () => {
	// Only the two collaborator reads are real here. Every other API path is a
	// callable stub so workspace-wide query keys (invalidated on each event)
	// can still be built.
	const overrides: Record<string, unknown> = {
		"osCollaborators.access": mocks.access,
		"osCollaborators.events": mocks.events,
	};
	const stub = (path: string[]): unknown =>
		new Proxy(() => Promise.resolve({}), {
			get(_target, key) {
				if (typeof key === "symbol" || key === "then") return undefined;
				const next = [...path, key];
				return overrides[next.join(".")] ?? stub(next);
			},
		});
	return { osApi: stub([]) };
});
vi.mock("@/lib/capability-lifecycle", () => ({
	disposeOsCapabilities: mocks.dispose,
}));
vi.mock("@/components/shared-workspace-page", () => ({
	SharedWorkspacePage: function SharedWorkspacePage() {
		useEffect(() => mocks.reopened(), []);
		return <div>Reopened workspace</div>;
	},
}));
import {
	WorkspaceAccessBoundary,
	WORKSPACE_ACCESS_CHECK_MS,
} from "./workspace-access-boundary";
import { WORKSPACE_STREAM_FALLBACK_MS } from "@/lib/workspace-event-stream";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
	// Unless a test opens the stream, the server events are unreachable and the
	// boundary keeps its fast access check.
	mocks.events.mockRejectedValue({
		code: "INTERNAL_SERVER_ERROR",
		status: 503,
	});
});

afterEach(() => {
	vi.useRealTimers();
	vi.clearAllMocks();
});

describe("open workspace permission changes", () => {
	it("keeps the workspace usable through a failed access check and shows a small pill only after retries fail", async () => {
		vi.useFakeTimers();
		mocks.access.mockResolvedValue({ role: "build" });
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const container = document.createElement("div"),
			root = createRoot(container);
		function Editor() {
			const id = useId();
			const paused = useWorkspaceVerificationPaused();
			const [files, setFiles] = useState({ first: "first", second: "second" });
			useEffect(() => () => mocks.retired(), []);
			return (
				<section data-editor-id={id} data-paused={paused}>
					<button
						onClick={() =>
							setFiles({ first: "unsynced first", second: "unsynced second" })
						}
					>
						Type
					</button>
					{files.first}|{files.second}
				</section>
			);
		}
		try {
			await act(async () => {
				root.render(
					<QueryClientProvider client={client}>
						<WorkspaceAccessBoundary workspaceId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa">
							<Editor />
						</WorkspaceAccessBoundary>
					</QueryClientProvider>,
				);
				await vi.advanceTimersByTimeAsync(1);
			});
			await act(async () => {
				await vi.advanceTimersByTimeAsync(1);
			});
			const editor = container.querySelector("[data-editor-id]");
			expect(editor).not.toBeNull();
			act(() => container.querySelector("button")!.click());
			mocks.access.mockRejectedValue({
				code: "INTERNAL_SERVER_ERROR",
				status: 503,
			});
			await act(async () => {
				await vi.advanceTimersByTimeAsync(WORKSPACE_ACCESS_CHECK_MS + 1);
			});
			// One failed check retries quietly; nothing shows yet.
			expect(editor?.getAttribute("data-paused")).toBe("false");
			expect(container.querySelector('[role="status"]')).toBeNull();
			await act(async () => {
				await vi.advanceTimersByTimeAsync(20_000);
			});
			expect(container.querySelector("[data-editor-id]")).toBe(editor);
			expect(container.textContent).toContain("unsynced first|unsynced second");
			expect(editor?.getAttribute("data-paused")).toBe("true");
			expect(container.querySelector("[inert]")).toBeNull();
			expect(container.querySelector('[role="status"]')?.textContent).toMatch(
				/Reconnecting…|Connection lost/,
			);
			expect(mocks.retired).not.toHaveBeenCalled();
			expect(mocks.dispose).not.toHaveBeenCalled();
			mocks.access.mockResolvedValue({ role: "build" });
			await act(async () => {
				await vi.advanceTimersByTimeAsync(WORKSPACE_ACCESS_CHECK_MS + 1);
			});
			expect(container.querySelector("[data-editor-id]")).toBe(editor);
			expect(container.textContent).toContain("unsynced first|unsynced second");
			expect(editor?.getAttribute("data-paused")).toBe("false");
			expect(container.querySelector('[role="status"]')).toBeNull();
		} finally {
			act(() => root.unmount());
			client.clear();
		}
	});

	it("checks access on a slow fallback while the event stream is open and rechecks at once on an access event", async () => {
		vi.useFakeTimers();
		mocks.access.mockResolvedValue({ role: "build" });
		let wake: (value: { cursor: number; kinds: string[] }) => void = () => {};
		mocks.events.mockImplementation((input: { after?: number }) =>
			input.after === undefined
				? Promise.resolve({ cursor: 0, kinds: [] })
				: new Promise((resolve) => {
						wake = resolve;
					}),
		);
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const container = document.createElement("div"),
			root = createRoot(container);
		try {
			await act(async () => {
				root.render(
					<QueryClientProvider client={client}>
						<WorkspaceAccessBoundary workspaceId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa">
							<div>Editor</div>
						</WorkspaceAccessBoundary>
					</QueryClientProvider>,
				);
				await vi.advanceTimersByTimeAsync(1);
			});
			await act(async () => {
				await vi.advanceTimersByTimeAsync(1);
			});
			expect(container.textContent).toContain("Editor");
			const initial = mocks.access.mock.calls.length;
			// The old 3s cadence no longer runs.
			await act(async () => {
				await vi.advanceTimersByTimeAsync(WORKSPACE_ACCESS_CHECK_MS * 5);
			});
			expect(mocks.access).toHaveBeenCalledTimes(initial);
			// An access event refetches immediately.
			await act(async () => {
				wake({ cursor: 1, kinds: ["access"] });
				await vi.advanceTimersByTimeAsync(1);
			});
			expect(mocks.access.mock.calls.length).toBeGreaterThan(initial);
			// The slow fallback still runs.
			const afterEvent = mocks.access.mock.calls.length;
			await act(async () => {
				await vi.advanceTimersByTimeAsync(WORKSPACE_STREAM_FALLBACK_MS + 1);
			});
			expect(mocks.access.mock.calls.length).toBeGreaterThan(afterEvent);
		} finally {
			act(() => root.unmount());
			client.clear();
		}
	});

	it("does not mount private Canvas from cached build access when initial verification fails", async () => {
		vi.useFakeTimers();
		mocks.access.mockRejectedValue({ code: "INTERNAL_SERVER_ERROR" });
		const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		client.setQueryData(
			osQuery.osCollaborators.access.queryOptions({
				input: { workspaceId: id },
			}).queryKey,
			{ role: "build", leave: "organization" },
		);
		const container = document.createElement("div"),
			root = createRoot(container);
		const mount = vi.fn();
		function PrivateCanvas() {
			mount();
			return <div>Private Canvas</div>;
		}
		try {
			await act(async () => {
				root.render(
					<QueryClientProvider client={client}>
						<WorkspaceAccessBoundary workspaceId={id}>
							<PrivateCanvas />
						</WorkspaceAccessBoundary>
					</QueryClientProvider>,
				);
				await vi.advanceTimersByTimeAsync(1);
			});
			expect(mount).not.toHaveBeenCalled();
			expect(container.textContent).not.toContain("Private Canvas");
		} finally {
			act(() => root.unmount());
			client.clear();
		}
	});

	it("keeps the refused page in place while later checks are refused too", async () => {
		vi.useFakeTimers();
		mocks.access.mockRejectedValue({ code: "NOT_FOUND", status: 404 });
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const container = document.createElement("div"),
			root = createRoot(container);
		try {
			await act(async () => {
				root.render(
					<QueryClientProvider client={client}>
						<WorkspaceAccessBoundary workspaceId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa">
							<div>Private Canvas</div>
						</WorkspaceAccessBoundary>
					</QueryClientProvider>,
				);
				await vi.advanceTimersByTimeAsync(1);
			});
			await act(async () => {
				await vi.advanceTimersByTimeAsync(1);
			});
			expect(container.textContent).toBe("Reopened workspace");
			let held: (error: unknown) => void = () => undefined;
			mocks.access.mockImplementation(
				() =>
					new Promise((_resolve, reject) => {
						held = reject;
					}),
			);
			const checks = mocks.access.mock.calls.length;
			await act(async () => {
				await vi.advanceTimersByTimeAsync(WORKSPACE_ACCESS_CHECK_MS);
			});
			// The next check is on its way; the page a person reads must not blink.
			expect(mocks.access.mock.calls.length).toBeGreaterThan(checks);
			expect(container.textContent).toBe("Reopened workspace");
			await act(async () => {
				held({ code: "NOT_FOUND", status: 404 });
				await vi.advanceTimersByTimeAsync(1);
			});
			expect(container.textContent).toBe("Reopened workspace");
			expect(mocks.reopened).toHaveBeenCalledTimes(1);
			expect(container.textContent).not.toContain("Private Canvas");
		} finally {
			act(() => root.unmount());
			client.clear();
		}
	});

	it.each(["use", "removed", "signed-out"])(
		"retires the live view within one poll after access becomes %s",
		async (role) => {
			vi.useFakeTimers();
			mocks.access.mockResolvedValue({ role: "build" });
			const client = new QueryClient({
				defaultOptions: { queries: { retry: false } },
			});
			const container = document.createElement("div");
			const root = createRoot(container);
			function LiveView() {
				useEffect(() => () => mocks.retired(), []);
				return <div>Live editor and chat</div>;
			}
			try {
				await act(async () => {
					root.render(
						<QueryClientProvider client={client}>
							<WorkspaceAccessBoundary workspaceId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa">
								<LiveView />
							</WorkspaceAccessBoundary>
						</QueryClientProvider>,
					);
				});
				await act(async () => {
					await vi.advanceTimersByTimeAsync(1);
				});
				expect(container.textContent).toContain("Live editor and chat");
				if (role === "removed" || role === "signed-out")
					mocks.access.mockRejectedValue({
						code: role === "removed" ? "FORBIDDEN" : "UNAUTHORIZED",
					});
				else mocks.access.mockResolvedValue({ role });
				await act(async () => {
					await vi.advanceTimersByTimeAsync(WORKSPACE_ACCESS_CHECK_MS + 1);
				});
				expect(container.textContent).toBe("Reopened workspace");
				expect(mocks.retired).toHaveBeenCalledOnce();
				expect(mocks.dispose).toHaveBeenCalledOnce();
			} finally {
				act(() => root.unmount());
				client.clear();
			}
		},
	);
});
