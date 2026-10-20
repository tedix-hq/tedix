import { DecisionFilterChip } from "../src/components/decision-context-rail";
import { useState, type ReactNode } from "react";
import { WorkToolbarTargetContext } from "../src/components/deck-presentation-context";
import { OsTopbarActionsTargetContext } from "../src/components/os-topbar-actions-context";
import { WorkActorDirectoryContext } from "../src/components/work-actor-avatar";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { DecisionDeckConfigSchema } from "@tedix/api-contract/schemas/os-decision-deck";
import { DeckCardSchema } from "@tedix/api-contract/schemas/attention";
import { OsGadgetManifestSchema } from "@tedix/api-contract/schemas/os-workspaces";
import { WorkspaceAppRenderer } from "../src/components/workspace-app-renderer";
import { WorkDecisionCard } from "../src/components/work-decision-card";
import {
	osQuery,
	pendingApprovalsQueryOptions,
	projectListQueryOptions,
	userProfileQueryOptions,
	userPreferencesQueryOptions,
	workAgentSessionsQueryOptions,
	workInteractionDetailQueryOptions,
} from "../src/lib/os-query-options";
import { DECISION_DECK_EXAMPLES } from "../dev/decision-deck-fixture";
import "../src/styles.css";
import { ActivityFeedConfigSchema } from "@tedix/api-contract/schemas/os-activity-feed";
import { DEFAULT_OS_USER_PREFERENCES } from "@tedix/api-contract/schemas/user-settings";
import { learnDecisions } from "@tedix/api-contract/utils/decision-learning";
import {
	focusDay,
	FOCUS_HISTORY_SURFACES,
} from "@tedix/api-contract/utils/focus-feed";

const client = new QueryClient({
	defaultOptions: {
		queries: {
			enabled: false,
			staleTime: Infinity,
			retry: false,
			refetchOnWindowFocus: false,
			refetchOnReconnect: false,
		},
	},
});
client.setQueryData(
	osQuery.workInteractions.listInbox.queryOptions({
		input: {
			projectId: undefined,
			limit: 50,
			states: ["open"],
			decisionKind: "approval",
		},
	}).queryKey,
	{
		data: [],
		hasMore: false,
		nextCursor: null,
		observedAt: new Date().toISOString(),
	},
);
for (const state of ["open", "resolved"] as const)
	client.setQueryData(
		osQuery.workInteractions.listInbox.queryOptions({
			input: { projectId: undefined, limit: 50, states: [state] },
		}).queryKey,
		{ data: [], hasMore: false },
	);
