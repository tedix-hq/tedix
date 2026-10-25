import type { QueryClient } from "@tanstack/react-query";
import { DecisionDeckConfigSchema } from "@tedix/api-contract/schemas/os-decision-deck";
import {
	osQuery,
	workAppsQueryOptions,
	pendingApprovalsQueryOptions,
	userProfileQueryOptions,
	projectListQueryOptions,
} from "@/lib/os-query-options";

/** Warm canonical per-viewer queries while the Work route chunk is loading. */
export function prefetchWorkDeck(client: QueryClient) {
	void import("@/components/decision-deck-app").catch(() => {});
	void client.prefetchQuery(pendingApprovalsQueryOptions());
	void client.prefetchQuery(
		osQuery.workApprovals.listInbox.queryOptions({
			input: { limit: 50, statuses: ["pending"] },
		}),
	);
	void client.prefetchQuery(
		osQuery.workInteractions.listInbox.queryOptions({
			input: { limit: 50, states: ["open"] },
		}),
	);
	void client.prefetchQuery(userProfileQueryOptions());
	void client.prefetchQuery(projectListQueryOptions(100));
	void client.prefetchQuery(
		osQuery.learningFeedback.model.queryOptions({ input: {} }),
	);
	void client.prefetchQuery(
		osQuery.learningFeedback.listInteractions.queryOptions({
			input: { scopeKind: "personal", limit: 200 },
		}),
	);
	void client
		.fetchQuery(workAppsQueryOptions())
		.then(async ({ items }) => {
			const deck = items.find(
				(item) =>
					item.currentRevision.manifest.entry === "tedix:app/decision-deck",
			);
			const parsed = DecisionDeckConfigSchema.safeParse(
				deck?.currentRevision.manifest.config,
			);
			if (!parsed.success) return;
			const config = parsed.data;
			// The default unscoped Deck reads the same keys warmed above; reuse
			// them instead of refetching (prefetchQuery refetches stale data).
			void client
				.ensureQueryData(
					osQuery.workApprovals.listInbox.queryOptions({
						input: {
							projectId: config.projectId,
							limit: config.limit,
							statuses: ["pending"],
						},
					}),
				)
				.catch(() => {});
			if (!config.projectId)
				void client
					.ensureQueryData(pendingApprovalsQueryOptions())
					.catch(() => {});
			await client
				.ensureQueryData(
					osQuery.workInteractions.listInbox.queryOptions({
						input: {
							projectId: config.projectId,
							limit: config.limit,
							states: ["open"],
						},
					}),
				)
				.catch(() => {});
		})
		.catch(() => {});
}
