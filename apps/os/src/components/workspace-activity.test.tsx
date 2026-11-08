import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { canvasOutputsQueryOptions, osQuery } from "@/lib/os-query-options";
import { WorkspaceActivity } from "./workspace-activity";

describe("workspace activity", () => {
	it("links only files the person can list and labels the feed incomplete", () => {
		const workspaceId = "8a076b09-73c8-4c07-975a-258c65c36fed";
		const client = new QueryClient();
		const event = {
			workspaceId,
			kind: "output",
			revision: 2,
			occurredAt: "2026-11-08T10:00:00Z",
		};
		client.setQueryData<unknown>(
			osQuery.osWorkspaces.workspaces.activity.queryOptions({
				input: { workspaceId, kinds: ["output"], limit: 50 },
			}).queryKey,
			{
				items: [
					{ ...event, id: "one", entityId: "visible" },
					{ ...event, id: "two", entityId: "hidden", title: "Hidden title" },
					{ ...event, id: "three", entityId: "visible", workspaceId: "other" },
				],
				next: null,
			},
		);
		client.setQueryData<unknown>(
			canvasOutputsQueryOptions(workspaceId).queryKey,
			{
				items: [{ id: "visible", title: "Research notes" }],
				truncated: false,
			},
		);
		const html = renderToStaticMarkup(
			createElement(
				QueryClientProvider,
				{ client },
				createElement(WorkspaceActivity, { workspaceId }),
			),
		);
		expect(html).toContain("/outputs/visible");
		expect(html).toContain("Research notes");
		expect(html).toContain("may be incomplete");
		expect(html).not.toContain("Hidden title");
		expect(html.match(/Research notes/g)).toHaveLength(1);
		client.clear();
	});
});
