import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { DecisionEnvelopeSchema } from "@tedix/api-contract/schemas/os-decision-deck";
import { DeckCardSchema } from "@tedix/api-contract/schemas/attention";
import { osQuery, workAttentionQueryOptions } from "@/lib/os-query-options";
import {
	ActivityOwnerOverview,
	ownerQuestion,
} from "./activity-owner-overview";

vi.mock("./decided-for-you", () => ({
	DecidedForYou: () => <p>Delegated receipts</p>,
}));
vi.mock("@/lib/use-card-schedule", () => ({
	useCardSchedule: () => ({ now: new Date("2026-11-22T12:00:00Z") }),
}));
afterEach(() => vi.restoreAllMocks());

it("keeps irreversible, protected and direction questions with the owner, and excludes routine and handled work", () => {
	const card = DeckCardSchema.parse({
		id: "choice",
		kind: "question",
		label: "Choose the layout",
		project: "area",
		urgency: "later",
		decision: null,
		source: "lead",
		requestedAt: "2026-11-22T10:00:00Z",
		dueAt: null,
		score: 0,
	});
	const decision = DecisionEnvelopeSchema.parse({
		version: 1,
		kind: "question",
		classId: "layout",
		proposal: "Choose the layout",
		whyNow: "Ready to build",
		recommendation: "Use the compact layout",
		reversibility: "two_way",
		blastRadius: "Internal",
		confidence: 1,
		costOfWaiting: "No work starts",
		reasoning: "Fits the brief",
		options: [
			{
				id: "yes",
				label: "Use it",
				intent: "approve",
				consequence: "Build it",
				cost: "None",
			},
			{
				id: "no",
				label: "Keep it",
				intent: "reject",
				consequence: "Keep the layout",
				cost: "None",
			},
		],
	});
	expect(ownerQuestion({ ...card, decision })).toBe(false);
	for (const change of [
		{ reversibility: "one_way" as const },
		{ reversibility: "unknown" as const },
		{ tasteOrStrategy: true },
		{ protectedEffects: ["money" as const] },
		{ protectedEffects: ["message" as const] },
	])
		expect(
			ownerQuestion({ ...card, decision: { ...decision, ...change } }),
		).toBe(true);
	expect(ownerQuestion({ ...card, kind: "outbound" })).toBe(true);
	expect(ownerQuestion({ ...card, kind: "approval", handled: true })).toBe(
		false,
	);
	expect(ownerQuestion({ ...card, kind: "approval", expired: true })).toBe(
		false,
	);
});

it("groups Claude and Codex in their area and never calls finished work deployed without a release report", () => {
	const client = new QueryClient({
		defaultOptions: { queries: { staleTime: Infinity, retry: false } },
	});
	client.setQueryData<unknown>(
		osQuery.attention.listDeckCards.queryOptions({
			input: { limit: 100, presentation: "stored" },
		}).queryKey,
		{ cards: [], complete: false },
	);
	client.setQueryData<unknown>(
		osQuery.projects.getPortfolio.queryOptions({ input: {} }).queryKey,
		{
			data: [
				{
					project: {
						id: "area",
						name: "Product",
						status: "active",
						metadata: {},
					},
					health: "on_track",
					next: { id: "next", title: "Review the plan" },
				},
			],
		},
	);
	const base = {
		projectId: "area",
		column: "moving",
		heartbeatAt: "2026-11-22T11:59:00Z",
		source: "session",
		note: "Working",
		href: "/work/items/example",
	};
	client.setQueryData<unknown>(workAttentionQueryOptions().queryKey, {
		projects: [],
		cards: [
			{
				...base,
				id: "claude",
				title: "Design the editor",
				activitySource: "local_claude",
			},
			{
				...base,
				id: "codex",
				title: "Build the editor",
				activitySource: "local_codex",
			},
			{
				...base,
				id: "done",
				title: "Completed source",
				column: "done",
				finishedAt: "2026-11-22T11:00:00Z",
				note: "The source landed.",
			},
		],
	});
	const render = () =>
		new DOMParser().parseFromString(
			renderToStaticMarkup(
				<QueryClientProvider client={client}>
					<ActivityOwnerOverview />
				</QueryClientProvider>,
			),
			"text/html",
		);
	let page = render();
	const running = page.querySelector('[aria-label="Running by area"]')!;
	expect(running.querySelectorAll("h3")).toHaveLength(1);
	expect(running.textContent).toContain("Product");
	expect(running.textContent).toContain("Claude");
	expect(running.textContent).toContain("Codex");
	expect(page.querySelector('[aria-label="By area"]')?.textContent).toContain(
		"Today: The source landed. · Next: Review the plan",
	);
	expect(
		page.querySelector('[aria-label="Live and held"]')?.textContent,
	).toContain("Deployment state is unknown");
	expect(page.querySelector('[aria-label="Needs you"]')?.textContent).toContain(
		"list is incomplete",
	);
	client.setQueryData<unknown>(
		osQuery.projects.getPortfolio.queryOptions({ input: {} }).queryKey,
		{
			data: [
				{
					project: {
						id: "area",
						name: "Product",
						status: "active",
						metadata: {
							activityOverview: {
								observedAt: "2026-11-22T12:00:00Z",
								changed: "Editor released",
								next: "Check adoption",
								releases: [
									{
										state: "held",
										label: "Editor update",
										detail: "Waiting for compatibility review",
										at: "2026-11-22T11:00:00Z",
										href: "/work/items/00000000-0000-4000-8000-000000000001",
									},
								],
							},
						},
					},
					next: null,
					health: null,
				},
			],
		},
	);
	page = render();
	expect(
		page.querySelector('[aria-label="Live and held"]')?.textContent,
	).toContain(
		"Held · Product · Editor update · Waiting for compatibility review",
	);
	client.clear();
});
