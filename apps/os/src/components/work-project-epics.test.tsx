import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vite-plus/test";
import { workCaseListQueryOptions } from "@/lib/os-query-options";
import { ProjectEpics } from "./work-project-epics";

const PROJECT_ID = "33333333-3333-4333-8333-333333333333";

function epic(n: number, stage: string, targetResolutionAt: string | null) {
	return {
		id: `5555555${n}-5555-4555-8555-555555555555`,
		orgId: "22222222-2222-4222-8222-222222222222",
		projectId: PROJECT_ID,
		objectiveId: null,
		kind: "operations",
		title: `Epic ${n}`,
		description: null,
		stage,
		accountableOwnerType: "user",
		accountableOwnerId: "owner-1",
		openedAt: "2026-11-01T00:00:00.000Z",
		targetResolutionAt,
		proofRef: null,
		closedAt: null,
		createdAt: "2026-11-01T00:00:00.000Z",
		updatedAt: null,
		version: 1,
	};
}

it("lists a project's open epics with stage and target date", () => {
	const client = new QueryClient({
		defaultOptions: {
			queries: { enabled: false, retry: false, staleTime: Infinity },
		},
	});
	client.setQueryData<unknown>(
		workCaseListQueryOptions({
			projectId: PROJECT_ID,
			stages: ["investigating", "planning", "executing", "monitoring"],
			limit: 100,
		}).queryKey,
		{
			data: [
				epic(1, "executing", "2026-12-01T00:00:00.000Z"),
				epic(2, "planning", null),
			],
			nextCursor: null,
		},
	);
	const page = new DOMParser().parseFromString(
		renderToStaticMarkup(
			<QueryClientProvider client={client}>
				<ProjectEpics projectId={PROJECT_ID} />
			</QueryClientProvider>,
		),
		"text/html",
	);
	const rows = [...page.querySelectorAll('[aria-label="Open epics"] li')];
	expect(rows).toHaveLength(2);
	expect(rows[0]!.textContent).toContain("Executing");
	expect(rows[0]!.textContent).toMatch(/Target date: .*Dec/);
	expect(rows[0]!.querySelector("a")?.getAttribute("href")).toBe(
		"/work/cases/55555551-5555-4555-8555-555555555555",
	);
	expect(rows[1]!.textContent).toContain("Planning");
	expect(rows[1]!.textContent).toContain("Target date: Not set");
	expect(page.body.textContent).not.toMatch(/milestone|sprint/i);
});
