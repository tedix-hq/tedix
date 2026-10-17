import type { LedgerLesson } from "@tedix/context-core/request-ledger";
import type { DbClient } from "@tedix/db/client";
import {
	proposeLearningImprovement,
	recordLearningInteraction,
} from "@tedix/db/queries/learning-feedback";
import { observedLearningEventId } from "./learning-interaction-recorder";

/** Private source evidence stays personal until a reviewer promotes the candidate. */
export async function recordLedgerLessonCandidates(
	db: DbClient,
	lessons: LedgerLesson[],
	scope: {
		organizationId: string;
		ownerUserId: string;
		repository: string | null;
		harness: string;
		sessionKey: string;
		sourceAt: string;
	},
): Promise<void> {
	for (const lesson of lessons) {
		const key = await observedLearningEventId(
			"session-lesson",
			scope.organizationId,
			scope.ownerUserId,
			scope.repository,
			lesson.rule
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, " ")
				.trim(),
		);
		const { event } = await recordLearningInteraction(db, {
			organizationId: scope.organizationId,
			actorType: "service",
			actorId: "session-request-ledger",
			clientEventId: key,
			eventKind: "retried",
			scopeKind: "personal",
			scopeId: scope.ownerUserId,
			issueKey: key,
			surface: "agent_session_recovery",
			targetType: "lesson",
			targetId: key,
			metadata: {
				rule: lesson.rule,
				failure: lesson.failure,
				fix: lesson.fix,
				repository: scope.repository,
				harness: scope.harness,
				sessionKey: scope.sessionKey,
			},
			occurredAt: scope.sourceAt,
		});
		// Reuse the first evidence and wording on retries and later-session repeats.
		await proposeLearningImprovement(db, {
			organizationId: scope.organizationId,
			clientProposalId: key,
			tediId: null,
			scopeKind: "personal",
			scopeId: scope.ownerUserId,
			issueKey: key,
			subjectKind: "memory_fact",
			subjectId: key,
			recommendation: String(event.metadata?.rule ?? lesson.rule),
			evidenceEventIds: [event.id],
			proposedByType: "service",
			proposedById: "session-request-ledger",
		});
	}
}
