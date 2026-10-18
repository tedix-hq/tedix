import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vite-plus/test";
import { osApi } from "@/lib/api";
import { WorkApprovalDecisionCard } from "./work-approval-decision-card";
import type { WorkDecisionCard } from "./work-decision-card";

vi.mock("@/lib/api", () => ({
	osApi: {
		workApprovals: { decide: vi.fn() },
		learningFeedback: { model: vi.fn() },
		workItems: { getReadiness: vi.fn() },
		workScheduler: { listReady: vi.fn() },
		workFleet: { getControlTower: vi.fn() },
	},
}));
vi.mock("./work-decision-card", () => ({
	WorkDecisionCard: (props: ComponentProps<typeof WorkDecisionCard>) => (
		<section>
			{props.content}
			<button
				disabled={props.disabled}
				onClick={() =>
					void props.onDecision({
						action: "approve",
						body: "",
						signal: "approve-as-is",
					})
				}
			>
				Approve
			</button>
		</section>
	),
}));

it("requires a reason and sends the exact proposal version through the existing approval API", async () => {
	const decide = vi
		.mocked(osApi.workApprovals.decide)
		.mockResolvedValue({ decision: { id: "saved-approval" } } as never);
	const client = new QueryClient();
	const invalidate = vi.spyOn(client, "invalidateQueries");
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	const row = {
		canDecide: true,
		effectiveStatus: "pending",
		workItem: {
			id: "11111111-1111-4111-8111-111111111111",
			title: "Review supplier shortlist",
		},
		proposal: {
			id: "22222222-2222-4222-8222-222222222222",
			version: 7,
			requestedAt: "2026-10-17T12:00:00Z",
			requestRationale: "The shortlist is ready for review.",
			proposal: { budget: 40 },
		},
	} as unknown as ComponentProps<typeof WorkApprovalDecisionCard>["row"];
	try {
		await act(async () =>
			root.render(
				<QueryClientProvider client={client}>
					<WorkApprovalDecisionCard
						row={row}
						onNext={() => {}}
						onPrevious={() => {}}
					/>
				</QueryClientProvider>,
			),
		);
		expect(host.textContent).toContain(row.proposal.requestRationale);
		expect(host.querySelector("button")?.disabled).toBe(true);
		await act(async () => host.querySelector("button")!.click());
		expect(decide).not.toHaveBeenCalled();
		await act(async () => {
			const input = host.querySelector("textarea")!;
			Object.getOwnPropertyDescriptor(
				HTMLTextAreaElement.prototype,
				"value",
			)!.set!.call(input, " The evidence supports this scope. ");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		expect(host.querySelector("button")?.disabled).toBe(false);
		await act(async () => host.querySelector("button")!.click());
		expect(decide).toHaveBeenCalledWith({
			proposalId: row.proposal.id,
			expectedProposalVersion: 7,
			decision: "approved",
			rationale: "The evidence supports this scope.",
		});
		expect(invalidate).toHaveBeenCalledTimes(5);
	} finally {
		await act(async () => root.unmount());
		host.remove();
		client.clear();
	}
});
