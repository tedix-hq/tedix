import { describe, expect, it, vi } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
vi.mock("@/lib/api", () => ({ osApi: {} }));
vi.mock("@/lib/os-query-options", () => ({
	workAttentionQueryOptions: () => ({}),
	osQueryKeys: {},
}));
import { AttentionBoard } from "./work-attention-page";
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
		"Docs",
		"bounded overview",
		"Unfiled",
		"Checking results",
	])
		expect(html).toContain(label);
	expect(html).toContain('href="/work/items/item"');
	expect(html).toContain("Not reported");
	expect(html).not.toContain("Nobody is on");
	expect(html).toContain('href="/work/interactions/decision"');
});
