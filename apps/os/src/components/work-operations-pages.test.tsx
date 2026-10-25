import {
	interactionSubject,
	decisionCaptureSummary,
} from "@/lib/work-interaction-display";
import { WorkActorDirectoryContext } from "@/components/work-actor-avatar";
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
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
	membersListQueryOptions,
	tediRosterQueryOptions,
	workExternalPrincipalsQueryOptions,
	workApprovalsQueryOptions,
	workPendingApprovalsQueryOptions,
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
	workReadinessProjectionQueryOptions,
	workAdmissionSpecificationQueryOptions,
	workItemReadinessQueryOptions,
} from "@/lib/os-query-options";
import { WorkAdmissionPage } from "./work-admission-page";
import { WorkClustersPage } from "./work-clusters-page";
import {
	NeedsYouNowSection,
	WorkInteractionsRoute,
	WorkInteractionPage,
} from "./work-interactions-pages";
import {
	OperationActor,
	namedWorkPrincipal,
	ApprovalRequestError,
	PageControls,
	SchedulerTruncationWarnings,
	useCursorPaging,
	urgentInteractionSummary,
	groupSessionQuestions,
} from "./work-operations-shared";
import { WorkCasesRoute } from "./work-cases-pages";
import { WorkApprovalsPage } from "./work-approvals-page";
import { BudgetScopeLink, ResourceHolders } from "./work-capacity-page";
import {
	workCapacitySearch,
	workInteractionsSearch,
} from "@/lib/work-route-search";
import type { JsonValue } from "@tedix/api-contract/schemas/common";

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
	vi.restoreAllMocks();
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
						subject: "acme-app · claude-code waiting: **deploy failed**",
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
		expect(text).toContain("claude-code waiting: deploy failed");
		expect(text).not.toContain("**");
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

