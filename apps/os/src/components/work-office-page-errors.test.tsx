import {
	QueryClient,
	QueryClientProvider,
	type QueryKey,
} from "@tanstack/react-query";
import { renderToReadableStream } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import {
	captureHealthQueryOptions,
	notebookLessonsQueryOptions,
	replyDraftAcceptanceQueryOptions,
	replyDraftLeaderboardQueryOptions,
	tediRosterQueryOptions,
	workAgentSessionsQueryOptions,
	workOfficeKnocksQueryOptions,
	workUrgentInteractionsQueryOptions,
} from "@/lib/os-query-options";
import { startOfWeek } from "./office-leaderboard";
import { WorkspaceAppRenderer } from "./workspace-app-renderer";
import { startOfToday } from "@/lib/time";

function failure(client: QueryClient, queryKey: QueryKey) {
	client
		.getQueryCache()
		.build(client, { queryKey })
		.setState({
			status: "error",
			fetchStatus: "idle",
			error: new Error("API rate limit exceeded. Please try again later."),
		});
}

describe("Office failed reads", () => {
	it("shows the failed resource and reason instead of invented zero activity", async () => {
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false, retryOnMount: false } },
		});
		const since = startOfToday();
		for (const queryKey of [
			workOfficeKnocksQueryOptions().queryKey,
			replyDraftAcceptanceQueryOptions(since).queryKey,
			workUrgentInteractionsQueryOptions().queryKey,
			captureHealthQueryOptions(since).queryKey,
			workAgentSessionsQueryOptions().queryKey,
			tediRosterQueryOptions(100).queryKey,
			notebookLessonsQueryOptions().queryKey,
			replyDraftLeaderboardQueryOptions(startOfWeek(), since).queryKey,
		])
			failure(client, queryKey);
		const stream = await renderToReadableStream(
			<QueryClientProvider client={client}>
				<WorkspaceAppRenderer
					workspaceId="11111111-1111-4111-8111-111111111111"
					manifest={{
						entry: "tedix:app/office",
						capabilities: [],
						config: { version: 1 },
					}}
				/>
			</QueryClientProvider>,
		);
		await stream.allReady;
		const html = await new Response(stream).text();
		const text = new DOMParser().parseFromString(html, "text/html").body
			.textContent;
		for (const resource of [
			"knocks",
			"reply outcomes",
			"requests waiting for you",
			"sessions",
			"tedis",
			"notebook",
			"leaderboard",
		])
			expect(text).toContain(
				`Couldn't load ${resource} — API rate limit exceeded.`,
			);
		expect(text).not.toContain("Quiet so far");
		expect(text).not.toContain("Nothing needs you");
		expect(text).not.toContain("No tedis yet");
		expect(text).not.toContain("None yet today");
		expect(text).not.toContain("0 active");
		expect(text).not.toContain("Knocks today0");
	});
});
