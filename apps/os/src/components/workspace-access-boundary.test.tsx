import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useEffect, useId, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { useWorkspaceVerificationPaused } from "@/lib/workspace-verification";
import { osQuery } from "@/lib/os-query-options";
const mocks = vi.hoisted(() => ({
	access: vi.fn(),
	dispose: vi.fn(),
	retired: vi.fn(),
}));
vi.mock("@/lib/api", () => ({
	osApi: { osCollaborators: { access: mocks.access } },
}));
vi.mock("@/lib/capability-lifecycle", () => ({
	disposeOsCapabilities: mocks.dispose,
}));
vi.mock("@/components/shared-workspace-page", () => ({
	SharedWorkspacePage: () => <div>Reopened workspace</div>,
}));
import {
	WorkspaceAccessBoundary,
	WORKSPACE_ACCESS_CHECK_MS,
} from "./workspace-access-boundary";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
	vi.useRealTimers();
	vi.clearAllMocks();
});

describe("open workspace permission changes", () => {
	it("preserves the Canvas identity and two-file local edits through a transient access failure", async () => {
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
			expect(container.querySelector("[data-editor-id]")).toBe(editor);
			expect(container.textContent).toContain("unsynced first|unsynced second");
			expect(editor?.getAttribute("data-paused")).toBe("true");
			expect(container.querySelector("[inert]")).not.toBeNull();
			expect(mocks.retired).not.toHaveBeenCalled();
			expect(mocks.dispose).not.toHaveBeenCalled();
			mocks.access.mockResolvedValue({ role: "build" });
			await act(async () => {
				await vi.advanceTimersByTimeAsync(WORKSPACE_ACCESS_CHECK_MS + 1);
			});
			expect(container.querySelector("[data-editor-id]")).toBe(editor);
			expect(container.textContent).toContain("unsynced first|unsynced second");
			expect(editor?.getAttribute("data-paused")).toBe("false");
			expect(container.querySelector("[inert]")).toBeNull();
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
			{ role: "build" },
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