describe("Decision-capture questions", () => {
	const requestId = "9b3cbf40-9b22-46c9-8913-c9643bf9a7be";
	const orgId = "22222222-2222-4222-8222-222222222222";
	const decisionMetadata = (triage: {
		urgency: string;
		urgentLabels: string[];
	}) => ({
		schema: "tedix.decision-capture.v1",
		host: "claude-code",
		sessionId: "abcdef12-0000-4000-8000-000000000000",
		repository: "acme-app",
		branch: "main",
		triage: { status: "ok", labels: {}, ...triage },
	});

	async function renderDetail(
		metadata: Record<string, JsonValue>,
		overrides: {
			kind?: "question" | "handoff";
			canRespond?: boolean;
			dueAt?: string;
		} = {},
	) {
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
				dueAt: overrides.dueAt ?? null,
				expiresAt: null,
				resolvedAt: null,
				metadata,
				subject:
					"acme-app · claude-code waiting: It's deployed.** The live API runs commit `fc6b8f9`",
				kind: overrides.kind ?? "question",
				version: 1,
				creatorType: "user",
				creatorId: "user-1",
				requestedFromType: "user",
				requestedFromId: "user-1",
				prompt:
					"**It's deployed.** The live API runs commit `fc6b8f9`.\n\n- one\n- two\n\n<b>raw</b>",
			},
			effectiveState: "open",
			canRespond: overrides.canRespond ?? false,
			canCancel: false,
			responses: { data: [], hasMore: false, nextCursor: null },
		});
		client.setQueryData<unknown>(tediRosterQueryOptions(100).queryKey, {
			data: [],
		});
		client.setQueryData<unknown>(
			membersListQueryOptions({ organizationId: orgId, limit: 100, offset: 0 })
				.queryKey,
			{ data: [{ descopeUserId: "user-1", name: "Fixture Person" }] },
		);
		client.setQueryData<unknown>(
			workExternalPrincipalsQueryOptions(orgId).queryKey,
			[],
		);
		const routeRoot = createRootRoute({ component: Outlet });
		const detail = createRoute({
			getParentRoute: () => routeRoot,
			path: "/work/interactions/$requestId",
			component: () => <WorkInteractionPage requestId={requestId} />,
		});
		const router = createRouter({
			routeTree: routeRoot.addChildren([detail]),
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
		return container;
	}

	it("answers a handoff such as a Work proposal with one Accept or Decline", async () => {
		const container = await renderDetail(
			{ schema: "tedix.work-proposal.v1" },
			{ kind: "handoff", canRespond: true },
		);
		const labels = [...container.querySelectorAll("button")].map(
			(button) => button.textContent,
		);
		expect(labels).toContain("Yes, start");
		expect(labels).toContain("Not now");
	});

	it("summarizes origin and urgency only for decision-capture rows", () => {
		expect(
			decisionCaptureSummary(
				decisionMetadata({
					urgency: "now",
					urgentLabels: ["human_only_action", "risky_action"],
				}),
			),
		).toEqual({
			source: "your Claude Code session",
			origin: "From your Claude Code session · acme-app · main",
			sessionId: "abcdef12-0000-4000-8000-000000000000",
			shortSessionId: "abcdef12",
			urgency: "now",
			reasons: ["Needs you to act", "Risky action"],
			attention: null,
			need: null,
		});
		expect(
			decisionCaptureSummary({
				schema: "tedix.decision-capture.v1",
				host: "codex",
				triage: { urgency: "later", urgentLabels: ["risky_action"] },
			}),
		).toMatchObject({
			origin: "From your Codex session",
			urgency: "later",
			reasons: [],
		});
		expect(decisionCaptureSummary({ originChatTitle: "x" })).toBeNull();
		expect(
			interactionSubject({ subject: "**Keep** `as is`", metadata: {} }),
		).toBe("**Keep** `as is`");
		expect(
			interactionSubject({
				subject: "acme-app · codex waiting: **Done** `fc6b8f9`",
				metadata: { schema: "tedix.decision-capture.v1" },
			}),
		).toBe("acme-app · codex waiting: Done fc6b8f9");
	});

	it("renders an urgent question as plain title, Markdown body and plain-word reasons", async () => {
		const container = await renderDetail(
			decisionMetadata({
				urgency: "now",
				urgentLabels: ["blocker_or_failure"],
			}),
		);
		const text = container.textContent ?? "";
		expect(container.querySelector("h2")?.textContent).toBe(
			"acme-app · claude-code waiting: It's deployed.",
		);
		expect(container.querySelector(".fd-identifier")?.textContent).toContain(
			"fc6b8f9",
		);
		expect(container.querySelector(".fd-proposer")?.textContent).toContain(
			"Claude Code",
		);
		expect(
			container.querySelector('[data-kumo-component="CollapsibleTrigger"]')
				?.textContent,
		).toBe("Why this?");
		expect(text).not.toContain("Question from");
		expect(text).toContain("Blocked");
		expect(text).not.toContain("Can wait");
		expect(container.querySelector(".chat-markdown")).toBeNull();
		await act(async () => {
			[...container.querySelectorAll("button")]
				.find((button) => button.textContent === "More")!
				.click();
		});
		expect(container.querySelector(".chat-markdown strong")?.textContent).toBe(
			"It's deployed.",
		);
		expect(container.querySelectorAll(".chat-markdown li")).toHaveLength(2);
		expect(container.querySelector(".chat-markdown b")).toBeNull();
		expect(text).not.toContain("**");
	});

	it("leads with the one-line need and calls an update an update", async () => {
		const ask = {
			...decisionMetadata({ urgency: "now", urgentLabels: [] }),
			attention: { kind: "needs_you", need: "Approve the production deploy." },
		};
		const asked = await renderDetail(ask);
		expect(asked.querySelector("h2")?.textContent).toBe(
			"Approve the production deploy.",
		);
		expect(asked.textContent).not.toContain("Response kind");
		expect(asked.textContent).not.toContain("Share what you know");

		const update = {
			...decisionMetadata({
				urgency: "now",
				urgentLabels: ["blocker_or_failure"],
			}),
			attention: { kind: "fyi", need: null },
		};
		expect(decisionCaptureSummary(update)).toMatchObject({
			urgency: "later",
			reasons: [],
			attention: "fyi",
			need: null,
		});
		const told = await renderDetail(update);
		expect(told.textContent).toContain("Update: nothing needed from you");
		expect(told.textContent).not.toContain("Blocked");
	});

	it("marks a later question as able to wait", async () => {
		const container = await renderDetail(
			decisionMetadata({ urgency: "later", urgentLabels: [] }),
		);
		expect(container.textContent).toContain("Can wait");
		expect(container.textContent).not.toContain("Blocked");
	});

	it("keeps overdue questions answerable when the server permits a response", async () => {
		const container = await renderDetail(
			{},
			{ canRespond: true, dueAt: "2026-10-01T00:00:00Z" },
		);
		expect(container.textContent).toContain("This deadline has passed");
		expect(
			container.querySelector<HTMLTextAreaElement>(
				'textarea[aria-label="Your answer"]',
			)?.disabled,
		).toBe(false);
		expect(
			[...container.querySelectorAll("button")].some(
				(button) => button.textContent === "Answer",
			),
		).toBe(true);
	});

	it("withholds overdue answer controls when the server denies a response", async () => {
		const container = await renderDetail(
			{},
			{ canRespond: false, dueAt: "2026-10-01T00:00:00Z" },
		);
		expect(
			container.querySelector('textarea[aria-label="Your answer"]'),
		).toBeNull();
		expect(
			[...container.querySelectorAll("button")].some(
				(button) => button.textContent === "Answer",
			),
		).toBe(false);
	});

	it("keeps the existing source label and plain prompt for other questions", async () => {
		const container = await renderDetail({});
		const text = container.textContent ?? "";
		expect(text).toContain("Fixture Person");
		expect(text).toContain("It's deployed.");
		expect(container.querySelector(".chat-markdown")).toBeNull();
		await act(async () => {
			[...container.querySelectorAll("button")]
				.find((button) => button.textContent === "More")!
				.click();
		});
		expect(container.querySelector(".chat-markdown strong")).not.toBeNull();
	});
});

