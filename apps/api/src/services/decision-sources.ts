import {
	decisionSourcesReview,
	retireDecisionSourceCard,
} from "@tedix/db/queries/work-items/decision-sources";
import { listWorkInteractionInbox } from "@tedix/db/queries/work-items/interactions";
import type { DbQueryClient } from "@tedix/db/query-client";

export async function refreshDecisionSourceCards(
	db: DbQueryClient,
	orgId: string,
	targetId: string,
	projectId?: string,
) {
	const now = new Date().toISOString();
	let cursor: { at: string; id: string } | undefined;
	let scanned = 0;
	let superseded = 0;
	// The same bounded traversal as the Deck projection; retain the original cursor after expiry.
	for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
		const page = await listWorkInteractionInbox(db, {
			orgId,
			targetType: "user",
			targetId,
			projectId,
			states: ["open"],
			limit: 200,
			observedAt: now,
			cursor,
		});
		for (const { request } of page.data) {
			scanned++;
			const review = await decisionSourcesReview(db, orgId, request);
			// New comments can be reviewed in the answer flow. Retiring the card
			// here would remove that opportunity before the person can read them.
			if (review.current || review.reviewable) continue;
			superseded += (
				await retireDecisionSourceCard(db, {
					orgId,
					id: request.id,
					version: request.version,
					targetId,
					now,
				})
			).length;
		}
		if (!page.nextCursor) return { scanned, superseded, hasMore: false };
		cursor = page.nextCursor;
	}
	return { scanned, superseded, hasMore: true };
}
