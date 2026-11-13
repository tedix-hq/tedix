import copySpec from "@tedix/api-contract/assets/decision-card-copy.v2.json";
import { containsCardSecret } from "@tedix/api-contract/utils/card-secrets";
import { DecisionCardPresentationSchema } from "@tedix/api-contract/schemas/decision-card-presentation";
import type { DeckCard } from "@tedix/api-contract/schemas/attention";
import { AttentionOfferedChoicesSchema } from "@tedix/api-contract/schemas/attention";
import { getUserConfig, putUserConfig } from "@tedix/db/queries/user-configs";
import { toJsonRecord } from "@tedix/db/utils/json";
import type { BaseContext } from "../rpc/orpc";
import { requireOrgId } from "../rpc/org-scope";
import {
	decisionCardProducerContext,
	generateDecisionCard,
} from "./decision-card-generator";
import {
	decisionCardSubject,
	NEXT_STEP_BODY,
	nextStepCard,
	subjectIssues,
} from "./decision-card-subject";
import {
	checkDecisionCardCopy,
	decisionCardFaceText,
	decisionCardFallbackTitle,
	renderDecisionCardDates,
} from "@tedix/api-contract/utils/decision-card-copy";
import { readDraftPreferences } from "./decision-learning";
import type { DecisionLearningModel } from "@tedix/api-contract/schemas/decision-learning";
import { draftLearningContext } from "@tedix/api-contract/utils/decision-learning";
import { saveDecisionCardPresentation } from "@tedix/db/queries/work-items/card-presentation";
import { hasReviewTargetDeadline } from "@tedix/api-contract/utils/deck-ask";
import {
	bindCardPresentationSource,
	cardPresentationSourceFingerprint,
} from "./card-presentation-source";

const RETRY_DELAYS = [60000, 300000, 1800000] as const;

export function displayDeckCard(
	card: DeckCard,
	presentation: DeckCard["presentation"],
	unavailable = false,
): DeckCard {
	const rendered = presentation
		? renderDecisionCardDates(
				presentation,
				[card.dueAt, card.deadline].filter((date): date is string =>
					Boolean(date),
				),
			)
		: null;
	return {
		...card,
		presentation: presentation ?? null,
		label: rendered?.title ?? decisionCardFallbackTitle(card.label),
		faceText:
			!presentation && unavailable
				? copySpec.unavailableFace
				: decisionCardFaceText(rendered, card.decision?.confidence ?? null),
	};
}

export async function prepareDeckCardFaces(
	context: BaseContext,
	cards: DeckCard[],
	model?: DecisionLearningModel,
	retry = false,
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
				retry,
			),
		),
	);
	const missing = cards
		.map((card, index) => ({ card, index }))
		.filter(({ card, index }) => !faces[index] && !deferred.has(card.id))
		.slice(0, 3);
	const generation = Promise.all(
		missing.map(async ({ card, index }) => {
			const face = await prepareDeckCardFace(
				context,
				card,
				true,
				model,
				() => unavailable.add(card.id),
				undefined,
				retry,
			);
			if (!context.waitUntil) faces[index] = face;
		}),
	).catch(() => {});
	// RPC hosts without an execution context must finish the bounded work before returning.
	if (context.waitUntil) context.waitUntil(generation);
	else await generation;
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
			absoluteDates: { dueAt: card.dueAt, deadline: card.deadline },
			sourceOptions: AttentionOfferedChoicesSchema.safeParse(request?.metadata)
				.data?.decisionCard?.options,
			producerContext: card.factory
				? copySpec.producerContext.factory
				: card.workApproval
					? copySpec.producerContext.workApproval
					: card.runtimeApproval
						? copySpec.producerContext.runtimeApproval
						: decisionCardProducerContext(request?.metadata ?? {}),
			decisionClass: card.decision?.classId ?? card.kind,
			decisionDeck: card.decision
				? {
						...card.decision,
						options: card.decision.options.map(
							({ effect: _, ...option }) => option,
						),
					}
				: undefined,
			// Who is affected and whether a click performs the step shape the face.
			laneNudge: request?.metadata.laneNudge,
			cardSubject: request?.metadata.cardSubject,
		},
	};
}

