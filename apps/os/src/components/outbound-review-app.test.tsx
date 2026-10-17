import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { LOCAL_OUTBOUND } from "../../dev/outbound-fixture";
import { osQuery } from "@/lib/os-query-options";
import { OutboundReviewApp } from "./outbound-review-app";

vi.mock("./outbound-card", () => ({
	OutboundReviewCard: ({ record }: { record: { title: string } }) => (
		<article>{record.title}</article>
	),
}));
afterEach(() => {
	document.body.innerHTML = "";
});

it("reads its configured project, applies the initial status and searches recipients", async () => {
	const projectId = "33333333-3333-4333-8333-333333333333";
	const client = new QueryClient({
		defaultOptions: { queries: { staleTime: Infinity, retry: false } },
	});
	client.setQueryData(
		osQuery.workInteractions.outbound.list.queryOptions({
			input: { projectId, limit: 25 },
		}).queryKey,
		[
			{
				...LOCAL_OUTBOUND,
				title: "Supplier reply",
				outbound: { ...LOCAL_OUTBOUND.outbound, status: "waiting_on_you" },
			},
			{
				...LOCAL_OUTBOUND,
				workItemId: "44444444-4444-4444-8444-444444444444",
				title: "Already delivered",
				outbound: { ...LOCAL_OUTBOUND.outbound, status: "sent" },
			},
		],
	);
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	try {
		await act(async () =>
			root.render(
				<QueryClientProvider client={client}>
					<OutboundReviewApp
						config={{
							version: 1,
							projectId,
							limit: 25,
							initialStatus: "waiting_on_you",
						}}
					/>
				</QueryClientProvider>,
			),
		);
		expect(host.textContent).toContain("Supplier reply");
		expect(host.textContent).not.toContain("Already delivered");
		const input = host.querySelector<HTMLInputElement>(
			'[aria-label="Find drafts"]',
		)!;
		await act(async () => {
			Object.getOwnPropertyDescriptor(
				HTMLInputElement.prototype,
				"value",
			)!.set!.call(input, "missing-recipient");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		expect(host.textContent).toContain("No drafts match these filters.");
		expect(host.querySelector("article")).toBeNull();
	} finally {
		await act(async () => root.unmount());
		client.clear();
	}
});
