import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createRootRoute,
	createRoute,
	createRouter,
	createMemoryHistory,
	Outlet,
	RouterProvider,
} from "@tanstack/react-router";
import { workInteractionDetailQueryOptions } from "@/lib/os-query-options";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
	membersListQueryOptions,
	tediRosterQueryOptions,
	workExternalPrincipalsQueryOptions,
	workApprovalsQueryOptions,
	workFleetQueryOptions,
	pendingApprovalsQueryOptions,
	workBudgetEnvelopesQueryOptions,
	workCaseDetailQueryOptions,
	workCaseListQueryOptions,
	workInteractionsQueryOptions,
	workItemAttemptsQueryOptions,
	workItemEvidenceQueryOptions,
	workItemDetailQueryOptions,
	osQueryKeys,
	workResourcePoolsQueryOptions,
	workUrgentInteractionsQueryOptions,
} from "@/lib/os-query-options";
import {
	ResourcePressureLinks,
	workCapacitySearch,
	workInteractionsSearch,
	WorkInteractionsRoute,
	WorkControlPage,
	WorkApprovalsPage,
	BudgetScopeLink,
	ResourceHolders,
	namedWorkPrincipal,
	WorkInteractionPage,
	ApprovalRequestError,
	PageControls,
	SchedulerTruncationWarnings,
	useCursorPaging,
	urgentInteractionSummary,
} from "./work-operations-pages";

type Paging = ReturnType<typeof useCursorPaging<string>>;
let paging: Paging | undefined;
let root: ReturnType<typeof createRoot> | undefined;

function Harness() {
	const current = useCursorPaging<string>();
	paging = current;
	return (
		<PageControls
			hasPrevious={current.hasPrevious}
			hasNext
			onPrevious={current.reset}
			onBack={current.previous}
			onNext={() => current.next("next-cursor")}
		/>
	);
}

afterEach(() => {
	if (root) act(() => root?.unmount());
	root = undefined;
	paging = undefined;
});

describe("Request scope navigation", () => {
	it("preserves the personal default and rejects unknown filters", () => {
		expect(workInteractionsSearch({})).toEqual({ view: "inbox", state: "all" });
		expect(
			workInteractionsSearch({ view: "other", state: "resolved" }),
		).toEqual({ view: "inbox", state: "all" });
		expect(workInteractionsSearch({ view: "audit", state: "open" })).toEqual({
			view: "audit",
			state: "open",
		});
	});

	it("keeps organization counts separate from the personal inbox action", () => {
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false, staleTime: Infinity } },
		});
		client.setQueryData<unknown>(workFleetQueryOptions().queryKey, {
			observedAt: "2026-10-03T15:00:00Z",
			attention: { actions: [] },
			attempts: { active: 3, staleLeases: 0 },
			approvals: { awaitingDecision: 0 },
			interactions: { awaitingResponse: 5, overdue: 1 },
			admissions: { latestRejected: 0 },
			resources: { saturatedResourceKeys: [] },
		});
		const html = renderToStaticMarkup(
			<QueryClientProvider client={client}>
				<WorkControlPage />
			</QueryClientProvider>,
		);
		expect(html).toContain(
			'href="/work/interactions?view=audit&amp;state=open"',
		);
		expect(html).toContain("Organization requests");
		expect(html).toContain('href="/work/interactions"');
		expect(html).toContain("My requests");
		expect(html).toContain('href="/work?disposition=completed"');
		expect(html).toContain('href="/work/attempts?view=active"');
	});

	it("opens organization pending requests from a URL and preserves personal scope on back", async () => {
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false, staleTime: Infinity } },
		});
		client.setQueryData(
			workInteractionsQueryOptions(undefined, "audit", ["open"]).queryKey,
			{
				data: [],
				hasMore: false,
				nextCursor: null,
				observedAt: "2026-10-03T15:00:00Z",
			},
		);
		client.setQueryData(workInteractionsQueryOptions().queryKey, {
			data: [],
			hasMore: false,
			nextCursor: null,
			observedAt: "2026-10-03T15:00:00Z",
		});
		client.setQueryData(workUrgentInteractionsQueryOptions().queryKey, {
			data: [],
			hasMore: false,
			nextCursor: null,
			observedAt: "2026-10-03T15:00:00Z",
		});
		const routeRoot = createRootRoute({ component: Outlet });
		const route = createRoute({
			getParentRoute: () => routeRoot,
			path: "/work/interactions",
			validateSearch: workInteractionsSearch,
			component: WorkInteractionsRoute,
		});
		const router = createRouter({
			routeTree: routeRoot.addChildren([route]),
			history: createMemoryHistory({ initialEntries: ["/work/interactions"] }),
		});
		await router.load();
		const container = document.createElement("div");
		root = createRoot(container);
		await act(async () =>
			root?.render(
				<QueryClientProvider client={client}>
					<RouterProvider router={router} />
				</QueryClientProvider>,
			),
		);
		expect(container.textContent).toContain("Nothing assigned to you");
		await act(async () => {
			await router.navigate({
				to: "/work/interactions",
				search: { view: "audit", state: "open" },
			});
		});
		expect(container.textContent).toContain("No open organization requests");
		expect(container.textContent).not.toContain("Nothing assigned to you");
		expect(
			container.querySelector('[role="tab"][aria-selected="true"]')
				?.textContent,
		).toBe("Organization");
		await act(async () => {
			router.history.back();
			await router.load();
		});
		expect(container.textContent).toContain("Nothing assigned to you");
	});
});