/** A saved face that misnames who is affected, or promises a reminder's effect, is regenerated. */
function faceKeepsSubject(
	copy: {
		title: string;
		context?: string;
		body: string;
		recommendation: string;
	},
	source: ReturnType<typeof deckCardWritingSource>,
) {
	const step = nextStepCard(source);
	return (
		!subjectIssues(copy, decisionCardSubject(source)).length &&
		(!step || copy.body === NEXT_STEP_BODY[step])
	);
}

/** Per-person display projection in the existing personalization store, guarded against duplicate model work. */
export async function prepareDeckCardFace(
	context: BaseContext,
	card: DeckCard,
	generate = true,
	model?: DecisionLearningModel,
	onUnavailable?: () => void,
	onDeferred?: () => void,
	retry = false,
) {
	if (!context.userId) return null;
	const orgId = requireOrgId(context);
	const source = deckCardWritingSource(card);
	if (containsCardSecret(source)) {
		onUnavailable?.();
		onDeferred?.();
		return null;
	}
	const existing = DecisionCardPresentationSchema.safeParse(
		card.interaction?.request.metadata.cardPresentation,
	).data;
	const demoEnv = context.env as CloudflareEnv & {
		TEDIX_LOCAL_DEMO_ENABLED?: string;
		TEDIX_DEMO_SENDING_OFF?: string;
	};
	// Offline sample cards already carry authored copy; never invoke a model to rewrite it.
	if (
		demoEnv?.ENVIRONMENT === "development" &&
		demoEnv.TEDIX_LOCAL_DEMO_ENABLED === "true" &&
		demoEnv.TEDIX_DEMO_SENDING_OFF === "true" &&
		card.interaction?.request.metadata.sampleData === true
	)
		return existing ?? null;
	const request = card.interaction?.request;
	const currentDeadline =
		!request ||
		!hasReviewTargetDeadline(request.metadata) ||
		(existing?.version === 2 &&
			existing.sourceFingerprint ===
				(await cardPresentationSourceFingerprint(request)));
	// Interaction projections are fenced by request version in listDecisionCardPresentations.
	// Changing writing preferences must not hide already-saved copy on every read.
	if (
		existing?.version === 2 &&
		currentDeadline &&
		existing.context &&
		!checkDecisionCardCopy(existing).length &&
		faceKeepsSubject(existing, source)
	)
		return existing;
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
	const key = {
		userId: context.userId,
		namespace: "decision-card-face.v1",
		key: `${orgId}:${card.id}`,
	};
	const stored = await getUserConfig(context.db, key);
	const sameSource = stored?.value.fingerprint === fingerprint;
	const previousAttempts =
		sameSource && typeof stored.value.attempts === "number"
			? stored.value.attempts
			: sameSource && stored.value.failed
				? 1
				: 0;
	// A user retry resets failed work, but never steals an in-flight claim.
	const manualRetry = retry && sameSource && stored.value.failed === true;
	if (stored?.value.fingerprint === fingerprint) {
		if (stored.value.failed) onUnavailable?.();
		const copy = DecisionCardPresentationSchema.safeParse(
			stored.value.presentation,
		).data;
		if (
			copy?.version === 2 &&
			copy.context &&
			!checkDecisionCardCopy(copy).length &&
			faceKeepsSubject(copy, source)
		)
			return copy;
		if (
			!manualRetry &&
			(previousAttempts > RETRY_DELAYS.length ||
				(typeof stored.value.retryAt === "number" &&
					stored.value.retryAt > Date.now()))
		) {
			onDeferred?.();
			return null;
		}
	}
	if (!generate) return null;
	const attempts = (manualRetry ? 0 : previousAttempts) + 1;
	const claim = await putUserConfig(context.db, {
		...key,
		expectedRevision: stored?.revision ?? 0,
		value: { fingerprint, attempts, retryAt: Date.now() + 60000 },
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
		{ timeoutMs: 20000, requireContext: true },
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
			value: {
				fingerprint,
				attempts,
				retryAt: RETRY_DELAYS[attempts - 1]
					? Date.now() + RETRY_DELAYS[attempts - 1]!
					: 0,
				failed: true,
			},
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
			presentation: await bindCardPresentationSource(presentation, request),
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
