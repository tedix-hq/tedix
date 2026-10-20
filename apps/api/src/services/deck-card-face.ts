import copySpec from "@tedix/api-contract/assets/decision-card-copy.v2.json";
import { containsCardSecret } from "@tedix/api-contract/utils/card-secrets";
import { DecisionCardPresentationSchema } from "@tedix/api-contract/schemas/decision-card-presentation";
import type { DeckCard } from "@tedix/api-contract/schemas/attention";
import { AttentionOfferedChoicesSchema } from "@tedix/api-contract/schemas/attention";
import { getUserConfig, putUserConfig } from "@tedix/db/queries/user-configs";
import { toJsonRecord } from "@tedix/db/utils/json";
import type { BaseContext } from "../rpc/orpc";
import { requireOrgId } from "../rpc/org-scope";
import { generateDecisionCard } from "./decision-card-generator";
import {
	checkDecisionCardCopy,
	decisionCardFaceText,
} from "@tedix/api-contract/utils/decision-card-copy";
import { readDraftPreferences } from "./decision-learning";
import type { DecisionLearningModel } from "@tedix/api-contract/schemas/decision-learning";
import { draftLearningContext } from "@tedix/api-contract/utils/decision-learning";
import { saveDecisionCardPresentation } from "@tedix/db/queries/work-items/card-presentation";

export function displayDeckCard(
	card: DeckCard,
	presentation: DeckCard["presentation"],
	unavailable = false,
): DeckCard {
	return {
		...card,
		presentation: presentation ?? null,
		label:
			presentation?.title ??
			(unavailable ? copySpec.unavailableTitle : copySpec.pendingTitle),
		faceText:
			!presentation && unavailable
				? copySpec.unavailableFace
				: decisionCardFaceText(presentation, card.decision?.confidence ?? null),
	};
}

export async function prepareDeckCardFaces(
	context: BaseContext,
	cards: DeckCard[],
	model?: DecisionLearningModel,
) {
	const unavailable = new Set<string>();
	const deferred = new Set<string>();
	const faces = await Promise.all(
		cards.map((card) =>
			prepareDeckCardFace(
				context,
				card,
				false,
				model,
				() => unavailable.add(card.id),
				() => deferred.add(card.id),
			),
		),
	);
	context.waitUntil?.(
		Promise.all(
			cards
				.filter((card, index) => !faces[index] && !deferred.has(card.id))
				.slice(0, 3)
				.map((card) => prepareDeckCardFace(context, card, true, model)),
		).catch(() => {}),
	);
	return cards.map((card, index) =>
		displayDeckCard(card, faces[index], unavailable.has(card.id)),
	);
}

/** Display-only source. Never send saved tool arguments or executable effects to the writer. */
export function deckCardWritingSource(card: DeckCard) {
	const request = card.interaction?.request;
	return {
		subject: request?.subject ?? card.label,
		prompt:
			(typeof request?.metadata.cardContent === "string"
				? request.metadata.cardContent
				: request?.prompt) ??
			(card.factory
				? `${card.factory.why}\nDraft: ${card.factory.draft}\nSource: ${card.factory.sourceText}`
				: card.workApproval
					? JSON.stringify({
							action: card.workApproval.proposal.action,
							rationale: card.workApproval.proposal.requestRationale,
							task: card.workApproval.workItem.title,
						})
					: card.runtimeApproval
						? JSON.stringify({
								description: card.runtimeApproval.description,
								question: card.runtimeApproval.review.operatorQuestion,
								summary: card.runtimeApproval.review.summary,
							})
						: copySpec.unknownConsequence),
		kind: card.kind,
		metadata: {
			sourceOptions: AttentionOfferedChoicesSchema.safeParse(request?.metadata)
				.data?.decisionCard?.options,
			producerContext: card.factory
				? copySpec.producerContext.factory
				: card.workApproval
					? copySpec.producerContext.workApproval
					: card.runtimeApproval
						? copySpec.producerContext.runtimeApproval
						: undefined,
			decisionClass: card.decision?.classId ?? card.kind,
			decisionDeck: card.decision
				? {
						...card.decision,
						options: card.decision.options.map(
							({ effect: _, ...option }) => option,
						),
					}
				: undefined,
		},
	};
}

/** Per-person display projection in the existing personalization store, guarded against duplicate model work. */
export async function prepareDeckCardFace(
	context: BaseContext,
	card: DeckCard,
	generate = true,
	model?: DecisionLearningModel,
	onUnavailable?: () => void,
	onDeferred?: () => void,
) {
	if (!context.userId) return null;
	const orgId = requireOrgId(context);
	const source = deckCardWritingSource(card);
	if (containsCardSecret(source)) {
		onUnavailable?.();
		onDeferred?.();
		return null;
	}
	const preferences = model
		? draftLearningContext(model, card.decision?.classId)
		: await readDraftPreferences(
				context.db,
				orgId,
				card.interaction?.request.requestedFromId ??
					context.descopeUserId ??
					null,
				card.decision?.classId,
			);
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(JSON.stringify({ source, copySpec, preferences })),
	);
	const fingerprint = [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
	const existing = DecisionCardPresentationSchema.safeParse(
		card.interaction?.request.metadata.cardPresentation,
	).data;
	if (
		existing?.version === 2 &&
		existing.sourceFingerprint === fingerprint &&
		existing.context &&
		!checkDecisionCardCopy(existing).length
	)
		return existing;
	const key = {
		userId: context.userId,
		namespace: "decision-card-face.v1",
		key: `${orgId}:${card.id}`,
	};
	const stored = await getUserConfig(context.db, key);
	if (stored?.value.fingerprint === fingerprint) {
		if (stored.value.failed) onUnavailable?.();
		const copy = DecisionCardPresentationSchema.safeParse(
			stored.value.presentation,
		).data;
		if (
			copy?.version === 2 &&
			copy.context &&
			!checkDecisionCardCopy(copy).length
		)
			return copy;
		if (
			typeof stored.value.retryAt === "number" &&
			stored.value.retryAt > Date.now()
		) {
			onDeferred?.();
			return null;
		}
	}
	if (!generate) return null;
	const claim = await putUserConfig(context.db, {
		...key,
		expectedRevision: stored?.revision ?? 0,
		value: { fingerprint, retryAt: Date.now() + 60000 },
	});
	if (!claim.ok) return null;
	const presentation = await generateDecisionCard(
		context,
		{
			...source,
			orgId,
			targetId:
				card.interaction?.request.requestedFromId ??
				context.descopeUserId ??
				null,
		},
		(reason) =>
			console.warn("[decision-card-face] generation failed", { reason }),
	);
	if (
		!presentation ||
		presentation.version !== 2 ||
		!presentation.context ||
		checkDecisionCardCopy(presentation).length
	) {
		onUnavailable?.();
		await putUserConfig(context.db, {
			...key,
			expectedRevision: claim.row.revision,
			value: { fingerprint, retryAt: Date.now() + 60000, failed: true },
		});
		return null;
	}
	if (card.interaction) {
		const request = card.interaction.request;
		const saved = await saveDecisionCardPresentation(context.db, {
			orgId,
			requestId: request.id,
			personId: request.requestedFromId,
			expectedVersion: request.version,
			presentation: { ...presentation, sourceFingerprint: fingerprint },
		});
		return saved?.presentation ?? null;
	}
	const saved = await putUserConfig(context.db, {
		...key,
		expectedRevision: claim.row.revision,
		value: toJsonRecord({ fingerprint, presentation }),
	});
	return saved.ok ? presentation : null;
}
