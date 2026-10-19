import policy from "@tedix/api-contract/assets/card-context.v1.json";
import {
	canAskCardContext,
	nextContextSample,
	type ContextChip,
} from "@tedix/api-contract/utils/card-context";
import type { DeckCard } from "@tedix/api-contract/schemas/attention";
import { DecisionCardPresentationSchema } from "@tedix/api-contract/schemas/decision-card-presentation";
import { getUserConfig, putUserConfig } from "@tedix/db/queries/user-configs";
import {
	recordLearningInteraction,
	listLearningInteractions,
} from "@tedix/db/queries/learning-feedback";
import { getOrCreateDomain } from "@tedix/db/queries/memory-graph/domains";
import {
	createFact,
	findCurrentFactsByTopicKey,
} from "@tedix/db/queries/memory-graph/facts";
import {
	decisionLessonEvidence,
	listArchivedLearningFeedLessons,
} from "@tedix/db/queries/memory-graph/agent-lessons";
import { toJsonRecord } from "@tedix/db/utils/json";
import {
	buildBrainWriteQualityEnvelope,
	mergeBrainWriteMetadata,
} from "./brain-write-quality";
import { requireOrgId } from "../rpc/org-scope";
import { createError, ErrorCodes, type BaseContext } from "../rpc/orpc";

function samplingKey(context: BaseContext) {
	if (!context.userId)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"A person is required for context feedback",
		);
	return {
		userId: context.userId,
		namespace: "card-context.v1",
		key: requireOrgId(context),
	};
}
function samplingState(value?: Record<string, unknown>) {
	return {
		count: typeof value?.count === "number" ? value.count : 0,
		seen: Array.isArray(value?.seen)
			? value.seen.filter((v): v is string => typeof v === "string")
			: [],
		sampled: Object.fromEntries(
			Object.entries(
				value?.sampled && typeof value.sampled === "object"
					? value.sampled
					: {},
			).filter(
				(entry): entry is [string, string] => typeof entry[1] === "string",
			),
		),
		answered: Array.isArray(value?.answered)
			? value.answered.filter((v): v is string => typeof v === "string")
			: [],
		presentations: toJsonRecord(value?.presentations ?? {}),
	};
}

/** Called for the selected, recipient-fenced card only. A failed CAS never offers a prompt. */
export async function sampleCardContext(
	context: BaseContext,
	card: DeckCard,
	enabled: boolean,
) {
	if (!context.userId || !enabled) return false;
	const key = samplingKey(context);
	for (let retry = 0; retry < 3; retry++) {
		const row = await getUserConfig(context.db, key);
		const state = samplingState(row?.value);
		const next = nextContextSample(state, card);
		if (next === state)
			return (
				canAskCardContext(card) &&
				Object.hasOwn(state.sampled, card.id) &&
				!state.answered.includes(card.id)
			);
		// Keep this small personalization row bounded; exhaustion withholds prompts.
		if (next.seen.length > policy.trackedCardLimit) return false;
		const copy = DecisionCardPresentationSchema.safeParse(
			card.interaction?.request.metadata.cardPresentation,
		).data;
		const presentations = { ...state.presentations };
		if (
			Object.hasOwn(next.sampled, card.id) &&
			copy?.version === 2 &&
			copy.sourceFingerprint
		)
			presentations[card.id] = {
				sourceFingerprint: copy.sourceFingerprint,
				generatedAt: copy.generatedAt ?? null,
				sourceVersion: card.interaction?.request.version ?? null,
			};
		if (
			(
				await putUserConfig(context.db, {
					...key,
					expectedRevision: row?.revision ?? 0,
					value: { ...next, presentations },
				})
			).ok
		)
			return Object.hasOwn(next.sampled, card.id);
	}
	return false;
}

export async function recordCardContext(
	context: BaseContext,
	actorId: string,
	input: {
		cardId: string;
		clientEventId: string;
		enough: boolean;
		chip?: ContextChip;
	},
) {
	const orgId = requireOrgId(context);
	const row = await getUserConfig(context.db, samplingKey(context));
	const state = samplingState(row?.value);
	const sampled = state.sampled;
	const classId = sampled[input.cardId];
	if (
		!Object.hasOwn(sampled, input.cardId) ||
		!classId ||
		(input.enough && input.chip)
	)
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"This card has no context question for you",
		);
	const answer = input.enough
		? "Enough context to decide"
		: input.chip
			? `Needs context: ${policy.chips[input.chip].label}`
			: "Not enough context to decide";
	await recordLearningInteraction(context.db, {
		organizationId: orgId,
		actorId,
		actorType: "user",
		clientEventId: input.clientEventId,
		eventKind: input.enough ? "accepted" : "rejected",
		scopeKind: "personal",
		scopeId: actorId,
		surface: "card_context",
		targetType: "decision",
		targetId: input.cardId,
		issueKey: `card-context:${classId}`,
		metadata: {
			decisionClass: classId,
			enough: input.enough,
			chip: input.chip ?? null,
			answer,
			presentation: state.presentations[input.cardId] ?? null,
		},
		occurredAt: new Date().toISOString(),
	});
	// Keep the sampled class for an optional chip after a thumbs-down, but do not ask again.
	for (let retry = 0; retry < 3; retry++) {
		const current = await getUserConfig(context.db, samplingKey(context));
		const state = samplingState(current?.value);
		if (state.answered.includes(input.cardId)) break;
		if (
			(
				await putUserConfig(context.db, {
					...samplingKey(context),
					expectedRevision: current?.revision ?? 0,
					value: { ...state, answered: [...state.answered, input.cardId] },
				})
			).ok
		)
			break;
	}
	if (input.chip) {
		const learning = learnCardContext(
			context,
			actorId,
			classId,
			input.chip,
		).catch(() => {});
		if (context.waitUntil) context.waitUntil(learning);
		else await learning;
	}
	return { saved: true as const };
}

