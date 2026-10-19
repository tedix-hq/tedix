import { call, implement } from "@orpc/server";
import { attentionContract } from "@tedix/api-contract/contracts/attention";
import { requireOrgId } from "../org-scope";
import { recordObservedLearningInteraction } from "../../services/learning-interaction-recorder";
import {
	cardsFromSheet,
	verdictCells,
	rowWrite,
} from "@tedix/api-contract/utils/card-review";
import { osWorkspacesContractRouter } from "./os-workspaces";
import { AUTHZ, type BaseContext, withAuth, withAuthorization } from "../orpc";
import { workInteractionsContractRouter } from "./work-interactions";
import {
	classifyDeckCard,
	DecisionEnvelopeSchema,
} from "@tedix/api-contract/schemas/os-decision-deck";
import { humanReservedActionClasses } from "@tedix/api-contract/utils/approval-policy";

const os = implement(attentionContract).$context<BaseContext>();
const authenticated = os.use(withAuth);
const read = authenticated.use(AUTHZ.messagingRead);
const write = authenticated.use(
	withAuthorization(
		{
			handlerOwnedUserAuthorization:
				"Only bounded feedback reaches canonical interaction or sheet mutations, which revalidate the credential recipient/resource access and tenant on every write",
		},
		"mcp:messaging.write",
	),
);

