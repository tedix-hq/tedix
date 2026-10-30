import { call, implement } from "@orpc/server";
import { attentionContract } from "@tedix/api-contract/contracts/attention";
import { getOrganizationProfile } from "@tedix/db/queries/organizations";
import { getOrganizationDomain } from "@tedix/db/queries/organization-domains";
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
import {
	deckResponseRequiresHuman,
	isFactsChangedReview,
} from "@tedix/api-contract/utils/deck-action-boundary";
import {
	rowReviewResultMetadata,
	rowReviewSpec,
	rowReviewSummary,
	rowReviewWrites,
} from "@tedix/api-contract/utils/row-review";

const os = implement(attentionContract).$context<BaseContext>();
const authenticated = os.use(withAuth);
const read = authenticated.use(AUTHZ.messagingRead);
async function attentionOsOrigin(
	context: BaseContext,
): Promise<string | undefined> {
	const organizationId = requireOrgId(context);
	const [organization, domain] = await Promise.all([
		getOrganizationProfile(context.db, organizationId),
		getOrganizationDomain(context.db, organizationId),
	]);
	if (domain?.status === "active" && domain.providerHostnameId)
		return `https://${domain.hostname}`;
	if (!organization || !/^[a-z0-9][a-z0-9-]*$/.test(organization.slug))
		return undefined;
	try {
		const origin = new URL(context.env.OS_URL);
		if (origin.protocol !== "https:" || origin.username || origin.password)
			return undefined;
		origin.hostname = `${organization.slug}.${origin.hostname}`;
		return origin.origin;
	} catch {
		return undefined;
	}
}
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
		const osOrigin = await attentionOsOrigin(context);
		const cards = visible.map((card, index) =>
			deckDisplayCard(
				card,
				index,
				{
					gadgetId: input.gadgetId,
					timeZone: input.timeZone,
					osOrigin,
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
		const osOrigin = await attentionOsOrigin(context);
		const cards = projection.items.map((item) =>
			feedDisplayCard(item, osOrigin),
		);
		return {
			cards,
			needsYou: cards.filter(
				(_, index) => projection.items[index]!.needsAction,
			),
			updates: cards.filter(
				(_, index) => !projection.items[index]!.needsAction,
			),
			complete: projection.complete,
			incompleteSources: projection.incompleteSources,
			observedAt: projection.observedAt,
			empty: cards.length === 0,
			notice: projection.complete
				? ""
				: `Some sources could not be read: ${(projection.incompleteSources ?? []).join(", ")}. Reload for all of Activity.`,
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
				message: "Decisions inventory is incomplete; absence is unknown",
			});
		if (!card) {
			const { explainDeckCardAbsence } =
				await import("../../services/deck-card-absence");
			throw errors.NOT_FOUND({
				message: await explainDeckCardAbsence(context, input.cardId, {
					projectId: input.projectId ?? projection.config?.projectId,
					timeZone: input.timeZone,
					routing: projection.config?.routing,
					model: projection.model,
				}),
			});
		}
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
			if (
				input.kind === "interaction" &&
				input.decision.metadata?.cardAction === "dismiss" &&
				input.decision.resolvesRequest &&
				input.decision.responseKind === "answer"
			) {
				const { getWorkInteraction } =
					await import("@tedix/db/queries/work-items/interactions");
				const orgId = requireOrgId(context);
				const review = await getWorkInteraction(context.db, {
					orgId,
					interactionId: input.decision.requestId,
				});
				if (review && isFactsChangedReview(review)) {
					const { verifiedActiveWorkActor } =
						await import("./work-items-principal");
					const actor = await verifiedActiveWorkActor(context, orgId);
					const { retireDecisionReviews } =
						await import("@tedix/db/queries/work-items/decision-review-retirement");
					const retired = await retireDecisionReviews(context.db, {
						orgId,
						now: new Date().toISOString(),
						dismiss: {
							id: review.id,
							version: input.decision.expectedRequestVersion,
							actorType: actor.type,
							actorId: actor.id,
							note: input.decision.body,
						},
					});
					if (!retired)
						throw errors.CONFLICT({
							message: "This review changed; reload the card",
						});
					return { saved: true as const, cardId: review.id };
				}
			}
			const { loadDeckProjection } =
				await import("../../services/attention-projection");
			const projection = await loadDeckProjection(context, {
				limit: 100,
				timeZone: input.timeZone,
				gadgetId: input.gadgetId,
			});
			if (!projection.complete)
				throw errors.CONFLICT({
					message: "Decisions inventory is incomplete; reload before deciding",
				});
			const cardId =
				input.kind === "factory" ||
				input.kind === "factory_changes" ||
				input.kind === "factory_restore" ||
				input.kind === "request_changes" ||
				input.kind === "restore_revision"
					? input.cardId
					: input.kind === "row_review"
						? input.requestId
						: input.kind === "interaction"
							? input.decision.requestId
							: input.kind === "work_approval"
								? `work-approval:${input.decision.proposalId}`
								: `approval:${input.decision.id}`;
			const card = projection.cards.find((card) => card.id === cardId);
			if (!card) {
				const { explainDeckCardAbsence } =
					await import("../../services/deck-card-absence");
				throw errors.NOT_FOUND({
					message: await explainDeckCardAbsence(context, cardId, {
						projectId: projection.config?.projectId,
						timeZone: input.timeZone,
						routing: projection.config?.routing,
						model: projection.model,
					}),
				});
			}
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
					// A run of the source skill itself rewrites the draft: the sheet is
					// derived from the reviewer's delegated sources, which only that
					// skill's own runs may read and write.
					const started = await call(
						osWorkspacesContractRouter.schedules.runNow,
						{
							workspaceId: source.workspaceId,
							skillId: source.run.skillId,
							params: {
								revise: {
									cardSheetId: original.outputId,
									row: original.rowIndex,
									draftColumn: source.columns.draft,
									instruction: input.instruction,
									expectedRevision: input.expectedRevision,
								},
							},
							idempotencyKey: crypto.randomUUID(),
						},
						{ context },
					);
					if (started.status === "needs_access")
						throw errors.BAD_REQUEST({
							message: `Allow this factory to use your ${started.providerName ?? "account"} first, then ask again`,
						});
					await recordObservedLearningInteraction(context, {
						organizationId: requireOrgId(context),
						clientEventId: `factory-revision-request:${started.runId}`,
						eventKind: "answered",
						surface: "decision_capture",
						targetType: "output",
						targetId: original.outputId,
						runId: started.runId,
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
							skillId: source.run.skillId,
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

			if (input.kind === "row_review") {
				const request = card.interaction?.request;
				const spec = request ? rowReviewSpec(request.metadata) : null;
				if (!request || !spec)
					throw errors.BAD_REQUEST({
						message: "This card carries no sheet rows to review",
					});
				if (request.version !== input.expectedRequestVersion)
					throw errors.CONFLICT({
						message: "This decision changed; reload the card",
					});
				const detail = await call(
					osWorkspacesContractRouter.outputs.get,
					{ outputId: spec.sheet.outputId },
					{ context },
				);
				if (
					detail.currentRevision.revision !== spec.sheet.revision ||
					detail.currentRevision.content.kind !== "sheet"
				)
					throw errors.CONFLICT({
						message: "The sheet changed; reload the card before answering",
					});
				if (detail.output.title !== spec.sheet.title)
					throw errors.CONFLICT({
						message:
							"The sheet identity changed; reload the card before answering",
					});
				const sheet = detail.currentRevision.content;
				let writes: ReturnType<typeof rowReviewWrites>;
				try {
					writes = rowReviewWrites(sheet, spec, input.verdicts);
				} catch (error) {
					throw errors.BAD_REQUEST({
						message:
							error instanceof Error
								? error.message
								: "The row answers are invalid",
					});
				}
				const summary = rowReviewSummary(input.verdicts);
				const responseKind =
					request.kind === "input" ? "input_provided" : "answer";
				await call(
					workInteractionsContractRouter.respond,
					{
						requestId: request.id,
						expectedRequestVersion: request.version,
						responseKind,
						body: "Row review write started.",
						resolvesRequest: false,
						metadata: {
							schema: "tedix.row-review-result.v1",
							status: "started",
							source: "decision_deck",
						},
					},
					{ context },
				);
				const written = await call(
					osWorkspacesContractRouter.outputs.setSheetRange,
					{
						outputId: spec.sheet.outputId,
						...writes[0]!,
						expectedRevision: spec.sheet.revision,
						note: `Row review: ${summary}`,
					},
					{ context },
				);
				await call(
					workInteractionsContractRouter.respond,
					{
						requestId: request.id,
						expectedRequestVersion: request.version + 1,
						responseKind,
						body: `${summary} — written back to "${spec.sheet.title}".`,
						resolvesRequest: true,
						metadata: rowReviewResultMetadata({
							sheetOutputId: spec.sheet.outputId,
							revision: written.revision.revision,
							revisionId: written.revision.id,
							verdicts: input.verdicts,
							source: "decision_deck",
						}),
					},
					{ context },
				);
				await recordObservedLearningInteraction(context, {
					organizationId: requireOrgId(context),
					clientEventId: `row-review:${written.revision.id}:${request.id}`,
					eventKind: input.verdicts.some(
						(verdict) => verdict.verdict === "corrected",
					)
						? "edited"
						: "accepted",
					surface: "decision_deck",
					targetType: "work_interaction",
					targetId: request.id,
					metadata: {
						decisionClass: "row_review",
						decisionChoice: "row_review",
						cardId: card.id,
						cardTitle: card.label.slice(0, 500),
						rows: spec.rows.length,
						corrected: input.verdicts.filter(
							(verdict) => verdict.verdict === "corrected",
						).length,
						sheetOutputId: spec.sheet.outputId,
					},
				});
				return { saved: true as const, cardId: request.id };
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
