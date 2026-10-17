import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { DecisionDeckConfigSchema } from "@tedix/api-contract/schemas/os-decision-deck";
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
} from "../src/lib/os-query-options";
import { DECISION_DECK_EXAMPLES } from "../dev/decision-deck-fixture";
import "../src/styles.css";
import { ActivityFeedConfigSchema } from "@tedix/api-contract/schemas/os-activity-feed";
import { DEFAULT_OS_USER_PREFERENCES } from "@tedix/api-contract/schemas/user-settings";

const client = new QueryClient({
	defaultOptions: {
		queries: { enabled: false, staleTime: Infinity, retry: false },
	},
});
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
const projectId = "11111111-1111-4111-8111-111111111111";
const input = { projectId, limit: 20, cursor: undefined };
const today = new Date();
const event = (id: number, title: string, body: string, small = false) => ({
	id: `event-${id}`,
	workItemId: projectId,
	workItemTitle: title,
	body,
	eventType: small ? "created" : "completed",
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
	{ pages: [{ data: [], nextCursor: null }], pageParams: [undefined] },
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
	preferences: DEFAULT_OS_USER_PREFERENCES,
	revision: 0,
});
client.setQueryData(
	osQuery.learningFeedback.listInteractions.queryOptions({
		input: { scopeKind: "personal", eventKind: "edited", limit: 100 },
	}).queryKey,
	{ events: [] },
);
const params = new URLSearchParams(location.search);
if (params.get("motion") === "reduced")
	document.documentElement.dataset.motion = "reduced";
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
							: DECISION_DECK_EXAMPLES,
					...(params.get("cards") === "one"
						? { defaultLowStakesToDelegate: false }
						: {}),
				}),
			}),
});
createRoot(document.getElementById("root")!).render(
	<QueryClientProvider client={client}>
		<main className="mx-auto max-w-5xl p-3 md:p-8">
			{params.get("surface") === "motion-failure" ? (
				<div className="feed-deck fd-deck">
					<WorkDecisionCard
						kind="decision"
						title="Keep the card when saving fails"
						askedBy="11111111-1111-4111-8111-111111111111 session"
						actions={[{ id: "approve", label: "Approve", intent: "approve" }]}
						onDecision={async () => {
							throw new Error("Could not save this choice");
						}}
					/>
				</div>
			) : (
				<WorkspaceAppRenderer manifest={manifest} />
			)}
		</main>
	</QueryClientProvider>,
);
