import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

const read = vi.hoisted(() => vi.fn());
vi.mock("@/lib/os-query-options", () => ({
	osQuery: {
		skills: {
			getWorkflowStepTediActivity: {
				queryOptions: () => ({ queryKey: ["activity"], queryFn: read }),
			},
		},
	},
}));
import { LinkedTediActivity } from "./run-tedi-activity";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
describe("linked task access", () => {
	it("withholds cached activity and result when a refetch is denied", async () => {
		let deny = false;
		read.mockImplementation(async () => {
			if (deny) throw new Error("Access denied");
			return {
				status: "available",
				activitySource: "linked_tedi_run",
				runStatus: "completed",
				actions: [
					{
						id: "event",
						kind: "tool.completed",
						createdAt: "2026-01-01",
						toolName: "private_tool",
					},
				],
				finalResult: { status: "available", content: "private final" },
				truncated: false,
			};
		});
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);
		const flush = async () =>
			act(async () => {
				for (let i = 0; i < 8; i++)
					await new Promise((resolve) => setTimeout(resolve, 0));
			});
		try {
			act(() =>
				root.render(
					<QueryClientProvider client={client}>
						<LinkedTediActivity
							runId="run"
							executionEpoch={1}
							path="path"
							attempt={1}
						/>
					</QueryClientProvider>,
				),
			);
			await flush();
			expect(host.textContent).toContain("private final");
			expect(host.textContent).toContain("Private tool");
			deny = true;
			await act(async () => {
				await client.invalidateQueries({ queryKey: ["activity"] });
			});
			await flush();
			expect(host.textContent).not.toContain("private final");
			expect(host.textContent).not.toContain("Private tool");
			expect(host.textContent).toContain("Assistant activity unavailable");
		} finally {
			act(() => root.unmount());
			host.remove();
			client.clear();
		}
	});
});
