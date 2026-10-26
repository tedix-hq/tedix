import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

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
	it.each(["use", "removed"])(
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
				if (role === "removed")
					mocks.access.mockRejectedValue({ code: "FORBIDDEN" });
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