client.setQueryData(pendingApprovalsQueryOptions().queryKey, {
	data: [],
	pagination: { limit: 50, offset: 0, total: 0, hasMore: false },
});
client.setQueryData(
	osQuery.workApprovals.listInbox.queryOptions({
		input: { projectId: undefined, limit: 50, statuses: ["pending"] },
	}).queryKey,
	{
		data: [],
		hasMore: false,
		nextCursor: null,
		observedAt: new Date().toISOString(),
	},
);
client.setQueryData(workAgentSessionsQueryOptions().queryKey, { sessions: [] });
client.setQueryData(projectListQueryOptions(100).queryKey, { data: [] });
client.setQueryData(userProfileQueryOptions().queryKey, {
	id: "fictional-person",
});
client.setQueryData(
	osQuery.learningFeedback.listInteractions.queryOptions({
		input: { scopeKind: "personal", limit: 200 },
	}).queryKey,
	{ events: [] },
);
client.setQueryData(
	osQuery.learningFeedback.listInteractions.queryOptions({
		input: {
			scopeKind: "personal",
			limit: 200,
			surfaces: FOCUS_HISTORY_SURFACES,
		},
	}).queryKey,
	{ events: [] },
);
const projectId = "11111111-1111-4111-8111-111111111111";
const input = { projectId, limit: 20, cursor: undefined };
const today = new Date();
client.setQueryData(
	osQuery.learningFeedback.model.queryOptions({ input: {} }).queryKey,
	learnDecisions({
		organizationId: "fictional-pine",
		personId: "fictional-person",
		events: [],
		now: today,
	}),
);
const event = (id: number, title: string, body: string, small = false) => ({
	id: `event-${id}`,
	workItemId: projectId,
	workItemTitle: title,
	body,
	eventType: small ? "work.created" : "work.completed",
	workItemDisposition: "completed",
	agentHarness: "codex",
	authorType: "external_agent",
	createdAt: new Date(today.getTime() - id * 3600000).toISOString(),
});
const options = {
	initialPageParam: undefined,
	getNextPageParam: () => undefined,
};
client.setQueryData(
	osQuery.workItems.listActivity.infiniteOptions({
		input: () => input,
		...options,
	}).queryKey,
	{
		pages: [
			{
				events: [
					event(
						1,
						"Office fix",
						"Codex shipped the Office fix — ready to verify.",
					),
					event(2, "Release notes", "Cedar finished the release notes."),
					event(5, "Supplier review", "Morgan added the inspection notes."),
					...Array.from({ length: 12 }, (_, i) =>
						event(
							i + 6,
							"Project update",
							"A smaller update was recorded.",
							true,
						),
					),
				],
				nextCursor: null,
			},
		],
		pageParams: [undefined],
	},
);
client.setQueryData(
	osQuery.workItems.listAttemptProjection.infiniteOptions({
		input: () => ({
			...input,
			outcomes: ["succeeded", "failed", "expired", "cancelled"],
		}),
		...options,
	}).queryKey,
	{
		pages: [
			{
				data: [
					[
						"Office fix: final desktop and phone verification, screenshots and release notes",
						"The Office fix is ready to verify.",
					],
					["Release notes", "The release notes are ready to read."],
				].map(([title, summary], index) => ({
					attempt: {
						id: `fictional-receipt-${index}`,
						orgId: projectId,
						workItemId: projectId,
						executorType: "external_agent",
						executorId: "codex",
						executorSessionId: null,
						externalSessionKey:
							index === 0 ? "codex:fictional" : "claude-code:fictional",
						runtimeState: "finished",
						outcome: "succeeded",
						runId: null,
						admissionId: null,
						attemptNumber: 1,
						startedAt: today.toISOString(),
						heartbeatAt: today.toISOString(),
						expiresAt: null,
						finishedAt: new Date(
							today.getTime() - index * 3600000,
						).toISOString(),
						summary,
						metadata: {
							feedSentence: summary,
							agentHarness: index === 0 ? "codex" : "claude-code",
						},
					},
					workItem: {
						id:
							index === 0 ? projectId : "22222222-2222-4222-8222-222222222222",
						title,
						disposition: "completed",
						workKind: "coding",
						riskLevel: "low",
						priority: "medium",
						projectId,
						accountableOwnerType: null,
						accountableOwnerId: null,
					},
				})),
				nextCursor: null,
			},
		],
		pageParams: [undefined],
	},
);
client.setQueryData(
	osQuery.workInteractions.listInbox.infiniteOptions({
		input: () => input,
		...options,
	}).queryKey,
	{ pages: [{ data: [], nextCursor: null }], pageParams: [undefined] },
);
client.setQueryData(
	osQuery.workApprovals.listInbox.infiniteOptions({
		input: () => input,
		...options,
	}).queryKey,
	{ pages: [{ data: [], nextCursor: null }], pageParams: [undefined] },
);
client.setQueryData(userPreferencesQueryOptions().queryKey, {
	preferences: {
		...DEFAULT_OS_USER_PREFERENCES,
		activityFeed: {
			projectIds: [],
			mutedClasses: [],
			preferredClasses: [],
			lastSeenAt: null,
			budgetDay: focusDay(today.toISOString(), "UTC"),
			shownIds: [
				"attempt:fictional-receipt-0",
				"attempt:fictional-receipt-1",
				"work:event-1",
			],
		},
	},
	revision: 0,
});
client.setQueryData(
	osQuery.learningFeedback.listInteractions.queryOptions({
		input: { scopeKind: "personal", eventKind: "edited", limit: 100 },
	}).queryKey,
	{ events: [] },
);
const params = new URLSearchParams(location.search);
if (["approval", "question"].includes(params.get("surface") ?? "")) {
	client.setQueryData(userProfileQueryOptions().queryKey, {
		id: "fictional-approval-reviewer",
	});
	const request = {
		id: projectId,
		orgId: projectId,
		workItemId: null,
		caseId: null,
		projectId: null,
		kind: "question" as const,
		subject:
			params.get("surface") === "question"
				? "Which delivery date should we offer?"
				: "Approve fictional test login",
		prompt:
			params.get("surface") === "question"
				? "We will use your date in the draft reply. Friday leaves time to check the order before dispatch."
				: "Approve tests_write.GenerateMagicLinkForTestUser for viewer@example.com? Prepared args: target=viewer@example.com. This returns a non-delivered test-only link.",
		requestedFromType: "user" as const,
		requestedFromId: "fictional-person",
		creatorType: "external_agent" as const,
		creatorId: "codex",
		creatorSessionId: null,
		state: "open" as const,
		requestedAt: new Date().toISOString(),
		dueAt: null,
		expiresAt: null,
		resolvedAt: null,
		version: 1,
		metadata: {
			...(params.get("surface") === "question"
				? { decisionClass: "opportunity.customer_delivery" }
				: { approvalOperation: "tests_write.GenerateMagicLinkForTestUser" }),
			approvalTarget: "viewer@example.com",
			cardPresentation: {
				version: 1,
				title:
					params.get("surface") === "question"
						? "Which delivery date should we offer?"
						: "Approve fictional test login",
				body:
					params.get("surface") === "question"
						? "We will use your date in the draft reply to the supplier."
						: "Let Codex check the reported fix with a fictional test account. The test link stays with the agent; no email is sent.",
				recommendation:
					params.get("surface") === "question"
						? "Friday leaves time to check the order before dispatch."
						: "Approve because the test account and operation are specified.",
			},
		},
	};
	client.setQueryData(
		osQuery.workInteractions.listInbox.queryOptions({
			input: {
				projectId: undefined,
				limit: 50,
				states: ["open"],
				decisionKind: "approval",
			},
		}).queryKey,
		{
			data: [
				{
					request,
					effectiveState: "open",
					canRespond: true,
					canCancel: false,
					workItem: null,
					responseCount: 0,
					askedBy: "Codex session",
				},
			],
			hasMore: false,
			nextCursor: null,
			observedAt: new Date().toISOString(),
		},
	);
	client.setQueryData(workInteractionDetailQueryOptions(projectId).queryKey, {
		request,
		effectiveState: "open",
		canRespond: true,
		canCancel: false,
		responses: { data: [], hasMore: false, nextCursor: null },
	});
	client.setQueryData(
		osQuery.attention.getDeckCard.queryOptions({
			input: { cardId: request.id, projectId: undefined, limit: 100 },
		}).queryKey,
		DeckCardSchema.parse({
			id: request.id,
			kind: "question",
			label: request.subject,
			project: "Unfiled",
			urgency: "later",
			source: "/work",
			score: 0,
			requestedAt: request.requestedAt,
			dueAt: null,
			decision: null,
			interaction: {
				request,
				effectiveState: "open",
				canRespond: true,
				canCancel: false,
				workItem: null,
				responseCount: 0,
				askedBy: "Codex session",
			},
			presentation: {
				version: 2,
				title:
					params.get("surface") === "question"
						? request.subject
						: "Approve fictional test login?",
				context:
					params.get("surface") === "question"
						? "Your supplier needs a delivery date."
						: "The reported fix needs a check with a test account.",
				body:
					params.get("surface") === "question"
						? "Saves your date for the draft reply; sends nothing."
						: "Checks the fix with the test account; sends no email.",
				recommendation:
					params.get("surface") === "question"
						? "Friday leaves time to check the order before dispatch."
						: "Recommend yes because the test account and operation are specified.",
			},
		}),
	);
}

