import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { WorkspaceWorkPanel } from "../src/components/workspace-work-panel";
import {
	workspaceWorkProjectsQueryOptions,
	projectListQueryOptions,
	workGraphItemsQueryOptions,
	projectSprintsQueryOptions,
	projectMilestonesQueryOptions,
	projectActiveAttemptsQueryOptions,
} from "../src/lib/os-query-options";
import "../src/styles.css";

const dark = new URLSearchParams(location.search).get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
document.documentElement.style.colorScheme = dark ? "dark" : "light";
const client = new QueryClient({
	defaultOptions: { queries: { staleTime: Infinity, retry: false } },
});
client.setQueryData(workspaceWorkProjectsQueryOptions("workspace").queryKey, {
	items: [{ id: "link", projectId: "project" }],
	truncated: false,
});
client.setQueryData(projectListQueryOptions(100).queryKey, {
	data: [{ id: "project", name: "Supplier review", key: "SUP" }],
	pagination: { total: 1, limit: 100, offset: 0, hasMore: false },
});
client.setQueryData(
	workGraphItemsQueryOptions({ projectId: "project" }, 100).queryKey,
	{
		data: [
			{
				id: "scheduled",
				title:
					"Review the quarterly supplier onboarding and contract renewal documents",
				disposition: "accepted",
				startAt: "2026-10-24T00:00:00Z",
				durationDays: 3,
			},
			{
				id: "completed",
				title: "Archive the supplier report",
				disposition: "completed",
				startAt: "2026-10-25T00:00:00Z",
				durationDays: 1,
			},
			{
				id: "unscheduled",
				title: "Plan the next review",
				disposition: "proposed",
				startAt: null,
				durationDays: null,
			},
		].map((item) => ({
			...item,
			projectId: "project",
			priority: "medium",
			version: 1,
		})),
		pagination: { total: 3, limit: 100, offset: 0, hasMore: false },
	},
);
client.setQueryData(projectSprintsQueryOptions("project").queryKey, {
	data: [],
});
client.setQueryData(projectMilestonesQueryOptions("project").queryKey, {
	data: [],
	nextCursor: null,
});
client.setQueryData(projectActiveAttemptsQueryOptions("project").queryKey, {
	data: [],
	nextCursor: null,
	hasMore: false,
});
createRoot(document.getElementById("root")!).render(
	<QueryClientProvider client={client}>
		<main className="mx-auto max-w-6xl p-4">
			<WorkspaceWorkPanel workspaceId="workspace" />
		</main>
	</QueryClientProvider>,
);
