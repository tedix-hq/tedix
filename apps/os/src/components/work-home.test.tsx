import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vite-plus/test";
import { learnDecisions } from "@tedix/api-contract/utils/decision-learning";
import { WorkHome } from "./work-home";
import {
	workAppsQueryOptions,
	activeWorkspacesQueryOptions,
	canvasGadgetsQueryOptions,
	canvasGadgetDetailQueryOptions,
	osQuery,
	pendingApprovalsQueryOptions,
	userProfileQueryOptions,
} from "@/lib/os-query-options";
import type { WorkHomeSearch } from "@/lib/work-home-search";

vi.mock("@/components/workspace-app-renderer", () => ({
	WorkspaceAppRenderer: ({
		manifest,
		activityFeed,
	}: {
		manifest: { entry: string };
		activityFeed?: { decide?: React.ReactNode; apps?: React.ReactNode };
	}) => (
		<article data-entry={manifest.entry}>
			{activityFeed?.decide}
			{activityFeed?.apps}
		</article>
	),
}));

function render(
	search: WorkHomeSearch,
	accessible = true,
	defaultEntry?: string,
	pendingEntry?: string,
) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Infinity } },
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
	client.setQueryData(userProfileQueryOptions().queryKey, {
		id: "morgan",
		email: "morgan@example.com",
		name: "Morgan",
		avatarUrl: null,
		revision: 0,
		updatedAt: null,
	});
	client.setQueryData(
		osQuery.learningFeedback.listInteractions.queryOptions({
			input: { scopeKind: "personal", limit: 200 },
		}).queryKey,
		{ events: [] },
	);
	client.setQueryData(
		osQuery.learningFeedback.model.queryOptions({ input: {} }).queryKey,
		learnDecisions({
			organizationId: "44444444-4444-4444-8444-444444444444",
			personId: "morgan",
			events: [],
			now: new Date(),
		}),
	);
	const workspaceId = "11111111-1111-4111-8111-111111111111";
	const creator = {
		organizationId: "44444444-4444-4444-8444-444444444444",
		createdByKind: "user" as const,
		createdById: "cedar-owner",
		createdAt: "2026-10-01T12:00:00Z",
	};
	const workspace = {
		...creator,
		id: workspaceId,
		name: "Cedar desk",
		description: null,
		status: "active" as const,
		sourceBlueprintId: null,
		sourceBlueprintRevisionId: null,
		sourceBlueprintRevisionNumber: null,
		instantiationPreflight: null,
		rollbackReference: null,
		blueprintDecision: null,
		updatedAt: creator.createdAt,
		visibility: "org" as const,
		ownerUserId: null,
	};

	const gadgets = [
		"activity-feed",
		"decision-deck",
		"portfolio",
		"agents",
		"office",
		"outbound-review",
	].map((entry, index) => ({
		...creator,
		id: `22222222-2222-4222-8222-${String(index).padStart(12, "0")}`,
		name: `Cedar ${entry}`,
		workspaceId,
		status: "active" as const,
		description: null,
		currentRevisionId: null,
		sourceBlueprintRevisionId: null,
		updatedAt: creator.createdAt,
		entry: `tedix:app/${entry}`,
	}));
	client.setQueryData(activeWorkspacesQueryOptions().queryKey, {
		items: accessible ? [workspace] : [],
		truncated: false,
	});
	client.setQueryData(canvasGadgetsQueryOptions(workspaceId).queryKey, {
		items: gadgets,
		truncated: false,
	});
	for (const gadget of gadgets.filter(
		(g) => g.entry !== `tedix:app/${pendingEntry}`,
	))
		client.setQueryData(
			canvasGadgetDetailQueryOptions(workspaceId, gadget.id).queryKey,
			{
				gadget,
				currentRevision: {
					...creator,
					id: gadget.id,
					gadgetId: gadget.id,
					revision: 1,
					sourceArtifactRef: null,
					manifest: {
						entry: gadget.entry,
						navigation: {
							board: true,
							workDefault: gadget.entry === `tedix:app/${defaultEntry}`,
						},
						capabilities: [],
						config: { version: 1 },
					},
				},
			},
		);
	if (!pendingEntry)
		client.setQueryData(workAppsQueryOptions().queryKey, {
			items: accessible
				? gadgets.flatMap((gadget) => {
						const data = client.getQueryData(
							canvasGadgetDetailQueryOptions(workspaceId, gadget.id).queryKey,
						);
						return data?.currentRevision
							? [{ ...data, currentRevision: data.currentRevision }]
							: [];
					})
				: [],
			truncated: false,
		});
	client.setQueryData(
		osQuery.workInteractions.listInbox.queryOptions({
			input: { projectId: undefined, limit: 50, states: ["open"] },
		}).queryKey,
		{
			data: [],
			hasMore: false,
			nextCursor: null,
			observedAt: "2026-10-17T12:00:00Z",
		},
	);
	client.setQueryData(
		osQuery.workApprovals.listInbox.queryOptions({
			input: { projectId: undefined, limit: 50, statuses: ["pending"] },
		}).queryKey,
		{
			data: [],
			hasMore: false,
			nextCursor: null,
			observedAt: "2026-10-17T12:00:00Z",
		},
	);
	client.setQueryData(pendingApprovalsQueryOptions().queryKey, {
		data: [],
		pagination: { limit: 50, offset: 0, total: 0, hasMore: false },
	});
	const html = renderToStaticMarkup(
		<QueryClientProvider client={client}>
			<WorkHome search={search} />
		</QueryClientProvider>,
	);
	client.clear();
	return new DOMParser().parseFromString(html, "text/html");
}

