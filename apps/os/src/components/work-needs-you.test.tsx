import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import {
	factoryScoreboardQueryOptions,
	pendingApprovalsQueryOptions,
	userProfileQueryOptions,
	workFleetQueryOptions,
	workNeedsYouInteractionsQueryOptions,
	workPendingApprovalsQueryOptions,
	workReadinessProjectionQueryOptions,
} from "@/lib/os-query-options";
import { needsYouSourceCount } from "./work-needs-you-count";
import {
	needsYouCount,
	needsYouItems,
	WorkNeedsYouPage,
} from "./work-needs-you";

const VIEWER = "user-rosa";

function request(
	n: number,
	kind: "question" | "input" | "handoff" | "coordination",
	subject: string,
	overrides: Record<string, unknown> = {},
) {
	return {
		request: {
			id: `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`,
			version: 2,
			kind,
			subject,
			metadata: {},
			requestedAt: `2026-10-1${n}T09:00:00.000Z`,
			...overrides,
		},
		effectiveState: "open",
		canRespond: true,
		workItem: null,
	};
}

const proposal = request(
	1,
	"handoff",
	"Onboarding proposal: Harbor tours launch plan",
	{
		metadata: {
			schema: "tedix.work-proposal.v1",
			proposal: {
				key: "harbor-launch",
				item: { title: "Harbor tours launch plan", sourceIntentId: "intent-1" },
				children: [],
			},
		},
	},
);
const question = request(2, "question", "Which fare table applies in winter?");
const statusUpdate = request(3, "question", "Finished the import", {
	metadata: {
		schema: "tedix.decision-capture.v1",
		attention: { kind: "fyi" },
	},
});

const runtimeApproval = {
	id: "approval-send",
	description: "Send the winter newsletter to 1,200 subscribers",
	createdAt: "2026-10-15T08:00:00.000Z",
	status: "pending" as const,
	review: {
		decisionMode: "approve_or_reject",
		operatorQuestion: "Send it now?",
	},
};

const workApproval = {
	proposal: {
		id: "proposal-1",
		requestedAt: "2026-10-14T08:00:00.000Z",
		requestRationale: "Publish the fare table",
	},
	effectiveStatus: "pending",
	canDecide: true,
	workItem: { id: "item-fares", title: "Publish winter fares" },
};

const failingFactory = {
	kind: "skill_loop" as const,
	id: "loop-digest",
	name: "Daily digest",
	verdict: "failing" as const,
	verdictReason: "Last 3 runs failed",
	lastRunAt: "2026-10-15T06:00:00.000Z",
};

function readinessRow(
	id: string,
	state: string,
	ownerId: string | null,
	title = `Work ${id}`,
) {
	return {
		workItem: {
			id,
			title,
			accountableOwnerType: ownerId ? "user" : null,
			accountableOwnerId: ownerId,
			createdAt: "2026-10-10T00:00:00.000Z",
			updatedAt: "2026-10-12T00:00:00.000Z",
		},
		readiness: {
			state,
			reasons: [{ detail: "Waiting on the venue contract" }],
		},
	};
}

const readiness = [
	readinessRow("item-mine", "dependencies_blocked", VIEWER, "Book the venue"),
	readinessRow("item-ready", "ready", VIEWER),
	readinessRow("item-theirs", "budget_blocked", "user-other"),
];