async function learnCardContext(
	context: BaseContext,
	actorId: string,
	classId: string,
	chip: ContextChip,
) {
	const organizationId = requireOrgId(context);
	const events = await listLearningInteractions(context.db, {
		organizationId,
		personalScopeId: actorId,
		surfaces: ["card_context"],
		limit: 500,
	});
	const examples = [
		...new Map(
			events
				.filter(
					(event) =>
						event.actorType === "user" &&
						event.actorId === actorId &&
						event.metadata?.decisionClass === classId &&
						event.metadata?.chip === chip &&
						event.metadata?.enough === false,
				)
				.map((event) => [event.targetId, event]),
		).values(),
	];
	if (examples.length < policy.minimumExamples) return;
	const topicKey = `learning-feed:card-context:${classId}:${chip}:user:${actorId}`;
	const [current, archived] = await Promise.all([
		findCurrentFactsByTopicKey(context.db, organizationId, topicKey),
		listArchivedLearningFeedLessons(context.db, organizationId, [topicKey]),
	]);
	// Respect edits, rejection and removal in Brain; repeated clicks cannot recreate a rule.
	if (current.length || archived.length) return;
	const ruleKey = {
		userId: context.userId!,
		namespace: "card-context-rule.v1",
		key: `${organizationId}:${classId}:${chip}`,
	};
	const rule = await getUserConfig(context.db, ruleKey);
	if (
		rule?.value.done === true ||
		(typeof rule?.value.retryAt === "number" && rule.value.retryAt > Date.now())
	)
		return;
	const claim = await putUserConfig(context.db, {
		...ruleKey,
		expectedRevision: rule?.revision ?? 0,
		value: { retryAt: Date.now() + 60000 },
	});
	if (!claim.ok) return;
	const evidence = await decisionLessonEvidence(
		context.db,
		organizationId,
		examples.map((event) => event.id),
	);
	if (evidence.state !== "live") return;
	const content = `For ${classId.replaceAll(/[._:-]/g, " ")} cards: ${policy.chips[chip].rule}`;
	const source = `learning-feed:card-context:${organizationId}:${examples[0]!.id}`;
	const sourceHash = `card-context-v1:${organizationId}:${actorId}:${classId}:${chip}`;
	const metadata = {
		producer: "card-context",
		sourceKind: "source-backed",
		expectedUse:
			"Apply this personal writing preference to this kind of decision card; facts and permissions stay unchanged",
		confidenceReason: "Repeated explicit context feedback on distinct cards",
		decisionClass: classId,
		learningFeed: {
			version: 1,
			ownerUserId: actorId,
			autoConfirmed: true,
			evidenceEventIds: examples.map((event) => event.id),
			evidence,
			scope: { repo: "general", harness: "general", topic: classId },
			triggers: { keywords: [classId] },
		},
	};
	const quality = buildBrainWriteQualityEnvelope({
		content,
		domain: "operations",
		confidence: 0.8,
		priority: "active",
		source,
		sourceHash,
		metadata,
	});
	const domain = await getOrCreateDomain(
		context.db,
		organizationId,
		"operations",
	);
	await createFact(context.db, {
		id: crypto.randomUUID(),
		organizationId,
		domainId: domain.id,
		tediId: null,
		content,
		summary: content.slice(0, 100),
		factType: "preference",
		confidence: quality.confidenceApplied,
		priority: quality.priorityApplied,
		status: "active",
		reviewStatus: "confirmed",
		usePolicy: "requires_user_confirmation",
		memoryScope: "org",
		visibility: "private",
		topicKey,
		source,
		sourceHash,
		metadata: toJsonRecord(mergeBrainWriteMetadata(metadata, quality)),
	});
	await putUserConfig(context.db, {
		...ruleKey,
		expectedRevision: claim.row.revision,
		value: { done: true },
	});
}
