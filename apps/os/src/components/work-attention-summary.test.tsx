import type { WorkFleetControlTower } from "@tedix/api-contract/schemas/work-fleet";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { WorkAttentionSummary } from "./work-attention-summary";

const snapshot: Pick<WorkFleetControlTower, "observedAt" | "attention"> = {
	observedAt: "2026-10-03T09:30:00.000Z",
	attention: {
		staleAttemptLeases: 0,
		rejectedAdmissions: 0,
		approvalBacklog: 2,
		interactionBacklog: 0,
		saturatedResources: 0,
		exhaustedBudgets: 0,
		actions: [
			{
				key: "approval_backlog",
				severity: "medium",
				count: 2,
				label: "Review pending decisions",
				rationale: "Decisions are waiting for their designated approvers.",
				href: "/work/approvals",
			},
		],
	},
};

describe("Work attention", () => {
	it("renders canonical pressure with its record and observation time, separate from personal requests", () => {
		const html = renderToStaticMarkup(
			<WorkAttentionSummary snapshot={snapshot} onRefresh={() => {}} />,
		);
		expect(html).toContain('href="/work/approvals"');
		expect(html).toContain(
			"Decisions are waiting for their designated approvers.",
		);
		expect(html).toContain('dateTime="2026-10-03T09:30:00.000Z"');
		expect(html).toContain("Across your organization");
		expect(html).toContain('href="/work/interactions"');
		expect(html).not.toContain("Needs me");
	});
	it("opens budgets separately from occupied resources", () => {
		const html = renderToStaticMarkup(
			<WorkAttentionSummary
				snapshot={{
					...snapshot,
					attention: {
						...snapshot.attention,
						actions: [
							{
								key: "exhausted_budgets",
								severity: "critical",
								count: 2,
								label: "Restore budget capacity",
								rationale: "raw",
								href: "/work/capacity",
							},
							{
								key: "saturated_resources",
								severity: "high",
								count: 3,
								label: "Relieve resource saturation",
								rationale: "raw",
								href: "/work/capacity",
							},
						],
					},
				}}
				onRefresh={() => {}}
			/>,
		);
		expect(html).toContain(
			'href="/work/capacity?view=budgets&amp;exhausted=true"',
		);
		expect(html).toContain('href="/work/capacity?saturated=true"');
		expect(html).toContain("Review occupied resources");
		expect(html).not.toContain(">Relieve resource saturation<");
	});

	it("does not turn an empty pressure queue into a universal health claim", () => {
		const html = renderToStaticMarkup(
			<WorkAttentionSummary
				snapshot={{
					...snapshot,
					attention: { ...snapshot.attention, actions: [] },
				}}
				onRefresh={() => {}}
			/>,
		);
		expect(html).toContain("No organization-wide blockers were reported");
		expect(html).toContain("Individual work may");
	});
	it("retains the observation timestamp and last actions when refresh fails", () => {
		const html = renderToStaticMarkup(
			<WorkAttentionSummary snapshot={snapshot} error onRefresh={() => {}} />,
		);
		expect(html).toContain("Showing the last observed snapshot");
		expect(html).toContain("Review pending decisions");
		expect(html).toContain("2026-10-03T09:30:00.000Z");
	});
	it("shows unavailable and loading states without inventing a snapshot", () => {
		const unavailable = renderToStaticMarkup(
			<WorkAttentionSummary error onRefresh={() => {}} />,
		);
		expect(unavailable).toContain("Attention refresh unavailable");
		expect(unavailable).not.toContain("No actionable pressure");
		const loading = renderToStaticMarkup(
			<WorkAttentionSummary pending onRefresh={() => {}} />,
		);
		expect(loading).toContain("Loading work attention");
	});
	it("refreshes on demand and prevents concurrent refreshes", () => {
		const refresh = vi.fn();
		const container = document.createElement("div");
		const root = createRoot(container);
		try {
			act(() =>
				root.render(
					<WorkAttentionSummary snapshot={snapshot} onRefresh={refresh} />,
				),
			);
			act(() => container.querySelector("button")?.click());
			expect(refresh).toHaveBeenCalledOnce();
			act(() =>
				root.render(
					<WorkAttentionSummary
						snapshot={snapshot}
						refreshing
						onRefresh={refresh}
					/>,
				),
			);
			expect(container.querySelector("button")?.disabled).toBe(true);
			expect(container.textContent).toContain("Refreshing");
		} finally {
			act(() => root.unmount());
		}
	});
});
