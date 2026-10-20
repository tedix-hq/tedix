import { DEFAULT_ATTENTION_LAYOUT } from "@tedix/api-contract/schemas/attention-layout";
import { expect, it, vi } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
vi.mock("@/lib/api", () => ({ osApi: {} }));
vi.mock("@/lib/os-query-options", () => ({
	workAttentionQueryOptions: () => ({}),
	osQueryKeys: {},
}));
import { AttentionBoard } from "./attention-live-view";
it("shows recovery evidence and bounded-data notice", () => {
	const html = renderToStaticMarkup(
		<AttentionBoard
			file={() => {}}
			data={{
				cards: [
					{
						id: "lane",
						who: "Codex",
						title: "Fix search",
						projectId: "search",
						column: "moving",
						startedAt: "2026-10-17T10:00:00Z",
						heartbeatAt: null,
						note: "Checking results",
						href: "/work/items/item",
						source: "attempt",
						activitySource: "local_codex",
					},
				],
				projects: [
					{ id: "docs", name: "Docs", status: "active", active: 0, recent: 0 },
				],
				stalls: [
					{
						scopeId: "docs",
						name: "Docs",
						cause: "blocked on a human decision",
						reason: "waiting for your decision: choose publishing scope",
						href: "/work/interactions/decision",
						requestedAt: "2026-10-17T10:00:00Z",
						needsYou: true,
					},
				],
				unfiled: [],
				truncated: true,
			}}
		/>,
	);
	for (const label of [
		"Running",
		"Blocked",
		"Done today",
		"Backlog",
		"Stalled",
		"waiting for your decision: choose publishing scope",
		"Docs",
		"bounded overview",
		"Automatic filing",
		"Checking results",
	])
		expect(html).toContain(label);
	expect(html).toContain('href="/work/items/item"');
	expect(html).toContain("Heartbeat not reported");
	expect(html).not.toContain("Nobody is on");
	expect(html).not.toContain("Nobody has touched");
	expect(html).toContain('href="/work/interactions/decision"');
});

it("uses factual labels and the viewer's last visit without device explanations", () => {
	const clock = vi
		.spyOn(Date, "now")
		.mockReturnValue(Date.parse("2026-10-17T12:00:00Z"));
	const data = {
		cards: [
			{
				id: "local",
				who: "Claude",
				title: "Review search",
				projectId: null,
				column: "moving" as const,
				startedAt: "2026-10-17T11:00:00Z",
				heartbeatAt: "2026-10-17T11:48:00Z",
				note: "Checking results",
				href: "/work/portfolio",
				source: "session" as const,
				activitySource: "local_codex" as const,
			},
		],
		projects: [],
		unfiled: [],
		truncated: false,
	};
	try {
		const render = (previousVisitAt: string | null) =>
			renderToStaticMarkup(
				<AttentionBoard
					data={data}
					file={() => {}}
					previousVisitAt={previousVisitAt}
				/>,
			);
		const html = render("2026-10-17T11:40:00Z");
		expect(html).toContain("Local session (Codex)");
		expect(html).toContain("Inactive · last seen 12 min ago");
		expect(html).toContain("While you were away");
		expect(html).not.toMatch(/\b(laptop|offline|asleep|Lead|Aaron)\b/i);
		expect(render("2026-10-17T11:55:00Z")).not.toContain("While you were away");
		expect(render(null)).not.toContain("While you were away");
	} finally {
		clock.mockRestore();
	}
});

it("keeps a human handoff prominent without treating it as an offline worker", () => {
	const html = renderToStaticMarkup(
		<AttentionBoard
			file={() => {}}
			data={{
				cards: [
					{
						id: "ask",
						who: "Needs you",
						title: "Confirm the address",
						projectId: null,
						column: "waiting",
						source: "interaction",
						activitySource: "local_codex",
						startedAt: "2026-10-17T10:00:00Z",
						heartbeatAt: null,
						note: "The draft is ready",
						href: "/work/interactions/ask",
					},
				],
				projects: [],
				unfiled: [],
				truncated: false,
			}}
		/>,
	);
	expect(html).toContain("Confirm the address");
	expect(html).toContain("Waiting on you");
	expect(html).not.toContain("Heartbeat not reported");
	expect(html).not.toContain("opacity-65");
	expect(html).not.toContain("Heartbeat stale");
});

