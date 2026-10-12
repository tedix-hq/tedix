import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { workProjectContributorsQueryOptions } from "@/lib/os-query-options";
import { WorkProjectContributors } from "./work-project-contributors";

const PROJECT_ID = "00000076-0000-4000-8000-000000000001";
const WORK_ITEM_ID = "00000070-0000-4000-8000-000000000001";
const NOW = new Date("2026-10-12T12:00:00.000Z");
const ago = (minutes: number) =>
	new Date(NOW.getTime() - minutes * 60_000).toISOString();

function render(contributors: unknown[] | undefined) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Infinity } },
	});
	if (contributors)
		client.setQueryData(
			workProjectContributorsQueryOptions(PROJECT_ID).queryKey,
			{ contributors } as never,
		);
	return new DOMParser().parseFromString(
		renderToStaticMarkup(
			<QueryClientProvider client={client}>
				<WorkProjectContributors projectId={PROJECT_ID} now={NOW} />
			</QueryClientProvider>,
		),
		"text/html",
	);
}

describe("Project contributors", () => {
	it("renders one row per session with state, Work item link and attempts", () => {
		const doc = render([
			{
				sessionKey: "claude-code:session-1",
				harness: "claude-code",
				name: "billing · invoices",
				state: "working",
				summary: "Running tests",
				lastActivityAt: ago(5),
				workItemId: WORK_ITEM_ID,
				workItemTitle: "Rebuild the invoice export",
				attempts: 2,
			},
			{
				sessionKey: "codex:session-2",
				harness: "codex",
				name: "docs · refresh",
				state: "ended",
				summary: "Session closed.",
				lastActivityAt: ago(60 * 3),
				workItemId: null,
				workItemTitle: null,
				attempts: 0,
			},
		]);
		const rows = [...doc.querySelectorAll("li[data-contributor-state]")];
		expect(
			rows.map((row) => row.getAttribute("data-contributor-state")),
		).toEqual(["working", "ended"]);
		expect(rows[0]?.textContent).toContain("Claude Code");
		expect(rows[0]?.textContent).toContain("Working");
		expect(rows[0]?.textContent).toContain("2 attempts");
		expect(rows[0]?.textContent).toContain("5m ago");
		expect(
			rows[0]?.querySelector(`a[href="/work/items/${WORK_ITEM_ID}"]`)
				?.textContent,
		).toBe("Rebuild the invoice export");
		expect(rows[1]?.textContent).toContain("Codex");
		expect(rows[1]?.textContent).toContain("Ended");
		expect(rows[1]?.textContent).not.toContain("attempt");
		expect(rows[1]?.querySelector("a")).toBeNull();
		expect(doc.body.textContent).toContain("Contributors (2)");
	});

	it("explains when no session has worked on the project", () => {
		const doc = render([]);
		expect(doc.body.textContent).toContain(
			"No sessions have worked on this project yet.",
		);
		expect(doc.querySelector("li")).toBeNull();
	});
});
