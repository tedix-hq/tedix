import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vite-plus/test";
import { osApi } from "@/lib/api";
import { osQuery } from "@/lib/os-query-options";
import { DecidedForYou } from "./decided-for-you";

vi.mock("@/lib/api", () => ({
	osApi: {
		workInteractions: {
			listDecidedForYou: vi.fn(),
			reopenDelegatedApproval: vi.fn(),
		},
	},
}));

it("shows who decided, what and why, then reopens the exact runtime decision", async () => {
	const input = { limit: 25 };
	const data = {
		data: [
			{
				id: "runtime:approval",
				source: "runtime" as const,
				requestId: "00000000-0000-4000-8000-000000000001",
				subject: "Update the internal record",
				decision: "approved",
				decidedAt: "2026-11-21T12:00:00Z",
				workItemId: null,
				receipt: {
					ownerId: "owner",
					actorType: "tedi" as const,
					actorId: "lead",
					actorName: "Acme lead",
					reason: "The update is reversible and stays in Acme.",
				},
			},
		],
		nextBefore: null,
	};
	vi.mocked(osApi.workInteractions.listDecidedForYou).mockResolvedValue(data);
	vi.mocked(osApi.workInteractions.reopenDelegatedApproval).mockResolvedValue({
		id: "review",
	} as Awaited<
		ReturnType<typeof osApi.workInteractions.reopenDelegatedApproval>
	>);
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Infinity } },
	});
	client.setQueryData(
		osQuery.workInteractions.listDecidedForYou.queryOptions({ input }).queryKey,
		data,
	);
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	try {
		await act(async () =>
			root.render(
				<QueryClientProvider client={client}>
					<DecidedForYou />
				</QueryClientProvider>,
			),
		);
		expect(host.textContent).toContain("Decided for you");
		expect(host.textContent).toContain(
			"Acme lead decided: Update the internal record",
		);
		expect(host.textContent).toContain(
			"Why: The update is reversible and stays in Acme.",
		);
		await act(async () => {
			host.querySelector("button")!.click();
		});
		await vi.waitFor(() =>
			expect(
				osApi.workInteractions.reopenDelegatedApproval,
			).toHaveBeenCalledWith({
				requestId: data.data[0]!.requestId,
				source: "runtime",
			}),
		);
		await act(async () => {
			await Promise.resolve();
		});
		expect(
			host.querySelector('a[href="/work/interactions/review"]')?.textContent,
		).toBe("Open review");
	} finally {
		await act(async () => root.unmount());
		client.clear();
		host.remove();
	}
});