export const attentionContractRouter = os.router({
	listDeckCards: read.listDeckCards.handler(async ({ input, context }) => {
		const { loadDeckProjection } =
			await import("../../services/attention-projection");
		const { cards, count, complete, observedAt } = await loadDeckProjection(
			context,
			input,
		);
		return { cards: cards.slice(0, input.limit), count, complete, observedAt };
	}),
	getDeckCard: read.getDeckCard.handler(async ({ input, context, errors }) => {
		const { loadDeckProjection } =
			await import("../../services/attention-projection");
		const projection = await loadDeckProjection(context, input);
		const card = projection.cards.find((card) => card.id === input.cardId);
		if (!card && !projection.complete)
			throw errors.CONFLICT({
				message: "Deck inventory is incomplete; absence is unknown",
			});
		if (!card)
			throw errors.NOT_FOUND({ message: "Card is not in your current Deck" });
		return card;
	}),
	decideDeckCard: write.decideDeckCard.handler(
		async ({ input: requestInput, context, errors }) => {
			const input = requestInput.decision;
			const { loadDeckProjection } =
				await import("../../services/attention-projection");
			const projection = await loadDeckProjection(context, {
				limit: 100,
				timeZone: input.timeZone,
				gadgetId: input.gadgetId,
			});
			if (!projection.complete)
				throw errors.CONFLICT({
					message: "Deck inventory is incomplete; reload before deciding",
				});
			const cardId =
				input.kind === "factory"
					? input.cardId
					: input.kind === "interaction"
						? input.decision.requestId
						: input.kind === "work_approval"
							? `work-approval:${input.decision.proposalId}`
							: `approval:${input.decision.id}`;
			const card = projection.cards.find((card) => card.id === cardId);
			if (!card)
				throw errors.NOT_FOUND({ message: "Card is not in your current Deck" });
			if (input.kind === "factory") {
				if (!card.factory)
					throw errors.BAD_REQUEST({ message: "Card is not a factory card" });
				const source =
					projection.config.factorySources[card.factory.sourceIndex];
				if (!source)
					throw errors.CONFLICT({ message: "Factory source changed" });
				const detail = await call(
					osWorkspacesContractRouter.outputs.get,
					{ outputId: card.factory.outputId },
					{ context },
				);
				if (
					detail.currentRevision.revision !== input.expectedRevision ||
					detail.currentRevision.content.kind !== "sheet"
				)
					throw errors.CONFLICT({
						message: "Factory sheet changed; reload before deciding",
					});
				const parsed = cardsFromSheet({
					source,
					sourceIndex: card.factory.sourceIndex,
					outputId: card.factory.outputId,
					sheetTitle: detail.output.title,
					runCreatedAt: detail.output.createdAt,
					body: detail.currentRevision.content,
				});
				if ("missing" in parsed)
					throw errors.CONFLICT({
						message: "Configured card columns are missing",
					});
				const original = parsed.cards.find(
					(candidate) => candidate.rowIndex === card.factory!.rowIndex,
				);
				if (!original)
					throw errors.CONFLICT({ message: "Factory card changed" });
				const range = rowWrite(
					detail.currentRevision.content,
					original.rowIndex,
					verdictCells(source, original, {
						kind: input.verdict,
						reason: input.reason,
					}),
				);
				const result = await call(
					osWorkspacesContractRouter.outputs.setSheetRange,
					{
						outputId: card.factory.outputId,
						startRow: original.rowIndex,
						...range,
						expectedRevision: input.expectedRevision,
						note: `Card review: card ${original.number} marked ${input.verdict.replace("_", " ")}`,
					},
					{ context },
				);
				await recordObservedLearningInteraction(context, {
					organizationId: requireOrgId(context),
					clientEventId: `factory-verdict:${result.revision.id}:${original.rowIndex}`,
					eventKind: input.verdict === "not_useful" ? "rejected" : "accepted",
					surface: "decision_deck",
					targetType: "output",
					targetId: original.outputId,
					metadata: {
						decisionClass:
							`factory:${source.label}:${original.type || "card"}`.slice(
								0,
								100,
							),
						decisionChoice: input.verdict,
						rowIndex: original.rowIndex,
						reason: input.reason,
					},
				});
				return { saved: true as const, cardId: input.cardId };
			}

			const cardUrl = context.env.OS_URL
				? new URL(card.source, context.env.OS_URL).toString()
				: `Tedix OS path ${card.source}`;
			const requiresHuman = () =>
				errors.FORBIDDEN({
					message: `This decision is not bounded feedback. Open ${cardUrl}, or ask Home to obtain human approval. No response or effect was saved.`,
				});
			if (input.kind !== "interaction") throw requiresHuman();
			const request = card.interaction?.request;
			if (!request) throw requiresHuman();
			if (request.version !== input.decision.expectedRequestVersion)
				throw errors.CONFLICT({
					message: "This decision changed; reload the card",
				});
			const metadata = request.metadata;
			const parsed = DecisionEnvelopeSchema.safeParse(metadata.decisionDeck);
			const envelope = parsed.success ? parsed.data : null;
			const classId =
				envelope?.classId ?? String(metadata.decisionClass ?? request.kind);
			const presentation = metadata.cardPresentation;
			const critical =
				classifyDeckCard({
					kind: card.kind,
					classId,
					risk:
						typeof metadata.riskLevel === "string"
							? metadata.riskLevel
							: undefined,
					action: String(
						metadata.approvalOperation ??
							`${request.subject}\n${request.prompt}`,
					),
					protectedEffects:
						envelope?.protectedEffects ??
						(card.kind === "outbound"
							? ["message"]
							: metadata.localImport
								? ["consent"]
								: []),
					needsPerson: true,
				}).reason === "critical";
			const reserved = humanReservedActionClasses(
				`${classId}\n${request.subject}\n${request.prompt}\n${envelope?.proposal ?? ""}\n${envelope?.recommendation ?? ""}\n${input.decision.body}`,
			);
			// The nested respond handler can execute envelope effects or start handoffs.
			// Reject those capabilities here, rather than relying on wrapper annotations.
			if (
				critical ||
				reserved.length ||
				request.kind === "handoff" ||
				["outbound", "approval"].includes(card.kind) ||
				metadata.approvalOperation !== undefined ||
				Boolean(metadata.localImport) ||
				(metadata.riskLevel !== undefined &&
					!["low", "medium"].includes(String(metadata.riskLevel))) ||
				(metadata.protectedEffects !== undefined &&
					(!Array.isArray(metadata.protectedEffects) ||
						metadata.protectedEffects.length > 0)) ||
				(metadata.reversibility !== undefined &&
					metadata.reversibility !== "two_way") ||
				(metadata.decisionDeck !== undefined && !parsed.success) ||
				(presentation &&
					typeof presentation === "object" &&
					!Array.isArray(presentation) &&
					presentation.effectStatus === "unknown") ||
				(envelope &&
					(envelope.reversibility !== "two_way" ||
						envelope.protectedEffects.length > 0 ||
						envelope.options.some((option) => option.effect)))
			)
				throw requiresHuman();
			await call(workInteractionsContractRouter.respond, input.decision, {
				context,
			});
			return { saved: true as const, cardId: input.decision.requestId };
		},
	),
	listFeedForYou: read.listFeedForYou.handler(async ({ input, context }) => {
		const { loadForYouProjection } =
			await import("../../services/attention-projection");
		return loadForYouProjection(context, input);
	}),
});
