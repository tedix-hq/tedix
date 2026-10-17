import { DEFAULT_ATTENTION_LAYOUT } from "@tedix/api-contract/schemas/attention-layout";
import { describe, expect, it, vi } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
vi.mock("@/lib/api", () => ({ osApi: {} }));
vi.mock("@/lib/os-query-options", () => ({
	workAttentionQueryOptions: () => ({}),
	osQueryKeys: {},
}));
import { AttentionBoard } from "./attention-live-view";
it("shows recovery evidence, coverage gaps and bounded-data notice", () => {
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
		"Moving now",
		"Blocked",
		"Done today",
		"Backlog",
		"Stalled",
		"waiting for your decision: choose publishing scope",
		"Needs attention",
		"Docs",
		"bounded overview",
		"Unfiled",
		"Checking results",
	])
		expect(html).toContain(label);
	expect(html).toContain('href="/work/items/item"');
	expect(html).toContain("heartbeat not reported");
	expect(html).not.toContain("Nobody is on");
	expect(html).toContain('href="/work/interactions/decision"');
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
	expect(html).toContain("waiting on you");
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
		href: "/work/agents",
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