if (params.has("retry")) {
	const inboxKey = osQuery.workInteractions.listInbox.queryOptions({
		input: { projectId: undefined, limit: 50, states: ["open"] },
	}).queryKey;
	const known = client.getQueryData(inboxKey);
	const approvalKey = osQuery.workInteractions.listInbox.queryOptions({
		input: {
			projectId: undefined,
			limit: 50,
			states: ["open"],
			decisionKind: "approval",
		},
	}).queryKey;
	const approval = client.getQueryData(approvalKey);
	const cursor = { at: today.toISOString(), id: projectId };
	client.setQueryData(inboxKey, {
		...known,
		data: [...(known?.data ?? []), ...(approval?.data ?? [])],
		hasMore: true,
		nextCursor: cursor,
		observedAt: today.toISOString(),
	});
	client.removeQueries({
		queryKey: osQuery.workInteractions.listInbox.infiniteOptions({
			input: (cursor: { at: string; id: string } | undefined) => ({
				projectId: undefined,
				limit: 50,
				states: ["open"],
				cursor,
			}),
			initialPageParam: cursor,
			getNextPageParam: (page) => page.nextCursor ?? undefined,
		}).queryKey,
		exact: true,
	});
	client.removeQueries({
		queryKey: approvalKey,
		exact: true,
	});
}

if (params.get("motion") === "reduced")
	document.documentElement.dataset.motion = "reduced";
if (params.has("resilience")) {
	const snapshots = client
		.getQueryCache()
		.getAll()
		.filter((query) =>
			JSON.stringify(query.queryKey).includes("workInteractions"),
		)
		.map((query) => ({ query, state: { ...query.state } }));
	const fail = () => {
		for (const { query } of snapshots) {
			if (params.get("resilience") === "empty")
				query.setState({ data: undefined });
			query.setState({
				status: "error",
				fetchStatus: "idle",
				fetchFailureCount: 4,
				error: {
					code: "SERVICE_UNAVAILABLE",
					data: { traceId: "11111111-1111-4111-8111-111111111111" },
				},
			});
		}
	};
	window.addEventListener("work-resilience:fail", fail);
	window.addEventListener("work-resilience:recover", () => {
		for (const { query, state } of snapshots) query.setState(state);
	});
	if (params.get("resilience") !== "ready") fail();
}
document.documentElement.classList.toggle(
	"dark",
	params.get("theme") === "dark",
);
document.documentElement.style.colorScheme =
	params.get("theme") === "dark" ? "dark" : "light";
