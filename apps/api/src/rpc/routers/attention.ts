import { call, implement } from "@orpc/server";
import { attentionContract } from "@tedix/api-contract/contracts/attention";
import { requireOrgId } from "../org-scope";
import { recordObservedLearningInteraction } from "../../services/learning-interaction-recorder";
import {
	cardsFromSheet,
	factoryVerdictLearning,
	verdictCells,
	rowWrite,
} from "@tedix/api-contract/utils/card-review";
import { osWorkspacesContractRouter } from "./os-workspaces";
import { AUTHZ, type BaseContext, withAuth, withAuthorization } from "../orpc";
import { workInteractionsContractRouter } from "./work-interactions";
import { deckResponseRequiresHuman } from "@tedix/api-contract/utils/deck-action-boundary";

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
	showDeck: read.showDeck.handler(async ({ input, context }) => {
		const { loadDeckProjection } =
			await import("../../services/attention-projection");
		const { deckDisplayCard, attentionMarkdown } =
			await import("@tedix/api-contract/utils/attention-app-view");
		const projection = await loadDeckProjection(context, input);
		const { prepareDeckCardFaces } =
			await import("../../services/deck-card-face");
		const visible = await prepareDeckCardFaces(
			context,
			projection.cards.slice(0, input.limit),
			projection.model,
		);
		const cards = visible.map((card, index) =>
			deckDisplayCard(
				card,
				index,
				{
					gadgetId: input.gadgetId,
					timeZone: input.timeZone,
				},
				projection.config.routing,
			),
		);
		if (!projection.complete) for (const card of cards) card.actions = [];
		return {
			cards,
			needsYou: [],
			updates: [],
			complete: projection.complete,
			observedAt: projection.observedAt,
			empty: cards.length === 0,
			notice: projection.complete
				? ""
				: "Some sources could not be read. Reload before deciding.",
			markdown: attentionMarkdown(cards, projection.complete),
		};
	}),
	showFeed: read.showFeed.handler(async ({ input, context }) => {
		const { loadForYouProjection } =
			await import("../../services/attention-projection");
		const { feedDisplayCard, attentionMarkdown } =
			await import("@tedix/api-contract/utils/attention-app-view");
		const projection = await loadForYouProjection(context, input);
		const cards = projection.items.map(feedDisplayCard);
		return {
			cards,
			needsYou: cards.filter(
				(_, index) => projection.items[index]!.needsAction,
			),
			updates: cards.filter(
				(_, index) => !projection.items[index]!.needsAction,
			),
			complete: projection.complete,
			observedAt: projection.observedAt,
			empty: cards.length === 0,
			notice: projection.complete
				? ""
				: "Some sources could not be read. Reload for the full feed.",
			markdown: attentionMarkdown(cards, projection.complete),
		};
	}),
	rankDeckCards: write.rankDeckCards.handler(async ({ input, context }) => {
		const { rankCurrentDeck } =
			await import("../../services/deck-curator-ranker");
		return rankCurrentDeck(context, input);
	}),
	listDeckCards: read.listDeckCards.handler(async ({ input, context }) => {
		const { loadDeckProjection } =
			await import("../../services/attention-projection");
		const { cards, count, complete, observedAt, model } =
			await loadDeckProjection(context, input);
		const { loadDeckPipelineStatus } =
			await import("../../services/deck-pipeline-status");
		let visible = cards.slice(0, input.limit);
		if (input.presentation !== "stored") {
			const { prepareDeckCardFaces } =
				await import("../../services/deck-card-face");
			visible = await prepareDeckCardFaces(context, visible, model);
		}
		return {
			cards: visible,
			count,
			complete,
			observedAt,
			pipeline: await loadDeckPipelineStatus(context, model?.config),
		};
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
		const { prepareDeckCardFaces } =
			await import("../../services/deck-card-face");
		const display = (
			await prepareDeckCardFaces(
				context,
				[card],
				projection.model,
				input.retrySummary,
			)
		)[0]!;
		if (card.interaction)
			return {
				...display,
				history: await call(
					workInteractionsContractRouter.cardHistory,
					{ requestId: card.interaction.request.id },
					{ context },
				),
			};
		return display;
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
				input.kind === "factory" ||
				input.kind === "factory_changes" ||
				input.kind === "factory_restore" ||
				input.kind === "request_changes" ||
				input.kind === "restore_revision"
					? input.cardId
					: input.kind === "interaction"
						? input.decision.requestId
						: input.kind === "work_approval"
							? `work-approval:${input.decision.proposalId}`
							: `approval:${input.decision.id}`;
			const card = projection.cards.find((card) => card.id === cardId);
			if (!card)
				throw errors.NOT_FOUND({ message: "Card is not in your current Deck" });
			if (
				input.kind === "request_changes" ||
				input.kind === "restore_revision"
			) {
				if (!card.interaction)
					throw errors.BAD_REQUEST({
						message: "Open the card's source to request changes",
					});
				if (input.kind === "request_changes")
					await call(
						workInteractionsContractRouter.requestCardChanges,
						{
							requestId: input.cardId,
							expectedRequestVersion: input.expectedRequestVersion,
							instruction: input.instruction,
							field: input.field,
							chips: input.chips,
							anchors: input.anchors,
						},
						{ context },
					);
				else
					await call(
						workInteractionsContractRouter.reviseCard,
						{
							requestId: input.cardId,
							expectedRequestVersion: input.expectedRequestVersion,
							expectedRevision: input.expectedRevision,
							restoreRevision: input.restoreRevision,
						},
						{ context },
					);
				return { saved: true as const, cardId: input.cardId };
			}
			if (
				input.kind === "factory" ||
				input.kind === "factory_changes" ||
				input.kind === "factory_restore"
			) {
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
				if (input.kind === "factory_changes") {
					if (!source.run?.skillId || !source.columns.draft)
						throw errors.BAD_REQUEST({
							message:
								"Link this source's writing skill and draft column before requesting changes",
						});
					const schedules = await call(
						osWorkspacesContractRouter.schedules.list,
						{ workspaceId: source.workspaceId },
						{ context },
					);
					if (
						!schedules.items.some(
							(schedule) => schedule.skillId === source.run!.skillId,
						)
					)
						throw errors.BAD_REQUEST({
							message: "The source's writing skill is no longer linked",
						});
					const { getSkillEntry } =
						await import("@tedix/db/queries/cognitive/skill-crud");
					const skill = await getSkillEntry(
						context.db,
						source.run.skillId,
						requireOrgId(context),
					);
					if (!skill?.tediId)
						throw errors.BAD_REQUEST({
							message: "The source's writing agent is unavailable",
						});
					const { kernelRuntimeContractRouter } =
						await import("./kernel-runtime");
					const result = await call(
						kernelRuntimeContractRouter.enqueueMessage,
						{
							delegateToTediId: skill.tediId,
							workspaceContext: {
								workspaceId: source.workspaceId,
								workpiece: { kind: "output", id: original.outputId },
							},
							content: `Revise the agent-written draft for factory card ${original.number} in output ${original.outputId}, row ${original.rowIndex}, draft column ${source.columns.draft}. Use the existing source skill ${skill.id} as writing context. Human instruction: ${input.instruction}\nCurrent draft: ${original.draft}\nRead the current output and CAS-write only this draft cell through outputs.setSheetRange. Keep this same card and all action/decision cells unchanged. Include the human instruction in the revision note and preserve sources. Do not run the card's action, send messages or approve anything.`,
							idempotencyKey: `factory-revision:${original.outputId}:${original.rowIndex}:${input.expectedRevision}`,
						},
						{ context },
					);
					if (result.status === "failed")
						throw errors.SERVICE_UNAVAILABLE({
							message: "The writing agent could not start. Try again in Home.",
						});
					await recordObservedLearningInteraction(context, {
						organizationId: requireOrgId(context),
						clientEventId: `factory-revision-request:${result.run.id}`,
						eventKind: "answered",
						surface: "decision_capture",
						targetType: "output",
						targetId: original.outputId,
						metadata: {
							schema: "tedix.factory-card-change.v1",
							cardId,
							rowIndex: original.rowIndex,
							sourceColumn: source.columns.source,
							sourceText: original.sourceText,
							draftColumn: source.columns.draft,
							instruction: input.instruction,
							before: original.draft,
							sourceRevision: input.expectedRevision,
							runId: result.run.id,
							skillId: skill.id,
						},
					});
					return { saved: true as const, cardId };
				}
				if (input.kind === "factory_restore") {
					if (!source.columns.draft)
						throw errors.BAD_REQUEST({
							message: "This source has no draft column",
						});
					const past = await call(
						osWorkspacesContractRouter.outputs.history,
						{ outputId: original.outputId, revision: input.restoreRevision },
						{ context },
					);
					const revision = past.revisions[0];
					if (!revision || revision.content.kind !== "sheet")
						throw errors.BAD_REQUEST({
							message: "That card version is unavailable",
						});
					const oldCards = cardsFromSheet({
						source,
						sourceIndex: card.factory.sourceIndex,
						outputId: original.outputId,
						sheetTitle: detail.output.title,
						runCreatedAt: detail.output.createdAt,
						body: revision.content,
					});
					const old =
						"missing" in oldCards
							? null
							: oldCards.cards.find(
									(candidate) =>
										candidate.rowIndex === original.rowIndex &&
										candidate.number === original.number &&
										candidate.sourceText === original.sourceText,
								);
					if (!old)
						throw errors.CONFLICT({
							message:
								"The source row changed; restore the draft from its source history",
						});
					const range = rowWrite(
						detail.currentRevision.content,
						original.rowIndex,
						{ [source.columns.draft]: old.draft },
					);
					await call(
						osWorkspacesContractRouter.outputs.setSheetRange,
						{
							outputId: original.outputId,
							startRow: original.rowIndex,
							...range,
							expectedRevision: input.expectedRevision,
							note: `Restore card ${original.number} draft from version ${input.restoreRevision}`,
						},
						{ context },
					);
					await recordObservedLearningInteraction(context, {
						organizationId: requireOrgId(context),
						clientEventId: `factory-card-restore:${original.outputId}:${original.rowIndex}:${input.expectedRevision}`,
						eventKind: "edited",
						surface: "decision_capture",
						targetType: "output",
						targetId: original.outputId,
						metadata: {
							cardId,
							before: original.draft,
							after: old.draft,
							cause: "restore",
							restoreRevision: input.restoreRevision,
						},
					});
					return { saved: true as const, cardId };
				}
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
						...factoryVerdictLearning(source, original, input.reason),
						decisionChoice: input.verdict,
						cardId: card.id,
						cardTitle: card.label.slice(0, 500),
						cardSummary: (
							original.why ||
							original.sourceText ||
							card.label
						).slice(0, 2000),
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
			if (deckResponseRequiresHuman(card, input.decision.body))
				throw requiresHuman();
			await call(workInteractionsContractRouter.respond, input.decision, {
				context,
			});
			return { saved: true as const, cardId: input.decision.requestId };
		},
	),
	curationInbox: read.curationInbox.handler(async ({ input, context }) => {
		const { curationInbox } = await import("../../services/deck-curation");
		return curationInbox(context, input);
	}),
	curateDeckCard: write.curateDeckCard.handler(async ({ input, context }) => {
		const { curateDeckCard } = await import("../../services/deck-curation");
		return curateDeckCard(context, input);
	}),
	retireDeckCard: write.retireDeckCard.handler(async ({ input, context }) => {
		const { retireDeckCard } = await import("../../services/deck-retirement");
		return retireDeckCard(context, input);
	}),
	getDeckPipelineStatus: read.getDeckPipelineStatus.handler(
		async ({ context }) => {
			const { getDecisionLearningConfig } =
				await import("@tedix/db/queries/decision-learning");
			const { readDeckPipelineStatus } =
				await import("../../services/deck-pipeline-status");
			return readDeckPipelineStatus(
				context,
				await getDecisionLearningConfig(context.db, requireOrgId(context)),
			);
		},
	),
	markDeckCardNotUseful: write.markDeckCardNotUseful.handler(
		async ({ input, context }) => {
			const { markDeckCardNotUseful } =
				await import("../../services/deck-learning");
			return markDeckCardNotUseful(context, input);
		},
	),
	removeDeckRule: write.removeDeckRule.handler(async ({ input, context }) => {
		const { removeDeckRule } = await import("../../services/deck-learning");
		return removeDeckRule(context, input);
	}),
	mergeDeckCards: write.mergeDeckCards.handler(async ({ input, context }) => {
		const { mergeDeckCards } = await import("../../services/deck-retirement");
		return mergeDeckCards(context, input);
	}),
	rankCurationInbox: write.rankCurationInbox.handler(
		async ({ input, context }) => {
			const { rankCurationInbox } =
				await import("../../services/deck-curation");
			return rankCurationInbox(context, input);
		},
	),
	listFeedForYou: read.listFeedForYou.handler(async ({ input, context }) => {
		const { loadForYouProjection } =
			await import("../../services/attention-projection");
		return loadForYouProjection(context, input);
	}),
});
