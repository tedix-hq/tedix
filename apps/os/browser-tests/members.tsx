import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { DecisionDeckConfigSchema } from "@tedix/api-contract/schemas/os-decision-deck";
import { ActivityFeedConfigSchema } from "@tedix/api-contract/schemas/os-activity-feed";
import { DecisionLearningConfigSchema } from "@tedix/api-contract/schemas/decision-learning";
import { learnDecisions } from "@tedix/api-contract/utils/decision-learning";
import { DEFAULT_OS_USER_PREFERENCES } from "@tedix/api-contract/schemas/user-settings";
import { WorkHome } from "../src/components/work-home";
import { setOsFormattingPreferences } from "../src/lib/format";
import {
	workAppsQueryOptions,
	activeWorkspacesQueryOptions,
	canvasGadgetsQueryOptions,
	canvasGadgetDetailQueryOptions,
	canvasOutputsQueryOptions,
	outputDetailQueryOptions,
	osQuery,
	pendingApprovalsQueryOptions,
	projectListQueryOptions,
	userProfileQueryOptions,
	userPreferencesQueryOptions,
	workAgentSessionsQueryOptions,
} from "../src/lib/os-query-options";
import "../src/styles.css";

const params = new URLSearchParams(location.search);
const locale = params.get("locale") ?? "es";
setOsFormattingPreferences({ locale, timezone: "Europe/Berlin" });
document.documentElement.lang = locale;
document.documentElement.classList.toggle(
	"dark",
	params.get("theme") === "dark",
);
document.documentElement.style.colorScheme =
	params.get("theme") === "dark" ? "dark" : "light";