describe("Needs you now", () => {
	const emptyPage = {
		data: [],
		hasMore: false,
		nextCursor: null,
		observedAt: "2026-10-03T15:00:00Z",
	};

	it("puts plain-language reasons into words and keeps unknown labels readable", () => {
		expect(
			urgentInteractionSummary({
				schema: "tedix.decision-capture.v1",
				host: "codex",
				sessionId: "0f3b9c2e-1111-4222-8333-444455556666",
				repository: "acme-app",
				triage: {
					urgentLabels: [
						"blocker_or_failure",
						"human_only_action",
						"risky_action",
						"new_label",
					],
				},
			}),
		).toEqual({
			reasons: ["Blocked", "Needs you to act", "Risky action", "New label"],
			origin: ["acme-app", "codex", "session 0f3b9c2e"],
			sessionId: "0f3b9c2e-1111-4222-8333-444455556666",
		});
		expect(urgentInteractionSummary({ triage: "bad" })).toEqual({
			reasons: [],
			origin: [],
			sessionId: undefined,
		});
	});

	it("shows urgent open requests above the assigned list only in the inbox", async () => {
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false, staleTime: Infinity } },
		});
		client.setQueryData(workInteractionsQueryOptions().queryKey, emptyPage);
		client.setQueryData(
			workInteractionsQueryOptions(undefined, "outbox").queryKey,
			emptyPage,
		);
		client.setQueryData(workUrgentInteractionsQueryOptions().queryKey, {
			...emptyPage,
			data: [
				{
					request: {
						id: "9b3cbf40-9b22-46c9-8913-c9643bf9a7be",
						orgId: "22222222-2222-4222-8222-222222222222",
						workItemId: null,
						caseId: null,
						projectId: "33333333-3333-4333-8333-333333333333",
						creatorSessionId: null,
						state: "open",
						requestedAt: "2026-10-03T14:00:00Z",
						dueAt: null,
						expiresAt: null,
						resolvedAt: null,
						metadata: {
							schema: "tedix.decision-capture.v1",
							host: "claude-code",
							sessionId: "abcdef12-0000-4000-8000-000000000000",
							repository: "acme-app",
							triage: {
								status: "ok",
								urgency: "now",
								urgentLabels: ["blocker_or_failure"],
							},
						},
						subject: "acme-app · claude-code waiting: deploy failed",
						kind: "question",
						version: 1,
						creatorType: "user",
						creatorId: "user-1",
						requestedFromType: "user",
						requestedFromId: "user-1",
						prompt: "The deploy failed.",
					},
					effectiveState: "open",
					canRespond: true,
					canCancel: false,
					workItem: null,
					responseCount: 0,
				},
			],
		});
		const routeRoot = createRootRoute({ component: Outlet });
		const route = createRoute({
			getParentRoute: () => routeRoot,
			path: "/work/interactions",
			validateSearch: workInteractionsSearch,
			component: WorkInteractionsRoute,
		});
		const router = createRouter({
			routeTree: routeRoot.addChildren([route]),
			history: createMemoryHistory({ initialEntries: ["/work/interactions"] }),
		});
		await router.load();
		const container = document.createElement("div");
		root = createRoot(container);
		await act(async () =>
			root?.render(
				<QueryClientProvider client={client}>
					<RouterProvider router={router} />
				</QueryClientProvider>,
			),
		);
		const text = container.textContent ?? "";
		expect(text).toContain("Needs you now");
		expect(text).toContain("Blocked");
		expect(text).toContain("acme-app · claude-code · session abcdef12");
		expect(text.indexOf("Needs you now")).toBeLessThan(
			text.indexOf("Nothing assigned to you"),
		);
		await act(async () => {
			await router.navigate({
				to: "/work/interactions",
				search: { view: "outbox", state: "all" },
			});
		});
		expect(container.textContent).not.toContain("Needs you now");
	});
});