it("opens Feed with the Decide count and configured apps, then opens the same Deck renderer", () => {
	const feed = render({});
	expect(feed.querySelector("article")?.getAttribute("data-entry")).toBe(
		"tedix:app/activity-feed",
	);
	expect(feed.querySelector('nav[aria-label="Work"]')).toBeNull();
	expect(feed.querySelector('a[href="/work?view=deck"]')?.textContent).toBe(
		"Deck clear →",
	);
	expect(feed.querySelector('nav[aria-label="Apps"]')?.textContent).toContain(
		"Cedar portfolio",
	);
	expect(
		render({ view: "deck" })
			.querySelector("article")
			?.getAttribute("data-entry"),
	).toBe("tedix:app/decision-deck");
	expect(
		render({ app: "office" })
			.querySelector("article")
			?.getAttribute("data-entry"),
	).toBe("tedix:app/office");
});
it("does not recover apps from another fictional organization's cached details", () => {
	const pine = render({}, false);
	expect(pine.querySelector("article")).toBeNull();
	expect(pine.body.textContent).not.toContain("Cedar");
	expect(pine.body.textContent).toContain("Set up Feed and Deck");
	expect(
		[...pine.querySelectorAll("button")].some(
			(button) => button.textContent === "Set up Feed and Deck",
		),
	).toBe(true);
});

it("opens the configured Work start app while explicit views and apps still win", () => {
	const entry = (search: WorkHomeSearch, defaultEntry = "decision-deck") =>
		render(search, true, defaultEntry)
			.querySelector("article")
			?.getAttribute("data-entry");
	expect(entry({})).toBe("tedix:app/decision-deck");
	expect(entry({ view: "feed" })).toBe("tedix:app/activity-feed");
	expect(entry({ app: "office" })).toBe("tedix:app/office");
	expect(entry({}, "office")).toBe("tedix:app/activity-feed");
	expect(
		render({}, false, "decision-deck").querySelector("article"),
	).toBeNull();
});

it("waits for the configured default instead of flashing the Feed during discovery", () => {
	expect(
		render({}, true, "decision-deck", "decision-deck").querySelector("article"),
	).toBeNull();
	expect(
		render({ view: "feed" }, true, "decision-deck", "decision-deck")
			.querySelector("article")
			?.getAttribute("data-entry"),
	).toBeUndefined();
});

it("opens the Deck without a New Work item form above it", () => {
	for (const view of ["deck", "feed"] as const) {
		const page = render({ view });
		expect(page.querySelector("article")).not.toBeNull();
		expect(page.body.textContent).not.toContain("New Work item");
		expect(page.querySelector("form")).toBeNull();
	}
});
