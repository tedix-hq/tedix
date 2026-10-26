import { safeExceptionTopology } from "../lib/safe-log-metadata";
import {
	listPersonalCardStyleRules,
	resolveCardStyleOwner,
} from "@tedix/db/queries/work-items/card-style-rules";
import type { DbClient } from "@tedix/db/client";
import { getDecisionLearningConfig } from "@tedix/db/queries/decision-learning";
import { listLearningInteractions } from "@tedix/db/queries/learning-feedback";
import { listApprovedAgentLessons } from "@tedix/db/queries/memory-graph/agent-lessons";
import {
	learnDecisions,
	draftLearningContext,
} from "@tedix/api-contract/utils/decision-learning";
import {
	AGENT_LESSON_TOPIC_PREFIX,
	LessonTriggersSchema,
} from "@tedix/api-contract/schemas/agent-session-lessons";

/** Caller must resolve the person from auth or the canonical artifact owner. */
export async function readDecisionLearning(
	db: DbClient,
	organizationId: string,
	personId: string | null,
	now = new Date(),
) {
	const config = await getDecisionLearningConfig(db, organizationId);
	if (!config.enabled)
		return learnDecisions({
			organizationId,
			personId,
			config,
			events: personId
				? await listLearningInteractions(db, {
						organizationId,
						personalScopeId: personId,
						surfaces: ["decision_deck_action", "decision_deck"],
						limit: config.historyLimit,
					})
				: [],
			now,
		});
	const [events, facts] = await Promise.all([
		listLearningInteractions(db, {
			organizationId,
			personalScopeId: personId,
			surfaces: [
				"decision_capture",
				"agent_session_import",
				"activity_feed",
				"focus_feed",
				"decision_deck",
				"decision_deck_action",
				"work_outcome",
				"outbound_outcome",
				"work_fix",
				"decision_learning",
				"decision_edit_preference",
				"card_context",
			],
			excludeFeedImpressions: true,
			limit: config.historyLimit,
		}),
		listApprovedAgentLessons(db, organizationId, AGENT_LESSON_TOPIC_PREFIX, {
			viewerUserId: personId,
			limit: 50,
		}),
	]);
	return learnDecisions({
		organizationId,
		personId,
		config,
		events,
		now,
		lessons: facts.map((f) => ({
			id: f.id,
			text: f.content.slice(0, 2000),
			triggers: LessonTriggersSchema.safeParse(
				typeof f.metadata?.learningFeed === "object" &&
					f.metadata.learningFeed &&
					!Array.isArray(f.metadata.learningFeed)
					? f.metadata.learningFeed.triggers
					: undefined,
			).data,
			classId:
				typeof f.metadata?.decisionClass === "string"
					? f.metadata.decisionClass
					: null,
		})),
	});
}
export async function readDraftPreferences(
	db: DbClient,
	organizationId: string,
	personId: string | null,
	classId?: string,
) {
	try {
		const owner = personId
			? await resolveCardStyleOwner(db, organizationId, personId)
			: null;
		const [model, rules] = await Promise.all([
			readDecisionLearning(db, organizationId, owner),
			owner ? listPersonalCardStyleRules(db, organizationId, owner) : [],
		]);
		const learned = draftLearningContext(model, classId);
		if (!rules.length) return learned;
		const context: {
			purpose?: string;
			preferences?: unknown[];
			lessons?: Array<{ id: string; text: string; classId: string | null }>;
		} = learned
			? JSON.parse(learned)
			: {
					purpose:
						"Personal writing preferences; style only. Preserve facts, recipients, consent and authority.",
					preferences: [],
					lessons: [],
				};
		context.lessons = [
			...(context.lessons ?? []),
			...rules
				.filter(
					(rule) => !context.lessons?.some((lesson) => lesson.id === rule.id),
				)
				.map((rule) => ({
					id: rule.id,
					text: rule.content,
					classId: null,
				})),
		];
		return JSON.stringify(context);
	} catch (error) {
		console.warn("[decision-learning] writing context unavailable", {
			exception: safeExceptionTopology(error),
		});
		return "";
	}
}
