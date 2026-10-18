import type { SessionFeedbackCandidate } from "@tedix/api-contract/schemas/agent-session-feedback";
import { LessonEvidenceSchema } from "@tedix/api-contract/schemas/agent-session-lessons";
import type { DbClient } from "@tedix/db/client";
import {
	getLearningInteractionsByIds,
	recordLearningInteraction,
} from "@tedix/db/queries/learning-feedback";
import {
	listCurrentLearningFeedLessons,
	listApprovedAgentLessons,
} from "@tedix/db/queries/memory-graph/agent-lessons";
import { insertSessionFeedbackLesson } from "@tedix/db/queries/memory-graph/session-feedback";
import { observedLearningEventId } from "./learning-interaction-recorder";
import { holdLessonsForCorrection } from "./lesson-evidence";
import type { LessonNoveltyModel } from "./request-ledger-lessons";

function feedbackKey(text: string): string {
	return text
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

export async function recordSessionFeedback(
	db: DbClient,
	scope: {
		organizationId: string;
		ownerUserId: string;
	},
	candidates: SessionFeedbackCandidate[],
	novelty: LessonNoveltyModel,
) {
	const existing = await listCurrentLearningFeedLessons(
		db,
		scope.organizationId,
		"learning-feed:",
		500,
		scope.ownerUserId,
	);
	const approved = await listApprovedAgentLessons(
		db,
		scope.organizationId,
		"learning-feed:",
		{ viewerUserId: scope.ownerUserId },
	);
	const repository = candidates[0]?.repository ?? "general";
	const normalizeRepo = (value: string) =>
		value
			.trim()
			.toLowerCase()
			.replace(/^[a-z+]+:\/\//, "")
			.replace(/^[^@/]+@([^:/]+):/, "$1/")
			.replace(/^[^@/]+@/, "")
			.replace(/[?#].*$/, "")
			.replace(/\.git$/, "")
			.replace(/\/+$/, "");
	const comparison = [
		...new Map([...existing, ...approved].map((row) => [row.id, row])).values(),
	].filter((row) => {
		const feed = row.metadata?.learningFeed;
		const stored =
			feed && typeof feed === "object" && !Array.isArray(feed)
				? feed.scope
				: undefined;
		const repo =
			stored && typeof stored === "object" && !Array.isArray(stored)
				? stored.repo
				: undefined;
		return (
			typeof repo !== "string" ||
			repo === "general" ||
			normalizeRepo(repo) === normalizeRepo(repository) ||
			normalizeRepo(repository).endsWith(`/${normalizeRepo(repo)}`) ||
			normalizeRepo(repo).endsWith(`/${normalizeRepo(repository)}`)
		);
	});
	const lessons: Array<{
		id: string;
		text: string;
		status: "confirmed" | "pending" | "duplicate";
	}> = [];
	const sourceEvents = candidates.some((c) => c.sourceFile && c.sourceHash)
		? await getLearningInteractionsByIds(
				db,
				scope.organizationId,
				comparison.flatMap((row) => {
					const feed = row.metadata?.learningFeed;
					const evidence = LessonEvidenceSchema.safeParse(
						feed && typeof feed === "object" && !Array.isArray(feed)
							? feed.evidence
							: undefined,
					);
					return evidence.success
						? evidence.data.sources
								.filter((source) => source.kind === "correction")
								.map((source) => source.id)
						: [];
				}),
			)
		: [];
	const sourceMatch = (candidate: SessionFeedbackCandidate) => {
		if (!candidate.sourceFile || !candidate.sourceHash) return undefined;
		const event = sourceEvents.find(
			(event) =>
				event.actorType === "user" &&
				event.actorId === scope.ownerUserId &&
				event.surface === "agent_session_feedback" &&
				event.metadata?.sourceFile === candidate.sourceFile &&
				event.metadata?.sourceHash === candidate.sourceHash &&
				comparison.some((row) => row.id === event.targetId),
		);
		return event
			? comparison.find((row) => row.id === event.targetId)
			: undefined;
	};
	const pending = candidates.filter(
		(candidate) =>
			!sourceMatch(candidate) &&
			!comparison.some(
				(row) => feedbackKey(row.content) === feedbackKey(candidate.text),
			),
	);
	let novel: number[] = [];
	if (pending.length) {
		const raw = await novelty(
			JSON.stringify({
				existing: comparison.map((row) => row.content),
				candidates: pending.map((candidate, index) => ({
					index,
					rule: candidate.text,
				})),
			}),
		);
		const result: unknown = JSON.parse(raw ?? "null");
		if (
			!result ||
			typeof result !== "object" ||
			!("novel" in result) ||
			!Array.isArray(result.novel) ||
			result.novel.some(
				(i) => !Number.isInteger(i) || i < 0 || i >= pending.length,
			)
		)
			throw new Error("Feedback comparison unavailable");
		novel = result.novel;
	}
	for (const candidate of candidates) {
		const quote = candidate.quote.replace(/\s+/g, " ").trim();
		const repo = normalizeRepo(candidate.repository ?? "general");
		const exact =
			sourceMatch(candidate) ??
			comparison.find(
				(row) => feedbackKey(row.content) === feedbackKey(candidate.text),
			);
		if (exact) {
			lessons.push({ id: exact.id, text: exact.content, status: "duplicate" });
			continue;
		}
		if (!novel.includes(pending.indexOf(candidate))) continue;
		const identity = await observedLearningEventId(
			"session-feedback",
			scope.organizationId,
			scope.ownerUserId,
			repo,
			candidate.sourceFile && candidate.sourceHash
				? `${candidate.sourceFile}:${candidate.sourceHash}`
				: feedbackKey(candidate.text),
		);
		const hex = identity.split(":")[1]!;
		// A deterministic primary key fences concurrent hooks and retries atomically.
		const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
		const { event } = await recordLearningInteraction(db, {
			organizationId: scope.organizationId,
			actorType: "user",
			actorId: scope.ownerUserId,
			clientEventId: identity,
			eventKind: "edited",
			scopeKind: "personal",
			scopeId: scope.ownerUserId,
			surface: "agent_session_feedback",
			targetType: "session_feedback",
			targetId: id,
			threadId: candidate.sessionKey,
			occurredAt: candidate.occurredAt,
			metadata: {
				answer: quote,
				scope: { repo },
				candidate: candidate.text,
				sessionKey: candidate.sessionKey,
				harness: candidate.harness,
				repository: repo,
				projectId: candidate.projectId ?? null,
				sourceFile: candidate.sourceFile ?? null,
				sourceHash: candidate.sourceHash ?? null,
			},
		});
		if (!candidate.sourceFile && candidate.kind !== "project")
			await holdLessonsForCorrection(db, event);
		// The owner's feedback auto-confirms; project notes remain candidates.
		const confirmed = candidate.kind !== "project";
		// A concurrent import may already have recorded the first extraction.
		const savedText =
			typeof event.metadata?.candidate === "string"
				? event.metadata.candidate
				: candidate.text;
		const savedQuote =
			typeof event.metadata?.answer === "string"
				? event.metadata.answer
				: quote;
		const now = new Date().toISOString();
		const row = await insertSessionFeedbackLesson(db, {
			id,
			organizationId: scope.organizationId,
			content: savedText,
			factType: candidate.kind === "project" ? "technical" : "preference",
			confidence: confirmed ? 1 : 0.8,
			status: "active",
			reviewStatus: confirmed ? "confirmed" : "pending",
			usePolicy: confirmed
				? "can_use_as_instruction"
				: "requires_user_confirmation",
			memoryScope: "org",
			visibility: "private",
			priority: "active",
			topicKey: `learning-feed:feedback:${scope.ownerUserId}:${hex}`,
			source: candidate.sourceFile
				? `file://${candidate.sourceFile}`
				: `conversation://${candidate.sessionKey}`,
			sourceSessionId: candidate.sessionKey,
			createdAt: now,
			updatedAt: now,
			metadata: {
				learningFeed: {
					ownerUserId: scope.ownerUserId,
					producer: "session-feedback",
					scope: { repo, harness: "general", topic: "general" },
					projectId: candidate.projectId ?? null,
					sourceHarness: candidate.harness,
					lastEventAt: candidate.occurredAt,
					evidence: {
						version: 1,
						sources: [{ kind: "correction", id: event.id, quote: savedQuote }],
						supportCount: 1,
						state: "live",
					},
				},
			},
		});
		comparison.push({
			id: row.id,
			content: row.content,
			topicKey: row.topicKey,
			metadata: row.metadata,
			reviewStatus: row.reviewStatus,
		});
		if (candidate.sourceFile && candidate.sourceHash) sourceEvents.push(event);
		lessons.push({
			id: row.id,
			text: row.content,
			status: row.reviewStatus === "confirmed" ? "confirmed" : "pending",
		});
	}
	return { lessons };
}
