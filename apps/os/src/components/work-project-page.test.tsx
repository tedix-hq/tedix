import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import {
	projectDetailQueryOptions,
	projectRollupQueryOptions,
	workCaseListQueryOptions,
	workItemListQueryOptions,
} from "@/lib/os-query-options";
import { WorkProjectGoalsPage } from "./work-project-goals-page";

vi.mock("@/components/work-project-contributors", () => ({
	WorkProjectContributors: () => null,
}));
vi.mock("./work-operations-shared", async (importOriginal) => ({
	...(await importOriginal<typeof import("./work-operations-shared")>()),
	useWorkPrincipalNames: () => new Map(),
}));

const PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const GOAL_ID = "44444444-4444-4444-8444-444444444444";

describe("Work project page", () => {
	it("shows its goal and open epics with stage and target date", () => {
		const client = new QueryClient({
			defaultOptions: {
				queries: { enabled: false, retry: false, staleTime: Infinity },
			},
		});
		client.setQueryData(projectDetailQueryOptions(PROJECT_ID).queryKey, {
			id: PROJECT_ID,
			orgId: "22222222-2222-4222-8222-222222222222",
			key: "QUIET-OS",
			name: "Quiet command center",
			description: null,
			status: "active",
			leadTediId: null,
			ownerUserId: "owner-1",
			objectiveId: GOAL_ID,
			objective: {
				id: GOAL_ID,
				title: "Customers trust every export",
				priority: 1,
			},
			targetDate: null,
			metadata: null,
			createdAt: "2026-08-20T00:00:00.000Z",
			updatedAt: null,
			archivedAt: null,
		});
		client.setQueryData(projectRollupQueryOptions(PROJECT_ID).queryKey, {
			projectId: PROJECT_ID,
			total: 0,
			byDisposition: {},
			byWorkKind: {},
			truncated: false,
			percentDone: 0,
			aggregateDisposition: "empty",
			distinctExecutors: [],
			topLevelItems: [],
		});
		client.setQueryData(
			workItemListQueryOptions({ projectId: PROJECT_ID, limit: 100 }).queryKey,
			{
				data: [],
				pagination: { limit: 100, offset: 0, total: 0, hasMore: false },
			},
		);
		client.setQueryData(
			workCaseListQueryOptions({
				projectId: PROJECT_ID,
				stages: ["investigating", "planning", "executing", "monitoring"],
				limit: 100,
			}).queryKey,
			{
				data: [
					{
						id: "55555555-5555-4555-8555-555555555555",
						orgId: "22222222-2222-4222-8222-222222222222",
						projectId: PROJECT_ID,
						objectiveId: GOAL_ID,
						kind: "operations",
						title: "Ship the trusted export",
						description: null,
						stage: "executing",
						accountableOwnerType: "user",
						accountableOwnerId: "owner-1",
						openedAt: "2026-11-01T00:00:00.000Z",
						targetResolutionAt: "2099-11-30T12:00:00.000Z",
						closedAt: null,
						createdAt: "2026-11-01T00:00:00.000Z",
						updatedAt: null,
						version: 1,
					},
				],
				nextCursor: null,
			},
		);

		const html = renderToStaticMarkup(
			<QueryClientProvider client={client}>
				<WorkProjectGoalsPage projectId={PROJECT_ID} />
			</QueryClientProvider>,
		);

		expect(html).toContain("Goal: Customers trust every export");
		expect(html).toContain("Open epics");
		expect(html).toContain("Ship the trusted export");
		expect(html).toContain("Executing");
		expect(html).toMatch(/Nov[^<]*30[^<]*2099/);
		expect(html).not.toContain("Milestone");
		expect(html).not.toContain("Sprint");
	});
});
