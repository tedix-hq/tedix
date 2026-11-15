import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { osQuery, pendingApprovalsQueryOptions } from "@/lib/os-query-options";
import { WorkHomeOverview } from "./work-home-overview";
import { workHomeMattersThrough } from "@/lib/work-home-overview";

vi.mock("./activity-running-now", () => ({
	ActivityRunningNow: () => (
		<section aria-label="Running now">
			<a href="/work/items/running-work">Running task</a>
		</section>
	),
}));

afterEach(() => vi.useRealTimers());

it("shows running, stuck reasons, requests and approvals, and this week's Work with record links", () => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-11-15T12:00:00.000Z"));
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Infinity } },
	});
	client.setQueryData<unknown>(
		osQuery.workItems.listReadinessProjection.queryOptions({
			input: { limit: 50 },
		}).queryKey,
		{
			data: [
				{
					workItem: { id: "stuck-work", title: "Parked task" },
					readiness: {
						ready: false,
						state: "dependencies_blocked",
						reasons: [
							{
								code: "dependencies_blocked",
								detail: "Blocked by prerequisite task",
							},
						],
					},
				},
			],
			hasMore: false,
			nextCursor: null,
			observedAt: "2026-11-15T12:00:00.000Z",
		},
	);
	client.setQueryData<unknown>(
		osQuery.workItems.listRecoveryProjection.queryOptions({
			input: { limit: 100 },
		}).queryKey,
		{
			data: [
				{
					id: "failed-work",
					title: "Retry task",
					signals: ["latest_attempt_failed"],
				},
			],
			hasMore: false,
			nextCursor: null,
			observedAt: "2026-11-15T12:00:00.000Z",
		},
	);
	client.setQueryData<unknown>(
		osQuery.workInteractions.listInbox.queryOptions({
			input: { limit: 50, states: ["open"] },
		}).queryKey,
		{ data: [], hasMore: false, nextCursor: null },
	);
	client.setQueryData<unknown>(
		osQuery.workApprovals.listInbox.queryOptions({
			input: { limit: 50, statuses: ["pending"] },
		}).queryKey,
		{
			data: [
				{
					proposal: {
						id: "approval-1",
						requestedAt: "2026-11-15T11:00:00.000Z",
						requestRationale: "Confirm the risk",
					},
					effectiveStatus: "pending",
					canDecide: true,
					workItem: { id: "approval-work", title: "Approve launch" },
				},
			],
			hasMore: false,
			nextCursor: null,
		},
	);
	client.setQueryData<unknown>(pendingApprovalsQueryOptions().queryKey, {
		data: [],
		pagination: { limit: 50, offset: 0, total: 0, hasMore: false },
	});
	client.setQueryData<unknown>(
		osQuery.workItems.list.queryOptions({
			input: {
				disposition: "accepted",
				mattersThrough: workHomeMattersThrough(
					new Date("2026-11-15T12:00:00.000Z"),
				),
				limit: 50,
			},
		}).queryKey,
		{
			data: [
				{
					id: "priority-work",
					title: "Ship important fix",
					priority: "high",
					deadline: null,
					dueDate: null,
				},
				{
					id: "due-work",
					title: "Send the renewal notice",
					priority: "medium",
					deadline: null,
					dueDate: "2026-11-18T12:00:00.000Z",
				},
			],
			pagination: { limit: 50, offset: 0, total: 2, hasMore: false },
		},
	);

	const html = renderToStaticMarkup(
		<QueryClientProvider client={client}>
			<WorkHomeOverview />
		</QueryClientProvider>,
	);
	const page = new DOMParser().parseFromString(html, "text/html");
	for (const name of ["Running now", "Stuck", "Needs you", "This week"])
		expect(page.querySelector(`[aria-label="${name}"]`)).not.toBeNull();
	expect(page.body.textContent).toContain("Blocked by prerequisite task");
	expect(page.body.textContent).toContain("The latest Attempt failed");
	expect(page.body.textContent).toContain("High priority");
	expect(page.body.textContent).toMatch(/Due .*18/);
	expect(page.body.textContent).not.toMatch(/milestone|sprint/i);
	expect(page.querySelector('a[href="/work/items/stuck-work"]')).not.toBeNull();
	expect(
		page.querySelector('a[href="/work/items/failed-work"]'),
	).not.toBeNull();
	expect(
		page.querySelector('a[href="/work/items/approval-work"]'),
	).not.toBeNull();
	expect(
		page.querySelector('a[href="/work/items/priority-work"]'),
	).not.toBeNull();
});