describe("Session question grouping", () => {
	const capture = (sessionId: string) => ({
		schema: "tedix.decision-capture.v1",
		host: "codex",
		sessionId,
		repository: "acme-app",
		triage: { status: "ok", urgency: "later", urgentLabels: [] },
	});
	const row = (
		id: string,
		requestedAt: string,
		metadata: Record<string, JsonValue>,
		effectiveState = "open",
	) => ({
		request: {
			id,
			orgId: "22222222-2222-4222-8222-222222222222",
			workItemId: null,
			caseId: null,
			projectId: "33333333-3333-4333-8333-333333333333",
			creatorSessionId: null,
			state: effectiveState,
			requestedAt,
			dueAt: null,
			expiresAt: null,
			resolvedAt: null,
			metadata,
			subject: `codex waiting: turn ${id}`,
			kind: "question",
			version: 1,
			creatorType: "user",
			creatorId: "user-1",
			requestedFromType: "user",
			requestedFromId: "user-1",
			prompt: `Turn ${id}`,
		},
		effectiveState,
		canRespond: true,
		canCancel: false,
		workItem: null,
		responseCount: 0,
	});

	it("keeps only the newest open question per session, at its position", () => {
		const rows = [
			row("other", "2026-10-03T14:05:00Z", {}),
			row("a-old", "2026-10-03T14:01:00Z", capture("session-a")),
			row("b-only", "2026-10-03T14:04:00Z", capture("session-b")),
			row("a-new", "2026-10-03T14:03:00Z", capture("session-a")),
			row("a-mid", "2026-10-03T14:02:00Z", capture("session-a")),
			row("a-done", "2026-10-03T14:06:00Z", capture("session-a"), "resolved"),
		];
		expect(
			groupSessionQuestions(rows).map(({ row, earlier }) => [
				row.request.id,
				earlier.map((older) => older.request.id),
			]),
		).toEqual([
			["other", []],
			["b-only", []],
			["a-new", ["a-mid", "a-old"]],
			["a-done", []],
		]);
	});

	it("collapses a session's earlier turns in the inbox behind a disclosure", async () => {
		const page = {
			data: [
				row(
					"33333333-0000-4000-8000-000000000003",
					"2026-10-03T14:03:00Z",
					capture("session-a"),
				),
				row(
					"33333333-0000-4000-8000-000000000002",
					"2026-10-03T14:02:00Z",
					capture("session-a"),
				),
				row(
					"33333333-0000-4000-8000-000000000001",
					"2026-10-03T14:01:00Z",
					capture("session-a"),
				),
				row("33333333-0000-4000-8000-000000000004", "2026-10-03T14:00:00Z", {}),
			],
			hasMore: false,
			nextCursor: null,
			observedAt: "2026-10-03T15:00:00Z",
		};
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false, staleTime: Infinity } },
		});
		client.setQueryData<unknown>(workInteractionsQueryOptions().queryKey, page);
		for (const empty of [
			workUrgentInteractionsQueryOptions().queryKey,
			workInteractionsQueryOptions(undefined, "outbox").queryKey,
		])
			client.setQueryData<unknown>(empty, { ...page, data: [] });
		const orgId = "22222222-2222-4222-8222-222222222222";
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
		// The phone list and the desktop table render the same rows.
		const links = (scope: string) =>
			[
				...container.querySelectorAll(
					`${scope} a[href^="/work/interactions/"]`,
				),
			].map((link) => link.getAttribute("href")?.slice(-1));
		expect(links("table")).toEqual(["3", "4"]);
		expect(links("[data-mobile-interaction-row]")).toEqual(["3", "4"]);
		const toggle = [
			...container.querySelectorAll<HTMLButtonElement>("table button"),
		].find((button) => button.textContent === "2 earlier turns");
		expect(toggle?.getAttribute("aria-expanded")).toBe("false");
		await act(async () => toggle?.click());
		expect(links("table")).toEqual(["3", "2", "1", "4"]);
		expect(links("[data-mobile-interaction-row]")).toEqual([
			"3",
			"2",
			"1",
			"4",
		]);
		expect(toggle?.textContent).toBe("Hide 2 earlier turns");
	});
});