describe("needsYouItems", () => {
	const items = needsYouItems({
		interactions: [proposal, question, statusUpdate],
		workApprovals: [
			workApproval,
			{
				...workApproval,
				canDecide: false,
				proposal: { ...workApproval.proposal, id: "p-2" },
			},
		],
		runtimeApprovals: [runtimeApproval],
		factories: [
			failingFactory,
			{ ...failingFactory, id: "loop-ok", verdict: "healthy" as never },
		],
		readiness,
		viewerId: VIEWER,
		attention: {
			staleAttemptLeases: 0,
			rejectedAdmissions: 0,
			approvalBacklog: 4,
			interactionBacklog: 9,
			saturatedResources: 0,
			exhaustedBudgets: 2,
			actions: [
				{
					key: "approval_backlog",
					severity: "medium",
					count: 4,
					label: "raw",
					rationale: "raw",
					href: "/work/approvals",
				},
				{
					key: "exhausted_budgets",
					severity: "critical",
					count: 2,
					label: "raw",
					rationale: "raw",
					href: "/work/capacity",
				},
			],
		},
	});

	it("lists approvals, requests, blocked Work, factories, then organization pressure", () => {
		expect(items.map((item) => [item.kind, item.label])).toEqual([
			["Approval", "Send the winter newsletter to 1,200 subscribers"],
			["Approval", "Publish winter fares"],
			["Question", "Which fare table applies in winter?"],
			["Proposal", "Onboarding proposal: Harbor tours launch plan"],
			["Blocked", "Book the venue"],
			["Factory", "Daily digest is failing"],
			["Organization", "Budgets used up"],
		]);
	});

	it("gives each row its one primary action", () => {
		const byKind = Object.fromEntries(
			items.map((item) => [item.label, item.action]),
		);
		expect(byKind["Send the winter newsletter to 1,200 subscribers"]).toEqual({
			type: "approve",
			approvalId: "approval-send",
		});
		expect(byKind["Publish winter fares"]).toEqual({
			type: "link",
			label: "Approve",
			href: "/work/approvals",
		});
		expect(byKind["Which fare table applies in winter?"]).toMatchObject({
			type: "link",
			label: "Answer",
		});
		expect(byKind["Onboarding proposal: Harbor tours launch plan"]).toEqual({
			type: "handoff",
			requestId: proposal.request.id,
			version: 2,
		});
		expect(byKind["Book the venue"]).toEqual({
			type: "link",
			label: "Open",
			href: "/work/items/item-mine",
		});
	});

	it("counts personal rows only, the same way as the sidebar", () => {
		expect(needsYouCount(items)).toBe(6);
		expect(
			needsYouSourceCount({
				interactions: [proposal, question, statusUpdate],
				workApprovals: [workApproval],
				runtimeApprovals: [runtimeApproval],
				factories: [failingFactory],
				readiness,
				viewerId: VIEWER,
			}),
		).toBe(6);
	});

	it("shows no blocked Work until the viewer is known", () => {
		expect(
			needsYouItems({ readiness, viewerId: undefined }).map((i) => i.kind),
		).toEqual([]);
	});
});

describe("WorkNeedsYouPage", () => {
	function seeded() {
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false, staleTime: Infinity } },
		});
		client.setQueryData(workNeedsYouInteractionsQueryOptions().queryKey, {
			data: [proposal, question],
			nextCursor: null,
			hasMore: false,
			observedAt: "2026-10-16T00:00:00.000Z",
		} as never);
		client.setQueryData(workPendingApprovalsQueryOptions().queryKey, {
			data: [workApproval],
			nextCursor: null,
			observedAt: "2026-10-16T00:00:00.000Z",
		} as never);
		client.setQueryData(pendingApprovalsQueryOptions().queryKey, {
			data: [runtimeApproval],
			pagination: { total: 1, limit: 50, offset: 0, hasMore: false },
		} as never);
		client.setQueryData(factoryScoreboardQueryOptions().queryKey, {
			data: [failingFactory],
			since: "2026-10-09T00:00:00.000Z",
		} as never);
		client.setQueryData(workReadinessProjectionQueryOptions().queryKey, {
			data: readiness,
			nextCursor: null,
		} as never);
		client.setQueryData(userProfileQueryOptions().queryKey, {
			id: VIEWER,
		} as never);
		client.setQueryData(workFleetQueryOptions().queryKey, {
			observedAt: "2026-10-16T00:00:00.000Z",
			attention: { actions: [] },
		} as never);
		return client;
	}

	it("shows a pending onboarding proposal and an approval in one list with their actions", () => {
		const doc = new DOMParser().parseFromString(
			renderToStaticMarkup(
				<QueryClientProvider client={seeded()}>
					<WorkNeedsYouPage />
				</QueryClientProvider>,
			),
			"text/html",
		);
		const list = doc.querySelector('[aria-label="Needs you"]');
		const rows = [...(list?.querySelectorAll("li") ?? [])];
		expect(rows.map((row) => row.getAttribute("data-needs-you"))).toEqual([
			"Approval",
			"Approval",
			"Question",
			"Proposal",
			"Blocked",
			"Factory",
		]);
		const proposalRow = rows.find((row) =>
			row.textContent?.includes("Harbor tours launch plan"),
		);
		expect(
			[...(proposalRow?.querySelectorAll("button") ?? [])].map(
				(b) => b.textContent,
			),
		).toEqual(["Accept", "Decline"]);
		const approvalRow = rows.find((row) =>
			row.textContent?.includes("winter newsletter"),
		);
		expect(approvalRow?.querySelector("button")?.textContent).toBe("Approve");
		expect(doc.body.textContent).toContain("6 things wait for you");
	});
});
