import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { DecisionDeckConfigSchema } from "@tedix/api-contract/schemas/os-decision-deck";
import { WorkInteractionInboxRowSchema } from "@tedix/api-contract/schemas/work-interactions";
import { learnDecisions } from "@tedix/api-contract/utils/decision-learning";
import { WorkNeedsYouCount } from "@/components/work-needs-you-count";
import { useDeckCount } from "./use-deck-count";
import { osQuery, pendingApprovalsQueryOptions } from "./os-query-options";

vi.mock("./use-work-apps", () => ({
	useWorkApps: () => ({
		apps: [
			{
				role: "deck",
				manifest: { config },
				gadget: { workspaceId: "workspace" },
			},
		],
	}),
}));

vi.mock("./use-factory-card-count", () => ({
	useFactoryCardCount: () => ({
		count: 2,
		cards: [],
		pending: false,
		failed: false,
		more: false,
		refetch: vi.fn(),
	}),
}));
vi.mock("./api", async (original) => {
	const actual = await original<typeof import("./api")>();
	return {
		...actual,
		osApi: new Proxy(actual.osApi, {
			get: (target, key) =>
				key === "workInteractions"
					? new Proxy(actual.osApi.workInteractions, {
							get: (target, key) =>
								key === "refreshDecisionSources"
									? async () => ({ created: 0, scanned: 0, hasMore: false })
									: Reflect.get(target, key),
						})
					: key === "learningFeedback"
						? new Proxy(actual.osApi.learningFeedback, {
								get: (target, key) =>
									key === "recordInteraction"
										? async () => ({})
										: Reflect.get(target, key),
							})
						: Reflect.get(target, key),
		}),
	};
});

const config = DecisionDeckConfigSchema.parse({
	version: 1,
	dailyAttentionBudget: 2,
	batchTimesUtc: ["00:00"],
});
const now = new Date().toISOString();
const rows = [1, 2, 3, 4].map((number) =>
	WorkInteractionInboxRowSchema.parse({
		request: {
			id: `${number}1111111-1111-4111-8111-111111111111`,
			orgId: "55555555-5555-4555-8555-555555555555",
			workItemId: null,
			caseId: null,
			projectId: null,
			kind: "question",
			subject: `Opportunity ${number}`,
			prompt: "Review this fictional opportunity.",
			requestedFromType: "user",
			requestedFromId: "morgan",
			creatorType: "external_agent",
			creatorId: "fictional-codex",
			creatorSessionId: null,
			state: "open",
			requestedAt: now,
			dueAt: null,
			expiresAt: null,
			resolvedAt: null,
			version: 1,
			metadata:
				number === 4
					? {
							approvalOperation: "gmail.send",
							approvalTarget: "fictional-recipient",
						}
					: { decisionClass: "opportunity.lead" },
		},
		effectiveState: "open",
		canRespond: true,
		canCancel: false,
		workItem: null,
		responseCount: 0,
	}),
);
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
let client: QueryClient;
afterEach(async () => {
	await act(async () => root?.unmount());
	client?.clear();
	host?.remove();
	sessionStorage.clear();
});
function Count() {
	const queue = useDeckCount(config, "workspace");
	return <output>{queue.count}</output>;
}
it("sidebar and Decisions count the same routed queue, including factory cards", async () => {
	sessionStorage.setItem(
		"decision-deck:legacy-fixture",
		JSON.stringify({
			key: "legacy-fixture",
			ids: rows.map((row) => row.request.id),
			dismissed: [rows[0]!.request.id, rows[3]!.request.id],
		}),
	);
	client = new QueryClient({
		defaultOptions: {
			queries: { enabled: false, staleTime: Infinity, retry: false },
		},
	});
	const inboxKey = osQuery.workInteractions.listInbox.queryOptions({
		input: { limit: 50, states: ["open"] },
	}).queryKey;
	client.setQueryData(inboxKey, {
		data: [
			...rows,
			{
				...rows[0]!,
				request: {
					...rows[0]!.request,
					id: "61111111-1111-4111-8111-111111111111",
					kind: "coordination",
					metadata: { decisionClass: "routine.status" },
				},
			},
		],
		hasMore: false,
		nextCursor: null,
		observedAt: now,
	});
	client.setQueryData(
		osQuery.workInteractions.listInbox.queryOptions({
			input: { limit: 50, states: ["open"], decisionKind: "approval" },
		}).queryKey,
		{ data: [], hasMore: false, nextCursor: null, observedAt: now },
	);
	client.setQueryData(
		osQuery.workApprovals.listInbox.queryOptions({
			input: { limit: 50, statuses: ["pending"] },
		}).queryKey,
		{ data: [], hasMore: false, nextCursor: null, observedAt: now },
	);
	client.setQueryData(pendingApprovalsQueryOptions().queryKey, {
		data: [],
		pagination: { limit: 50, offset: 0, total: 0, hasMore: false },
	});
	client.setQueryData(
		osQuery.learningFeedback.model.queryOptions({ input: {} }).queryKey,
		learnDecisions({
			organizationId: "fictional-orchard",
			personId: "morgan",
			events: [],
			now: new Date(now),
		}),
	);
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<Count />
				<WorkNeedsYouCount />
			</QueryClientProvider>,
		),
	);
	const counts = () =>
		[...host.querySelectorAll('output, [aria-label^="Decisions waiting"]')].map(
			(element) => element.textContent,
		);
	expect(counts()).toEqual(["6", "6"]);
	expect(sessionStorage.length).toBeGreaterThan(0);
	await act(async () =>
		client.setQueryData(inboxKey, {
			data: rows.map((row, index) =>
				index
					? row
					: {
							...row,
							effectiveState: "resolved" as const,
							request: {
								...row.request,
								state: "resolved" as const,
								resolvedAt: now,
							},
						},
			),
			hasMore: false,
			nextCursor: null,
			observedAt: now,
		}),
	);
	await vi.waitFor(() => expect(counts()).toEqual(["5", "5"]));
});
