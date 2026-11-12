import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { osQuery } from "@/lib/os-query-options";
import { WorkspaceActivity } from "./workspace-activity";

describe("workspace activity", () => {
	it("shows verified file links and action provenance while labeling history incomplete", () => {
		const workspaceId = "8a076b09-73c8-4c07-975a-258c65c36fed";
		const client = new QueryClient();
		const event = {
			workspaceId,
			kind: "output",
			revision: 2,
			occurredAt: "2026-11-08T10:00:00Z",
			actor: { kind: "external_agent", id: "agent-1" },
			changeRecordId: "record-1",
		};
		client.setQueryData<unknown>(
			osQuery.osWorkspaces.workspaces.activity.infiniteOptions({
				input: (before: string | undefined) => ({
					workspaceId,
					kinds: ["output", "run"],
					limit: 50,
					...(before ? { before } : {}),
				}),
				initialPageParam: undefined as string | undefined,
				getNextPageParam: (page) => page.next ?? undefined,
			}).queryKey,
			{
				pageParams: [undefined],
				pages: [
					{
						items: [
							{
								...event,
								id: "one",
								entityId: "visible",
								title: "Research notes",
								artifact: { outputId: "visible", revisionId: "rev-2" },
							},
							{
								...event,
								id: "action",
								kind: "run",
								entityId: "action-1",
								action: {
									resource: "work",
									operation: "list",
									outcome: "applied",
									surface: "workspace_object",
								},
							},
							{
								...event,
								id: "two",
								entityId: "hidden",
								title: "Hidden title",
							},
							{
								...event,
								id: "three",
								entityId: "visible",
								workspaceId: "other",
							},
						],
						next: null,
					},
				],
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
		expect(html).toContain("work.list · applied");
		expect(html).toContain("agent-1");
		expect(html).toContain("record-1");
		expect(html).not.toContain("Hidden title");
		expect(html.match(/Research notes/g)).toHaveLength(1);
		client.clear();
	});
});
