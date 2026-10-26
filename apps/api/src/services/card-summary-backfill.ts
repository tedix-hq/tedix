import type { BaseContext } from "../rpc/orpc";
import {
	listMissingCardSummaries,
	advanceCardSummaryBackfill,
	saveDecisionCardPresentation,
} from "@tedix/db/queries/work-items/card-presentation";
import { generateDecisionCard } from "./decision-card-generator";
import { bindCardPresentationSource } from "./card-presentation-source";
import { decisionSourcesCurrent } from "@tedix/db/queries/work-items/decision-sources";

/** Five cards, sequential generation, and no replacement of a concurrent current summary. */
export async function backfillCardSummaries(
	context: Pick<BaseContext, "db" | "env">,
	now: string,
) {
	const { rows, previous } = await listMissingCardSummaries(context.db, now);
	let saved = 0;
	let failed = 0;
	for (const request of rows) {
		try {
			if (!(await decisionSourcesCurrent(context.db, request.orgId, request)))
				continue;
			const presentation = await generateDecisionCard(
				context,
				{
					...request,
					prompt:
						typeof request.metadata.cardContent === "string"
							? request.metadata.cardContent
							: request.prompt,
				},
				undefined,
				{ timeoutMs: 8000 },
			);
			if (
				presentation &&
				(await saveDecisionCardPresentation(context.db, {
					orgId: request.orgId,
					requestId: request.id,
					personId: request.targetId!,
					expectedVersion: request.version,
					onlyMissing: true,
					presentation: await bindCardPresentationSource(presentation, request),
				}))
			)
				saved++;
			else failed++;
		} catch {
			failed++;
		}
	}
	// Failed/withheld cards are retried on the next pass; they cannot starve later cards.
	const last = rows.at(-1);
	await advanceCardSummaryBackfill(
		context.db,
		previous,
		last ? `${last.orgId}:${last.id}` : "",
	);
	return {
		summaryBackfillScanned: rows.length,
		summaryBackfillSaved: saved,
		summaryBackfillFailed: failed,
	};
}
