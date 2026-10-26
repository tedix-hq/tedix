import type { getWorkInteraction } from "@tedix/db/queries/work-items/interactions";
import { safeExceptionTopology } from "../lib/safe-log-metadata";
import type { BaseContext } from "../rpc/orpc";
import { bindCardPresentationSource } from "./card-presentation-source";

type Interaction = NonNullable<Awaited<ReturnType<typeof getWorkInteraction>>>;

/**
 * Writes a person's card summary after the response, when the card is created
 * or revised, so opening it never waits on a model. The card shows the
 * original ask until this lands; a failure only leaves that text in place.
 */
export function queueCardFaceWrite(
	context: Pick<BaseContext, "db" | "env" | "waitUntil">,
	request: Interaction,
) {
	const personId = request.targetId;
	if (!context.waitUntil || request.targetType !== "user" || !personId) return;
	context.waitUntil(
		(async () => {
			const { generateDecisionCard } =
				await import("./decision-card-generator");
			const { saveDecisionCardPresentation } =
				await import("@tedix/db/queries/work-items/card-presentation");
			const presentation = await generateDecisionCard(context, {
				...request,
				prompt:
					typeof request.metadata.cardContent === "string"
						? request.metadata.cardContent
						: request.prompt,
			});
			if (presentation)
				await saveDecisionCardPresentation(context.db, {
					orgId: request.orgId,
					requestId: request.id,
					personId,
					expectedVersion: request.version,
					presentation: await bindCardPresentationSource(presentation, request),
				});
		})().catch((error) =>
			console.warn("decision card generation failed", {
				requestId: request.id,
				exception: safeExceptionTopology(error),
			}),
		),
	);
}