const client = new QueryClient({
	defaultOptions: {
		queries: { enabled: false, staleTime: Infinity, retry: false },
	},
});
const id = (n: number) =>
	`11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
const projectId = id(1),
	appSpace = id(2);
const now = new Date().toISOString();
const sources = [
	{
		label: "Inbox",
		workspaceId: id(3),
		title: "Luz · Inbox follow-up",
		why: "Prepare a short reply to the lab.",
	},
	{
		label: "Social",
		workspaceId: id(4),
		title: "Luz · Social introduction",
		why: "A useful introduction to the research team.",
	},
	{
		label: "Shared radar",
		workspaceId: id(5),
		title: "Shared radar · funding update",
		why: "Review the opportunity together.",
	},
	{
		label: "Owner private",
		workspaceId: id(6),
		title: "PRIVATE_OWNER_SENTINEL",
		why: "This must never appear.",
	},
].map((source) => ({
	...source,
	cardSheetPrefix: "Cards ",
	maxRuns: 3,
	columns: {
		source: "Source",
		why: "Why",
		useful: "Useful",
		reason: "Reason",
		done: "Done",
		result: "Result",
	},
	doIt: "approve" as const,
}));
const visibleSpaces = [appSpace, id(3), id(4), id(5)];
client.setQueryData(activeWorkspacesQueryOptions().queryKey, {
	items: visibleSpaces.map((workspaceId) => ({ id: workspaceId })),
	truncated: false,
});
const deck = DecisionDeckConfigSchema.parse({
	version: 1,
	factorySources: sources.map(({ title, why, ...source }) => source),
});
const feed = ActivityFeedConfigSchema.parse({
	version: 1,
	projects: [{ id: projectId, label: "Shared research" }],
	factorySources: sources.map(({ title, why, ...source }) => ({
		projectId,
		source,
	})),
	attentionBudget: 10,
});
const gadgets = [
	{
		id: id(7),
		workspaceId: appSpace,
		name: "Decisions",
		status: "active",
		createdAt: now,
		manifest: {
			entry: "tedix:app/decision-deck",
			navigation: { work: "deck", workDefault: true },
			capabilities: [],
			config: deck,
		},
	},
	{
		id: id(8),
		workspaceId: appSpace,
		name: "Activity",
		status: "active",
		createdAt: now,
		manifest: {
			entry: "tedix:app/activity-feed",
			navigation: { work: "feed" },
			capabilities: [],
			config: feed,
		},
	},
];
for (const workspaceId of visibleSpaces)
	client.setQueryData(canvasGadgetsQueryOptions(workspaceId).queryKey, {
		items: workspaceId === appSpace ? gadgets : [],
		truncated: false,
	});
for (const gadget of gadgets)
	client.setQueryData(
		canvasGadgetDetailQueryOptions(appSpace, gadget.id).queryKey,
		{ gadget, currentRevision: { manifest: gadget.manifest } },
	);
client.setQueryData(workAppsQueryOptions().queryKey, {
	items: gadgets.map((gadget) => ({
		gadget,
		currentRevision: { manifest: gadget.manifest },
	})),
	truncated: false,
});
for (const [index, source] of sources.entries()) {
	const output = {
		id: id(index + 10),
		workspaceId: source.workspaceId,
		kind: "sheet",
		status: "active",
		title: `Cards ${now}`,
		createdAt: now,
	};
	client.setQueryData(canvasOutputsQueryOptions(source.workspaceId).queryKey, {
		items: [output],
		truncated: false,
	});
	client.setQueryData(outputDetailQueryOptions(output.id).queryKey, {
		output,
		currentRevision: {
			revision: 1,
			content: {
				kind: "sheet",
				columns: ["Source", "Why", "Useful", "Reason", "Done", "Result"],
				rows: [[source.title, source.why, "", "", "", source.why]],
			},
		},
	});
}
client.setQueryData(userProfileQueryOptions().queryKey, {
	id: "fictional-luz",
	name: "Luz",
	role: "member",
});
client.setQueryData(userPreferencesQueryOptions().queryKey, {
	preferences: {
		...DEFAULT_OS_USER_PREFERENCES,
		locale,
		timezone: "Europe/Berlin",
	},
	revision: 1,
});
client.setQueryData(projectListQueryOptions(100).queryKey, {
	data: [{ id: projectId, name: "Shared research" }],
});
client.setQueryData(workAgentSessionsQueryOptions().queryKey, { sessions: [] });
client.setQueryData(
	osQuery.learningFeedback.model.queryOptions({ input: {} }).queryKey,
	learnDecisions({
		organizationId: "fictional-org",
		personId: "fictional-luz",
		config: DecisionLearningConfigSchema.parse({ enabled: true }),
		events: [],
		now: new Date(),
	}),
);
for (const input of [
	{ scopeKind: "personal" as const, limit: 200 },
	{ scopeKind: "personal" as const, eventKind: "edited" as const, limit: 100 },
])
	client.setQueryData(
		osQuery.learningFeedback.listInteractions.queryOptions({ input }).queryKey,
		{ events: [] },
	);
for (const state of ["open", "resolved"] as const)
	client.setQueryData(
		osQuery.workInteractions.listInbox.queryOptions({
			input: { projectId: undefined, limit: 50, states: [state] },
		}).queryKey,
		{ data: [], hasMore: false },
	);
client.setQueryData(
	osQuery.workInteractions.listInbox.queryOptions({
		input: {
			projectId: undefined,
			limit: 50,
			states: ["open"],
			decisionKind: "approval",
		},
	}).queryKey,
	{ data: [], hasMore: false },
);
client.setQueryData(
	osQuery.workApprovals.listInbox.queryOptions({
		input: { projectId: undefined, limit: 50, statuses: ["pending"] },
	}).queryKey,
	{ data: [], hasMore: false },
);
client.setQueryData(pendingApprovalsQueryOptions().queryKey, {
	data: [],
	pagination: { limit: 50, offset: 0, total: 0, hasMore: false },
});
const pageInput = { projectId, limit: 20, cursor: undefined };
const pages = (data: unknown) => ({ pages: [data], pageParams: [undefined] });
const pagination = {
	initialPageParam: undefined,
	getNextPageParam: () => undefined,
};
client.setQueryData(
	osQuery.workItems.listActivity.infiniteOptions({
		input: () => pageInput,
		...pagination,
	}).queryKey,
	pages({ events: [], nextCursor: null }),
);
client.setQueryData(
	osQuery.workItems.listAttemptProjection.infiniteOptions({
		input: () => ({
			...pageInput,
			outcomes: ["succeeded", "failed", "expired", "cancelled"],
		}),
		...pagination,
	}).queryKey,
	pages({ data: [], nextCursor: null }),
);
client.setQueryData(
	osQuery.workInteractions.listInbox.infiniteOptions({
		input: () => pageInput,
		...pagination,
	}).queryKey,
	pages({ data: [], nextCursor: null }),
);
client.setQueryData(
	osQuery.workApprovals.listInbox.infiniteOptions({
		input: () => pageInput,
		...pagination,
	}).queryKey,
	pages({ data: [], nextCursor: null }),
);

createRoot(document.getElementById("root")!).render(
	<QueryClientProvider client={client}>
		<div className="mx-auto max-w-5xl p-3 md:p-8">
			<p className="mb-4 text-sm text-kumo-subtle">
				Luz · fictional non-admin member · isolated verification
			</p>
			<WorkHome
				search={params.get("view") === "feed" ? { view: "feed" } : {}}
			/>
		</div>
	</QueryClientProvider>,
);
