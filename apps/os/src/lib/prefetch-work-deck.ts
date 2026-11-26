import {
	activityWorkPagesQueryOptions,
	activityResultPagesQueryOptions,
} from "@/lib/activity-feed-query-options";
import { workSourceManifest } from "@tedix/api-contract/assets/work-view-blueprint";
import type { QueryClient } from "@tanstack/react-query";
import {
	ACTIVITY_FEED_ENTRY,
	ActivityFeedConfigSchema,
} from "@tedix/api-contract/schemas/os-activity-feed";
import { DecisionDeckConfigSchema } from "@tedix/api-contract/schemas/os-decision-deck";
import {
	osQuery,
	firstDecisionPageOptions,
	userPreferencesQueryOptions,
	workAppsQueryOptions,
} from "@/lib/os-query-options";

/** Warm canonical per-viewer queries while the Work route chunk is loading. */
export function prefetchWorkDeck(
	client: QueryClient,
	view?: "feed" | "deck",
	projectId?: string,
) {
	if (view === "deck") {
		void import("@/components/decision-deck-app").catch(() => {});
		void client.prefetchQuery(firstDecisionPageOptions());
		void client.prefetchQuery(workAppsQueryOptions());
		return;
	}
	void client
		.fetchQuery(workAppsQueryOptions())
		.then(({ items }) => {
			const feed = items.find(
				({ currentRevision: { manifest } }) =>
					manifest.navigation?.work === "feed" ||
					manifest.entry === ACTIVITY_FEED_ENTRY,
			);
			const landsOnFeed =
				view === "feed" ||
				(!view &&
					(feed?.currentRevision.manifest.navigation?.workDefault ||
						!items.some(
							(item) => item.currentRevision.manifest.navigation?.workDefault,
						)));
			if (landsOnFeed) {
				void import("@/components/activity-feed-app").catch(() => {});
				prefetchActivityFeed(
					client,
					feed && workSourceManifest(feed.currentRevision.manifest).config,
					projectId,
				);
				return;
			}
			const deck = items.find(
				(item) =>
					workSourceManifest(item.currentRevision.manifest).entry ===
					"tedix:app/decision-deck",
			);
			if (!deck) return;
			const parsed = DecisionDeckConfigSchema.safeParse(
				workSourceManifest(deck.currentRevision.manifest).config,
			);
			if (!parsed.success) return;
			void import("@/components/decision-deck-app").catch(() => {});
			void client.prefetchQuery(
				firstDecisionPageOptions(parsed.data.projectId, parsed.data.limit),
			);
		})
		.catch(() => {});
}

/** Activity's first-paint reads, so they start with the app chunk, not after it. */
function prefetchActivityFeed(
	client: QueryClient,
	value: unknown,
	projectId?: string,
) {
	const config = ActivityFeedConfigSchema.safeParse(
		value ?? { version: 1, scope: "organization", projects: [] },
	);
	const ignore = () => {};
	void client.ensureQueryData(userPreferencesQueryOptions()).catch(ignore);
	if (config.success) {
		const scopes = new Set<string | undefined>([
			...(config.data.scope === "organization" ? [projectId] : []),
			...config.data.projects
				.filter((p) => !projectId || p.id === projectId)
				.map((p) => p.id),
		]);
		for (const scope of scopes) {
			void client.prefetchInfiniteQuery(
				activityWorkPagesQueryOptions(scope, config.data.pageSize),
			);
			void client.prefetchInfiniteQuery(
				activityResultPagesQueryOptions(scope, config.data.pageSize),
			);
		}
	}
	const today = config.success ? config.data.today : undefined;
	if (today)
		void client
			.ensureQueryData(
				osQuery.osWorkspaces.outputs.get.queryOptions({
					input: { outputId: today.outputId },
				}),
			)
			.catch(ignore);
}
