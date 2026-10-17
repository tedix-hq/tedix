import { describe, expect, it } from "vite-plus/test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkspaceAppRenderer } from "./workspace-app-renderer";
import { osQuery, userProfileQueryOptions } from "@/lib/os-query-options";

const projectId = "11111111-1111-4111-8111-111111111111";
describe("Work workspace app", () => {
	it("renders task posting and Executor through the generic renderer with the configured project", () => {
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false, staleTime: Infinity } },
		});
		client.setQueryData(userProfileQueryOptions().queryKey, {
			id: "fictional-owner",
			email: "owner@example.invalid",
			name: null,
			avatarUrl: null,
			revision: 1,
			updatedAt: null,
		});
		client.setQueryData(
			osQuery.workItems.list.queryOptions({
				input: { projectId, limit: 50, offset: 0 },
			}).queryKey,
			{
				data: [],
				pagination: { hasMore: false, limit: 50, offset: 0, total: 0 },
			},
		);
		const html = renderToStaticMarkup(
			<QueryClientProvider client={client}>
				<WorkspaceAppRenderer
					manifest={{
						entry: "tedix:app/work",
						capabilities: [],
						config: { version: 1, projectId },
					}}
				/>
			</QueryClientProvider>,
		);
		expect(html).toContain("Post a task");
		expect(html).toContain('aria-label="Executor"');
		expect(html).toContain("Accept a posted task");
		client.clear();
	});
	it("rejects a Work app without a valid project", () => {
		const html = renderToStaticMarkup(
			<WorkspaceAppRenderer
				manifest={{
					entry: "tedix:app/work",
					capabilities: [],
					config: { version: 1, projectId: "another-tenant" },
				}}
			/>,
		);
		expect(html).toContain("settings need a fix");
		expect(html).not.toContain("Post a task");
	});
});
