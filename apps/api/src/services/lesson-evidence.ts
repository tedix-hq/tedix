import type { DbClient } from "@tedix/db/client";
import {
	holdLessonForRedistillation,
	listCurrentLearningFeedLessons,
} from "@tedix/db/queries/memory-graph/agent-lessons";
import type { LearningInteractionEventRow } from "@tedix/db/schema/learning-feedback";
import { words } from "./lesson-distiller";

/** An overlapping correction holds a rule until distillation resolves its meaning. */
export async function holdLessonsForCorrection(
	db: DbClient,
	event: LearningInteractionEventRow,
): Promise<void> {
	if (
		event.scopeKind !== "personal" ||
		event.actorType !== "user" ||
		event.actorId !== event.scopeId
	)
		return;
	const meta = event.metadata;
	if (
		!["edited", "manually_replaced"].includes(event.eventKind) &&
		!["correction", "challenge", "frustration"].includes(
			String(meta?.replyClass),
		)
	)
		return;
	const answer = meta?.answer;
	if (typeof answer !== "string") return;
	const correctionWords = new Set(words(answer));
	if (correctionWords.size < 2) return;
	const rows = await listCurrentLearningFeedLessons(
		db,
		event.organizationId,
		"learning-feed:",
		500,
		event.scopeId,
	);
	const scope = meta?.scope;
	const repo =
		scope && typeof scope === "object" && !Array.isArray(scope)
			? scope.repo
			: undefined;
	for (const row of rows) {
		const feed = row.metadata?.learningFeed;
		if (!feed || typeof feed !== "object" || Array.isArray(feed)) continue;
		if (
			typeof feed.lastEventAt === "string" &&
			feed.lastEventAt >= event.occurredAt
		)
			continue;
		const lessonScope = feed.scope;
		const lessonRepo =
			lessonScope &&
			typeof lessonScope === "object" &&
			!Array.isArray(lessonScope)
				? lessonScope.repo
				: undefined;
		if (
			repo &&
			repo !== "general" &&
			lessonRepo &&
			lessonRepo !== "general" &&
			repo !== lessonRepo
		)
			continue;
		if (
			new Set(words(row.content).filter((w) => correctionWords.has(w))).size >=
			2
		)
			await holdLessonForRedistillation(
				db,
				event.organizationId,
				row.id,
				row.metadata,
			);
	}
}
