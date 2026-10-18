import type { QueryClient } from "@tanstack/react-query";
import { DecisionDeckConfigSchema } from "@tedix/api-contract/schemas/os-decision-deck";
import {
	osQuery,
	workAppsQueryOptions,
	pendingApprovalsQueryOptions,
	userProfileQueryOptions,
	projectListQueryOptions,
	workInteractionDetailQueryOptions,
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
	void client
		.fetchQuery(
			osQuery.workInteractions.listInbox.queryOptions({
				input: { limit: 50, states: ["open"] },
			}),
		)
		.then((inbox) =>
			Promise.all(
				inbox.data
					.slice(0, 3)
					.map((row) =>
						client.prefetchQuery(
							workInteractionDetailQueryOptions(row.request.id),
						),
					),
			),
		)
		.catch(() => {});
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
			void client.prefetchQuery(
				osQuery.workApprovals.listInbox.queryOptions({
					input: {
						projectId: config.projectId,
						limit: config.limit,
						statuses: ["pending"],
					},
				}),
			);
			if (!config.projectId)
				void client.prefetchQuery(pendingApprovalsQueryOptions());
			const inbox = await client.fetchQuery(
				osQuery.workInteractions.listInbox.queryOptions({
					input: {
						projectId: config.projectId,
						limit: config.limit,
						states: ["open"],
					},
				}),
			);
			await Promise.all(
				inbox.data
					.slice(0, 3)
					.map((row) =>
						client.prefetchQuery(
							workInteractionDetailQueryOptions(row.request.id),
						),
					),
			);
		})
		.catch(() => {});
}