describe("Work approval request errors", () => {
	it("keeps actionable decisions visible and other decisions collapsed until opened", async () => {
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false, staleTime: Infinity } },
		});
		const row = (id: string, title: string, canDecide: boolean) => ({
			proposal: {
				id,
				workItemId: id,
				action: "admission",
				proposal: { risk: "high" },
				authorityKey: "risk:high",
				version: 1,
				expiresAt: "2026-10-04T15:00:00Z",
				requestRationale: "Review bounded change",
			},
			workItem: { id, title },
			effectiveStatus: "pending",
			canDecide,
		});
		client.setQueryData<unknown>(workApprovalsQueryOptions().queryKey, {
			data: [
				row("mine", "Decision I can make", true),
				row("other", "Decision for another approver", false),
			],
			hasMore: false,
			nextCursor: null,
		});
		client.setQueryData<unknown>(pendingApprovalsQueryOptions().queryKey, {
			data: [],
			total: 0,
		});
		const container = document.createElement("div");
		root = createRoot(container);
		await act(async () =>
			root?.render(
				<QueryClientProvider client={client}>
					<WorkApprovalsPage />
				</QueryClientProvider>,
			),
		);
		expect(container.textContent).toContain("Decision I can make");
		expect(container.textContent).not.toContain(
			"Decision for another approver",
		);
		const trigger = Array.from(container.querySelectorAll("button")).find(
			(button) => button.textContent?.includes("Other decisions and history"),
		);
		expect(trigger?.getAttribute("aria-expanded")).toBe("false");
		await act(async () => trigger?.click());
		expect(trigger?.getAttribute("aria-expanded")).toBe("true");
		expect(container.textContent).toContain("Decision for another approver");
		expect(container.textContent).toContain("Decision I can make");
	});

	it("explains self-request rejection while preserving other errors", () => {
		const html = renderToStaticMarkup(
			<ApprovalRequestError
				error={new Error("Requester cannot approve its own proposal")}
			/>,
		);
		expect(html).toContain("Choose a different approver");
		expect(html).toContain("inbox above");
		expect(
			renderToStaticMarkup(
				<ApprovalRequestError error={new Error("Network unavailable")} />,
			),
		).toContain("Network unavailable");
		expect(renderToStaticMarkup(<ApprovalRequestError error={null} />)).toBe(
			"",
		);
	});
});