describe("Work approval request errors", () => {
	it("shows pending decisions absent from the first 50 history rows, with history in its tab", async () => {
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
		client.setQueryData<unknown>(workPendingApprovalsQueryOptions().queryKey, {
			data: [row("mine", "Decision I can make", true)],
			hasMore: false,
			nextCursor: null,
		});
		client.setQueryData<unknown>(workApprovalsQueryOptions().queryKey, {
			data: Array.from({ length: 50 }, (_, index) => ({
				...row(`other-${index}`, "Decision for another approver", false),
				effectiveStatus: "approved",
			})),
			hasMore: true,
			nextCursor: { at: "2026-10-04T15:00:00Z", id: "other-49" },
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
		const history = Array.from(container.querySelectorAll("[role=tab]")).find(
			(tab) => tab.textContent?.trim() === "History",
		) as HTMLElement | undefined;
		await act(async () => history?.click());
		expect(container.textContent).toContain("Decision for another approver");
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

describe("Read-only operations entry", () => {
	const id = "11111111-1111-4111-8111-111111111111";
	it("opens admission and selects Work without replacing its specification or starting an Attempt", async () => {
		const fetch = vi
			.spyOn(globalThis, "fetch")
			.mockRejectedValue(new Error("Unexpected request"));
		const client = new QueryClient({
			defaultOptions: {
				queries: { enabled: false, retry: false, staleTime: Infinity },
			},
		});
		client.setQueryData(workReadinessProjectionQueryOptions().queryKey, {
			data: [
				{
					workItem: {
						id,
						title: "Review sample deployment",
						disposition: "accepted",
						workKind: "coding",
						riskLevel: "low",
						priority: "medium",
						projectId: null,
						accountableOwnerType: "user",
						accountableOwnerId: "sample-owner",
						createdAt: "2026-10-20T10:00:00Z",
						updatedAt: null,
					},
					readiness: {
						workItemId: id,
						ready: false,
						state: "already_running",
						gates: [
							{
								gate: "attempt",
								detail: "Active lease until tomorrow",
								evaluation: "failed",
							},
						],
						reasons: [],
						derivedAt: "2026-10-20T10:00:00Z",
					},
				},
			],
			hasMore: false,
			observedAt: "2026-10-20T10:00:00Z",
			nextCursor: null,
		});
		client.setQueryData(workItemReadinessQueryOptions(id).queryKey, {
			workItemId: id,
			reasons: [],
			ready: false,
			state: "already_running",
			gates: [],
			derivedAt: "2026-10-20T10:00:00Z",
		});
		client.setQueryData(workAdmissionSpecificationQueryOptions(id).queryKey, {
			workItemVersion: 2,
			workItemId: id,
			admissionSpecRevision: "sample-revision",
			resources: [{ resourceKey: "sample:resource", quantity: 1 }],
			budget: null,
		});
		const container = document.createElement("div");
		root = createRoot(container);
		await act(async () =>
			root?.render(
				<QueryClientProvider client={client}>
					<WorkAdmissionPage />
				</QueryClientProvider>,
			),
		);
		expect(container.textContent).toContain("Active lease until tomorrow");
		expect(container.querySelector("textarea")).toBeNull();
		const inspect = Array.from(container.querySelectorAll("button")).find(
			(button) => button.textContent?.includes("Review sample deployment"),
		);
		expect(inspect).toBeDefined();
		await act(async () => inspect?.click());
		expect(container.textContent).toContain("Current readiness");
		expect(fetch).not.toHaveBeenCalled();
		vi.restoreAllMocks();
	});
	it("offers a named tedi snapshot with advanced UUID lookup collapsed", () => {
		const client = new QueryClient({
			defaultOptions: { queries: { enabled: false } },
		});
		client.setQueryData(tediRosterQueryOptions(100).queryKey, {
			data: [{ id, name: "cedar", displayName: "Cedar" }] as never,
			pagination: { total: 1, limit: 100, offset: 0, hasMore: false },
		});
		const html = renderToStaticMarkup(
			<QueryClientProvider client={client}>
				<WorkClustersPage />
			</QueryClientProvider>,
		);
		expect(html).toContain("Choose a tedi");
		expect(html).toContain("Advanced");
		expect(html).not.toContain('placeholder="Tedi UUID"');
	});
});

describe("Request and case identity presentation", () => {
	it("names typed owners from the shared actor directory and never prints a raw id", () => {
		const html = renderToStaticMarkup(
			<WorkActorDirectoryContext.Provider
				value={new Map([["user:sample-owner", { name: "Sample Owner" }]])}
			>
				<OperationActor type="user" id="sample-owner" />
			</WorkActorDirectoryContext.Provider>,
		);
		expect(html).toContain("Sample Owner");
		expect(html).not.toContain("sample-owner");
		const unknown = renderToStaticMarkup(
			<OperationActor type="user" id="U39z24M4F456C31EdxA3a39gsuLH" />,
		);
		expect(unknown).toContain("Unknown person");
		expect(unknown).not.toContain("U39z24M4");
	});
	it("suppresses identical subtitles and uses linked Work as the canonical origin on mobile", () => {
		const client = new QueryClient({
			defaultOptions: { queries: { enabled: false } },
		});
		client.setQueryData(workUrgentInteractionsQueryOptions().queryKey, {
			data: [
				{
					request: {
						id: "sample-request",
						prompt: "Check the sample failure before continuing.",
						subject: "Review sample deployment",
						creatorType: "user",
						creatorId: "sample-owner",
						metadata: {},
						workItemId: "sample-work",
					},
					workItem: { id: "sample-work", title: "Review sample deployment" },
					effectiveState: "open",
				},
			],
			hasMore: false,
			nextCursor: null,
		} as never);
		const doc = new DOMParser().parseFromString(
			renderToStaticMarkup(
				<QueryClientProvider client={client}>
					<NeedsYouNowSection />
				</QueryClientProvider>,
			),
			"text/html",
		);
		const mobile = doc.querySelector(
			'ul[aria-label="Requests that need you now"]',
		);
		expect(mobile?.querySelectorAll("li")).toHaveLength(1);
		expect(
			mobile?.textContent?.match(/Review sample deployment/g),
		).toHaveLength(1);
		expect(mobile?.textContent).toContain("Needs you");
		expect(mobile?.textContent).toContain(
			"Check the sample failure before continuing.",
		);
		expect(mobile?.textContent).not.toContain("Origin not recorded");
		expect(
			mobile?.querySelector('a[href="/work/items/sample-work"]'),
		).not.toBeNull();
	});
});

describe("Case route navigation", () => {
	it("renders the case outlet and returns to the register", async () => {
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false, staleTime: Infinity } },
		});
		client.setQueryData(workCaseListQueryOptions({ limit: 50 }).queryKey, {
			data: [],
			nextCursor: null,
		});
		const routeRoot = createRootRoute({ component: Outlet });
		const list = createRoute({
			getParentRoute: () => routeRoot,
			path: "/work/cases",
			component: WorkCasesRoute,
		});
		const detail = createRoute({
			getParentRoute: () => list,
			path: "$caseId",
			component: () => <p>Case detail</p>,
		});
		const router = createRouter({
			routeTree: routeRoot.addChildren([list.addChildren([detail])]),
			history: createMemoryHistory({
				initialEntries: ["/work/cases/sample-case"],
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
		expect(container.textContent).toBe("Case detail");
		await act(async () => {
			await router.navigate({ to: "/work/cases" });
		});
		expect(container.textContent).toContain("Work streams");
		expect(container.textContent).not.toContain("Case detail");
	});
});