const manifest = OsGadgetManifestSchema.parse({
	...(params.get("surface") === "feed"
		? {
				entry: "tedix:app/activity-feed",
				config: ActivityFeedConfigSchema.parse({
					version: 1,
					projects: [{ id: projectId, label: "Pine Studio" }],
				}),
			}
		: {
				entry: "tedix:app/decision-deck",
				config: DecisionDeckConfigSchema.parse({
					version: 1,
					examples:
						params.get("cards") === "one"
							? [DECISION_DECK_EXAMPLES[4]]
							: params.get("cards") === "three"
								? [0, 1, 2].map((index) => ({
										...DECISION_DECK_EXAMPLES[4],
										proposal: `Review fictional customer story ${index + 1}?`,
									}))
								: DECISION_DECK_EXAMPLES,
					...(params.get("cards") === "one"
						? { defaultLowStakesToDelegate: false }
						: {}),
				}),
			}),
});
function ProofFrame({ children }: { children: ReactNode }) {
	const [target, setTarget] = useState<HTMLDivElement | null>(null);
	const [topbarTarget, setTopbarTarget] = useState<HTMLDivElement | null>(null);
	if (!params.has("shell"))
		return <main className="mx-auto max-w-5xl p-3 md:p-8">{children}</main>;
	return (
		<WorkToolbarTargetContext.Provider value={target}>
			<OsTopbarActionsTargetContext.Provider value={topbarTarget}>
				<div className="flex h-dvh flex-col">
					<header className="flex h-14 shrink-0 items-center justify-between border-b border-kumo-line px-4 font-semibold sm:px-6">
						Work
						<div ref={setTopbarTarget} />
					</header>
					<div className="fd-work-shell flex min-h-0 flex-1 flex-col">
						<section
							data-slot="page"
							className="fd-work-home mx-auto min-h-0 w-full flex-1 overflow-y-auto px-4 sm:px-6"
						>
							{children}
						</section>
						<div className="fd-work-bar">
							<nav className="fd-work-navigation">
								<a
									href="?shell&surface=feed"
									aria-current={
										params.get("surface") === "feed" ? "page" : undefined
									}
								>
									Feed
								</a>
								<a
									href="?shell&surface=question"
									aria-current={
										params.get("surface") !== "feed" ? "page" : undefined
									}
								>
									Deck 12
								</a>
							</nav>
							<div ref={setTarget} className="fd-work-toolbar-slot" />
						</div>
					</div>
				</div>
			</OsTopbarActionsTargetContext.Provider>
		</WorkToolbarTargetContext.Provider>
	);
}
function ProjectFilterProof() {
	const [value, setValue] = useState("all");
	const options = [
		{ value: "all", label: "All projects" },
		...Array.from({ length: 20 }, (_, i) => ({
			value: `project-${i}`,
			label: `Project ${i}`,
		})),
	];
	return (
		<DecisionFilterChip
			label={options.find((option) => option.value === value)?.label}
			ariaLabel="Decision project"
			value={value}
			onValueChange={setValue}
			options={options}
			searchable
		/>
	);
}
createRoot(document.getElementById("root")!).render(
	<QueryClientProvider client={client}>
		<ProofFrame>
			{params.get("surface") === "filters" ? (
				<ProjectFilterProof />
			) : params.get("surface") === "motion-failure" ? (
				<div className="feed-deck fd-deck">
					<WorkDecisionCard
						kind="decision"
						title="Keep the card when saving fails"
						askedBy="11111111-1111-4111-8111-111111111111 session"
						actor={{
							type: "external_agent",
							id: "fictional-laptop",
							harness: "codex",
						}}
						actions={[{ id: "approve", label: "Approve", intent: "approve" }]}
						onDecision={async () => {
							throw new Error("Could not save this choice");
						}}
					/>
				</div>
			) : (
				<WorkActorDirectoryContext.Provider
					value={
						new Map([
							[
								"external_agent:codex",
								{ name: "Pine laptop", for: { name: "Morgan Lee" } },
							],
						])
					}
				>
					<WorkspaceAppRenderer manifest={manifest} />
				</WorkActorDirectoryContext.Provider>
			)}
		</ProofFrame>
	</QueryClientProvider>,
);