describe("Work factory cursor navigation", () => {
	it("moves forward, back, and resets without losing the previous cursor", () => {
		const container = document.createElement("div");
		root = createRoot(container);
		act(() => root?.render(<Harness />));

		expect(paging?.cursor).toBeUndefined();
		expect(paging?.hasPrevious).toBe(false);
		act(() => paging?.next("cursor-1"));
		expect(paging?.cursor).toBe("cursor-1");
		expect(paging?.hasPrevious).toBe(true);
		act(() => paging?.next("cursor-2"));
		expect(paging?.cursor).toBe("cursor-2");
		act(() => paging?.previous());
		expect(paging?.cursor).toBe("cursor-1");
		act(() => paging?.reset());
		expect(paging?.cursor).toBeUndefined();
		expect(paging?.hasPrevious).toBe(false);
		expect(container.textContent).toContain("First pageBackNext page");
	});

	it("puts every server cursor into its contract-derived query key", () => {
		const stable = {
			at: "2026-08-20T00:00:00.000Z",
			id: "11111111-1111-4111-8111-111111111111",
		};
		const keys = [
			workCaseListQueryOptions({ limit: 50, cursor: stable }).queryKey,
			workApprovalsQueryOptions(stable).queryKey,
			workInteractionsQueryOptions(stable).queryKey,
			workInteractionsQueryOptions(stable, "outbox").queryKey,
			workInteractionsQueryOptions(stable, "audit").queryKey,
			workResourcePoolsQueryOptions(stable.id).queryKey,
			workBudgetEnvelopesQueryOptions(stable.id).queryKey,
			workCaseDetailQueryOptions(stable.id, stable.id, stable.id).queryKey,
			workItemAttemptsQueryOptions(stable.id, stable).queryKey,
			workItemEvidenceQueryOptions(stable.id, stable).queryKey,
		];
		for (const key of keys) expect(JSON.stringify(key)).toContain(stable.id);
		expect(workInteractionsQueryOptions(stable, "outbox").queryKey).not.toEqual(
			workInteractionsQueryOptions(stable).queryKey,
		);
		expect(workInteractionsQueryOptions(stable, "audit").queryKey).not.toEqual(
			workInteractionsQueryOptions(stable).queryKey,
		);
		const pagedAndPrefixes = [
			[
				workCaseListQueryOptions({ limit: 50, cursor: stable }).queryKey,
				osQueryKeys.workCases(),
			],
			[workApprovalsQueryOptions(stable).queryKey, osQueryKeys.workApprovals()],
			[
				workInteractionsQueryOptions(stable).queryKey,
				osQueryKeys.workInteractions(),
			],
			[
				workResourcePoolsQueryOptions(stable.id).queryKey,
				osQueryKeys.workResourcePools(),
			],
			[
				workBudgetEnvelopesQueryOptions(stable.id).queryKey,
				osQueryKeys.workBudgetEnvelopes(),
			],
		] as const;
		for (const [paged, prefix] of pagedAndPrefixes) {
			expect(paged[0]).toEqual(prefix[0]);
			expect(paged[1]).toMatchObject(prefix[1] ?? {});
		}
	});

	it("invalidates every cached approval cursor page through the domain key", async () => {
		const client = new QueryClient();
		const first = workApprovalsQueryOptions();
		const older = workApprovalsQueryOptions({
			at: "2026-08-20T00:00:00.000Z",
			id: "11111111-1111-4111-8111-111111111111",
		});
		const emptyPage = {
			data: [],
			nextCursor: null,
			hasMore: false,
			observedAt: "2026-08-20T00:00:00.000Z",
		};
		client.setQueryData(first.queryKey, emptyPage);
		client.setQueryData(older.queryKey, emptyPage);

		await client.invalidateQueries({
			queryKey: osQueryKeys.workApprovals(),
			refetchType: "none",
		});

		expect(client.getQueryState(first.queryKey)?.isInvalidated).toBe(true);
		expect(client.getQueryState(older.queryKey)?.isInvalidated).toBe(true);
	});
});

describe("scheduler truncation warnings", () => {
	it("distinguishes fail-closed admission facts from approximate graph ranking", () => {
		const hardFacts = renderToStaticMarkup(
			<SchedulerTruncationWarnings
				factsTruncated
				truncatedFacts={["dependencies", "capabilities", "approvals", "cases"]}
				graphTruncated={false}
			/>,
		);
		expect(hardFacts).toContain("Admission facts incomplete");
		expect(hardFacts).toContain("Affected candidates are withheld");
		expect(hardFacts).toContain("Dependencies, Capabilities, Approvals, Cases");
		expect(hardFacts).not.toContain("Dependency ranking is approximate");

		const graph = renderToStaticMarkup(
			<SchedulerTruncationWarnings
				factsTruncated={false}
				truncatedFacts={[]}
				graphTruncated
			/>,
		);
		expect(graph).toContain("Dependency ranking is approximate");
		expect(graph).toContain("passed hard admission gates");
		expect(graph).not.toContain("Admission facts incomplete");
	});
});