it("applies project focus to contributions and attention gaps as well as cards", () => {
	const at = new Date().toISOString();
	const base = {
		who: "Mira",
		title: "Supply check",
		column: "moving" as const,
		startedAt: "2026-10-17T10:00:00Z",
		heartbeatAt: at,
		note: "Checking records",
		href: "/work/portfolio",
		source: "run" as const,
	};
	const html = renderToStaticMarkup(
		<AttentionBoard
			file={() => {}}
			layout={{ ...DEFAULT_ATTENTION_LAYOUT, focusProjectId: "supply" }}
			data={{
				cards: [
					{
						...base,
						id: "supply",
						projectId: "supply",
						tediName: "Supply helper",
					},
					{
						...base,
						id: "search",
						projectId: "search",
						tediName: "Search helper",
						title: "Unrelated search work",
					},
				],
				projects: [
					{
						id: "supply",
						name: "Supply",
						status: "active",
						active: 1,
						recent: 1,
					},
					{
						id: "search",
						name: "Search",
						status: "active",
						active: 0,
						recent: 0,
					},
				],
				unfiled: [],
				truncated: false,
			}}
		/>,
	);
	expect(html).toContain("Supply helper");
	expect(html).not.toContain("Search helper");
	expect(html).not.toContain("Unrelated search work");
	expect(html).not.toContain("Nobody has touched Search");
});

it("keeps raw inactivity out of human attention until the system reports recovery", () => {
	const data = {
		cards: [],
		projects: [
			{
				id: "growth",
				name: "Growth",
				status: "active",
				active: 0,
				recent: 0,
				lastAttentionAt: "2026-10-14T10:00:00Z",
			},
		],
		unattendedObjectives: [
			{
				id: "mission",
				title: "Example mission",
				lastAttentionAt: "2026-10-14T10:00:00Z",
			},
		],
		unfiled: [],
		truncated: false,
	};
	const pending = renderToStaticMarkup(
		<AttentionBoard file={() => {}} data={data} />,
	);
	expect(pending).toContain("Waiting for recovery updates");
	expect(pending).not.toContain("No stalls need your attention");
	expect(pending).not.toContain("Nobody has touched");
	const checked = renderToStaticMarkup(
		<AttentionBoard file={() => {}} data={{ ...data, stalls: [] }} />,
	);
	expect(checked).toContain("Stalled");
	expect(checked).toContain("Tedix handles recovery first");
	expect(checked).not.toContain("Nobody has touched");
	expect(checked).not.toContain("Every tracked goal has recent attention");
});

it("shows automatic destinations, reasons and reversible moves without a filing chore", () => {
	const html = renderToStaticMarkup(
		<AttentionBoard
			file={() => {}}
			data={{
				cards: [],
				projects: [
					{
						id: "docs",
						name: "Documentation",
						status: "active",
						active: 0,
						recent: 0,
					},
				],
				unfiled: [],
				truncated: false,
				automaticFilingEnabled: true,
				pendingFilingCount: 0,
				filings: [
					{
						id: "request",
						text: "Improve guides",
						projectId: "docs",
						previousProjectId: null,
						by: "auto",
						confidence: 0.4,
						reason: "Guides belong with documentation",
						at: "2026-10-17T00:00:00Z",
						review: true,
					},
				],
			}}
		/>,
	);
	for (const label of [
		"Filed to Documentation",
		"auto-filed, needs a better match",
		"Guides belong with documentation",
		"Move:",
	])
		expect(html).toContain(label);
	expect(html).not.toContain("File to project");
});

it.each(["docs", null])(
	"keeps an unknown-confidence request unfiled with suggestion %s",
	(suggestedProjectId) => {
		const html = renderToStaticMarkup(
			<AttentionBoard
				file={() => {}}
				data={{
					cards: [],
					projects: [
						{
							id: "docs",
							name: "Documentation",
							status: "active",
							active: 0,
							recent: 0,
						},
					],
					unfiled: [],
					truncated: false,
					automaticFilingEnabled: true,
					pendingFilingCount: 1,
					filings: [
						{
							id: "pending-request",
							text: "Find a project for the guide",
							projectId: null,
							suggestedProjectId,
							previousProjectId: null,
							by: "auto",
							confidence: null,
							reason: "No confident project match yet",
							at: "2026-10-17T00:00:00Z",
							review: true,
						},
					],
				}}
			/>,
		);
		expect(html).toContain(
			suggestedProjectId ? "Unfiled · suggested Documentation" : "Unfiled",
		);
		expect(html).toContain("needs a better match");
		expect(html).toContain("No confident project match yet");
		expect(html).toContain('aria-label="Move: Find a project for the guide"');
		expect(html).toContain("waiting for a confident project match");
		expect(html).not.toContain("auto-filed");
		expect(html).not.toContain("Filed to Documentation");
		expect(html).not.toContain("All captured requests are filed");
	},
);
