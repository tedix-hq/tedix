import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vite-plus/test";
import { osApi } from "@/lib/api";
import { osQuery } from "@/lib/os-query-options";
import { TODAY_COLUMNS } from "@/lib/today-digest";
import { TodayPost } from "./today-post";
vi.mock("@/lib/api", () => ({
	osApi: {
		osWorkspaces: { outputs: { get: vi.fn() } },
		organizationPurpose: { getActive: vi.fn() },
		attention: { listDeckCards: vi.fn() },
		agentTurnTriage: {
			listLessons: vi.fn().mockResolvedValue({ lessons: [] }),
		},
		skills: { runWorkflow: vi.fn() },
	},
}));
it.each([true, false])(
	"uses the current charter when available (%s), never the saved purpose, and refreshes the same output",
	async (hasCharter) => {
		const config = {
			outputId: "11111111-1111-4111-8111-111111111111",
			skillId: "22222222-2222-4222-8222-222222222222",
			tediId: "33333333-3333-4333-8333-333333333333",
			personId: "fictional-person",
			timeZone: "Europe/Berlin",
		};
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false, staleTime: Infinity } },
		});
		client.setQueryData<unknown>(
			osQuery.attention.listDeckCards.queryOptions({
				input: { limit: 100 },
			}).queryKey,
			{
				cards: [],
				count: 7,
				complete: hasCharter,
				observedAt: new Date().toISOString(),
			},
		);
		client.setQueryData<unknown>(
			osQuery.organizationPurpose.getActive.queryOptions({ input: {} })
				.queryKey,
			{
				charter: hasCharter ? { purpose: "Make customer work easier." } : null,
			},
		);
		client.setQueryData<unknown>(
			osQuery.osWorkspaces.outputs.get.queryOptions({
				input: { outputId: config.outputId },
			}).queryKey,
			{
				currentRevision: {
					content: {
						kind: "document",
						blocks: [
							{ type: "paragraph", text: "Help the team." },
							{ type: "paragraph", text: "Updated today." },
							{ type: "paragraph", text: "6 projects quiet" },
							{
								type: "table",
								headers: TODAY_COLUMNS,
								rows: [
									[
										"Website",
										"Make the page useful.",
										"1 task finished.",
										"Nothing running now.",
										"2",
										"/work/projects/example",
										"/work?view=feed",
										"/work?view=deck",
									],
								],
							},
						],
					},
				},
			},
		);
		vi.mocked(osApi.skills.runWorkflow).mockResolvedValue({
			runId: "run",
			workflowInstanceId: "workflow",
			status: "queued",
			workItemId: null,
			deduplicated: false,
		});
		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);
		try {
			await act(async () =>
				root.render(
					<QueryClientProvider client={client}>
						<TodayPost config={config} onUpdate={() => {}} />
					</QueryClientProvider>,
				),
			);
			expect(host.textContent).not.toContain("Help the team.");
			expect(host.textContent?.includes("Make customer work easier.")).toBe(
				hasCharter,
			);
			expect(host.querySelector('a[href="/work?view=deck"]')?.textContent).toBe(
				hasCharter ? "Needs you 7" : "Open Deck · count unavailable",
			);
			await act(async () => {
				Array.from(host.querySelectorAll("button"))
					.find((b) => b.textContent === "Refresh")!
					.click();
			});
			expect(osApi.skills.runWorkflow).toHaveBeenCalledWith(
				expect.objectContaining({
					params: {
						manual: true,
						outputId: config.outputId,
						personId: config.personId,
						timeZone: config.timeZone,
					},
				}),
			);
			expect(host.textContent).toContain("Refresh requested.");
		} finally {
			await act(async () => root.unmount());
			host.remove();
			client.clear();
		}
	},
);