describe("Work request and capacity navigation", () => {
	it("links exact pressure keys and bounds the overview without hiding the full destination", () => {
		const html = renderToStaticMarkup(
			<ResourcePressureLinks
				resourceKeys={[
					"release:os",
					...Array.from({ length: 8 }, (_, index) => `scope:${index}`),
				]}
			/>,
		);
		expect(html).toContain('href="/work/capacity?resourceKey=release%3Aos"');
		expect(html).not.toContain("resourceKey=scope%3A7");
		expect(html).toContain('href="/work/capacity?saturated=true"');
		expect(html).toContain("See all 9 saturated pools");
	});

	it("opens capacity pressure by default and preserves explicit all-pool and exact-resource journeys", () => {
		expect(workCapacitySearch({})).toEqual({
			resourceKey: undefined,
			view: "resources",
			exhausted: false,
			saturated: true,
		});
		expect(workCapacitySearch({ saturated: "false" })).toEqual({
			resourceKey: undefined,
			view: "resources",
			exhausted: false,
			saturated: false,
		});
		expect(workCapacitySearch({ saturated: false }).saturated).toBe(false);
		expect(workCapacitySearch({ resourceKey: "release:os" })).toEqual({
			resourceKey: "release:os",
			view: "resources",
			exhausted: false,
			saturated: false,
		});
		expect(
			workCapacitySearch({ resourceKey: "release:os", saturated: "true" })
				.saturated,
		).toBe(true);
		expect(workCapacitySearch({ resourceKey: "x".repeat(301) })).toEqual({
			resourceKey: undefined,
			view: "resources",
			exhausted: false,
			saturated: true,
		});
	});

	it("validates budget focus without changing exact resource navigation", () => {
		expect(
			workCapacitySearch({ view: "budgets", exhausted: "true" }),
		).toMatchObject({ view: "budgets", exhausted: true });
		expect(
			workCapacitySearch({ view: "invalid", exhausted: "invalid" }),
		).toMatchObject({ view: "resources", exhausted: false });
	});

	it("renders the request detail on a direct nested URL", async () => {
		const requestId = "9b3cbf40-9b22-46c9-8913-c9643bf9a7be";
		const orgId = "22222222-2222-4222-8222-222222222222";
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false, staleTime: Infinity } },
		});
		client.setQueryData(workInteractionDetailQueryOptions(requestId).queryKey, {
			request: {
				id: requestId,
				orgId,
				workItemId: null,
				caseId: null,
				projectId: null,
				creatorSessionId: null,
				state: "open",
				requestedAt: "2026-10-03T14:00:00Z",
				dueAt: null,
				expiresAt: null,
				resolvedAt: null,
				metadata: {},
				subject: "Review this exact proposal",
				kind: "coordination",
				version: 1,
				creatorType: "user",
				creatorId: "user-1",
				requestedFromType: "tedi",
				requestedFromId: "CTO",
				prompt: "Check the requested change",
			},
			effectiveState: "open",
			canRespond: false,
			canCancel: false,
			responses: { data: [], hasMore: false, nextCursor: null },
		});
		client.setQueryData<unknown>(tediRosterQueryOptions(100).queryKey, {
			data: [],
		});
		client.setQueryData<unknown>(
			membersListQueryOptions({ organizationId: orgId, limit: 100, offset: 0 })
				.queryKey,
			{ data: [] },
		);
		client.setQueryData<unknown>(
			workExternalPrincipalsQueryOptions(orgId).queryKey,
			[],
		);
		const routeRoot = createRootRoute({ component: Outlet });
		const parent = createRoute({
			getParentRoute: () => routeRoot,
			path: "/work/interactions",
			component: WorkInteractionsRoute,
		});
		const detail = createRoute({
			getParentRoute: () => parent,
			path: "$requestId",
			component: () => <WorkInteractionPage requestId={requestId} />,
		});
		const router = createRouter({
			routeTree: routeRoot.addChildren([parent.addChildren([detail])]),
			history: createMemoryHistory({
				initialEntries: [`/work/interactions/${requestId}`],
			}),
		});
		await router.load();
		const container = document.createElement("div");
		root = createRoot(container);
		await act(async () =>
			root?.render(
				<QueryClientProvider client={client}>
					<RouterProvider router={router} />
				</QueryClientProvider>,
			),
		);
		expect(container.textContent).toContain("Review this exact proposal");
		expect(container.textContent).toContain("Check the requested change");
		expect(container.textContent).not.toContain("Assigned to me");
	});

	it("links a Work-scoped budget to its bounded canonical Work title", () => {
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false, staleTime: Infinity } },
		});
		client.setQueryData<unknown>(
			workItemDetailQueryOptions("work-1").queryKey,
			{ workItem: { title: "Restore workspace access" } },
		);
		const html = renderToStaticMarkup(
			<QueryClientProvider client={client}>
				<BudgetScopeLink scopeType="work_item" scopeId="work-1" />
			</QueryClientProvider>,
		);
		expect(html).toContain('href="/work/items/work-1"');
		expect(html).toContain("Restore workspace access");
	});

	it("keeps identity names type-scoped and unknown IDs available as a fallback", () => {
		const id = "9b3cbf40-9b22-46c9-8913-c9643bf9a7be";
		const names = new Map([[`tedi:${id}`, "CTO"]]);
		expect(namedWorkPrincipal("tedi", id, names)).toBe("CTO");
		expect(namedWorkPrincipal("external_agent", id, names)).toContain(
			"9b3cbf40",
		);
	});

	it("labels interaction paging distinctly from other collections", () => {
		const html = renderToStaticMarkup(
			<PageControls
				label="interactions"
				hasPrevious
				hasNext
				onPrevious={() => {}}
				onBack={() => {}}
				onNext={() => {}}
			/>,
		);
		expect(html).toContain("First interactions page");
		expect(html).toContain("Previous interactions page");
		expect(html).toContain("Next interactions page");
	});

	it("links the holding Work and distinguishes truncated or unavailable reservations", () => {
		const html = renderToStaticMarkup(
			<ResourceHolders
				names={
					new Map([["external_agent:principal-1", "Codex implementation"]])
				}
				activeReserved={1}
				details={{
					holders: [
						{
							attemptId: "attempt-1",
							workItemId: "work-1",
							workTitle: "Ship exact scope",
							executorType: "external_agent",
							executorId: "principal-1",
							externalSessionKey: "codex:chat-1",
							quantity: 1,
							expiresAt: "2026-10-03T14:00:00Z",
						},
					],
					holdersTruncated: true,
				}}
			/>,
		);
		expect(html).toContain('href="/work/items/work-1"');
		expect(html).toContain("Ship exact scope");
		expect(html).toContain("Codex implementation");
		expect(html).toContain("Additional holders are omitted");
		expect(html).toContain("then retry admission");
		expect(
			renderToStaticMarkup(
				<ResourceHolders
					names={new Map()}
					activeReserved={1}
					details={{ holders: [] }}
				/>,
			),
		).toContain("No current linked Work holder");
		expect(
			renderToStaticMarkup(
				<ResourceHolders names={new Map()} activeReserved={1} details={{}} />,
			),
		).toContain("Holder details unavailable");
	});

	it("preserves exact resource filtering in the generated query input and paging key", () => {
		expect(
			JSON.stringify(
				workResourcePoolsQueryOptions("cursor-1", "release:os", true).queryKey,
			),
		).toContain("saturatedOnly");
		expect(
			workResourcePoolsQueryOptions("cursor-1", "release:os").queryKey,
		).not.toEqual(workResourcePoolsQueryOptions("cursor-1").queryKey);
		expect(
			JSON.stringify(
				workResourcePoolsQueryOptions("cursor-1", "release:os").queryKey,
			),
		).toContain("release:os");
	});
});
