/**
 * Historic import of a person's own past local agent sessions → learning
 * ledger (`import_agent_session_decisions`).
 *
 * The CLI extracts and redacts (agent message tail, user reply) pairs on the
 * person's machine; this records each as one `answered` learning event on
 * surface `agent_session_import`, personal to the caller, in the same metadata
 * shape decision capture writes, so the reflection miner
 * (`learning-feed-miner.ts`) learns from both alike. Idempotent by
 * (harness, sessionId, turnId), and a reply decision capture already recorded
 * live is a duplicate, not a second piece of evidence.
 */

import type {
	AgentSessionDecision,
	ImportAgentSessionDecisionsResult,
} from "@tedix/api-contract/schemas/agent-session-decisions";
import type { DbClient } from "@tedix/db/client";
import {
	listLearningEventTimesInThreads,
	recordLearningInteractionsBatch,
} from "@tedix/db/queries/learning-feedback";
import { toJsonRecord } from "@tedix/db/utils/json";
import {
	DECISION_CAPTURE_LEARNING_SURFACE,
	learningScopeSlug,
} from "./decision-learning-signal";
import { observedLearningEventId } from "./learning-interaction-recorder";

/** `learning_interaction_events.surface` of an imported historic session decision. */
export const AGENT_SESSION_IMPORT_LEARNING_SURFACE = "agent_session_import";
/**
 * Scope repo slug of a session outside any repository: the learning feed's
 * "any" slug, so a preference learned there reaches every session.
 */
export const NO_REPOSITORY_SLUG = "general";
/**
 * Live capture records a reply when the hook answers, seconds after the
 * transcript's timestamp; within this window, in the same chat, it is the
 * same reply.
 */
const LIVE_CAPTURE_MATCH_MS = 120_000;

export async function agentSessionDecisionRows(input: {
	organizationId: string;
	userId: string;
	decisions: AgentSessionDecision[];
}) {
	return Promise.all(
		input.decisions.map(async (decision) => {
			const repo = decision.repository
				? learningScopeSlug(decision.repository)
				: NO_REPOSITORY_SLUG;
			const harness = learningScopeSlug(decision.harness);
			const topic = learningScopeSlug(decision.topic);
			return {
				organizationId: input.organizationId,
				actorType: "user" as const,
				actorId: input.userId,
				tediId: null,
				clientEventId: await observedLearningEventId(
					"agent-session-import",
					decision.harness,
					decision.sessionId,
					decision.turnId,
				),
				eventKind: "answered" as const,
				scopeKind: "personal" as const,
				scopeId: input.userId,
				issueKey: `decision:${repo}:${harness}:${topic}`,
				surface: AGENT_SESSION_IMPORT_LEARNING_SURFACE,
				targetType: "agent_session_turn",
				targetId: decision.turnId,
				threadId: decision.sessionId,
				runId: null,
				occurredAt: decision.occurredAt,
				metadata: toJsonRecord({
					schema: "tedix.learning-feed.decision.v1",
					source: "historic-import",
					scope: { repo, harness, topic },
					branch: decision.branch ?? null,
					question: { subject: "", tail: decision.agentMessage },
					answer: decision.reply,
					answerSource: "historic-import",
					replyClass: null,
					draft: null,
				}),
			};
		}),
	);
}

export async function importAgentSessionDecisions(
	db: DbClient,
	input: {
		organizationId: string;
		userId: string;
		decisions: AgentSessionDecision[];
	},
): Promise<ImportAgentSessionDecisionsResult> {
	const rows = await agentSessionDecisionRows(input);
	// A batch may repeat a turn (a forked session replays its parent): keep one.
	const unique = [
		...new Map(rows.map((row) => [row.clientEventId, row])).values(),
	];
	const live = await capturedLive(db, input, unique);
	const { recorded } = await recordLearningInteractionsBatch(
		db,
		unique.filter((row) => !live.has(row)),
	);
	return {
		received: input.decisions.length,
		recorded,
		duplicates: input.decisions.length - recorded,
	};
}

/**
 * The rows decision capture already recorded live: each pairs with at most one
 * live reply in the same chat, the nearest within `LIVE_CAPTURE_MATCH_MS`.
 */
async function capturedLive<
	Row extends { threadId: string; occurredAt: string },
>(
	db: DbClient,
	input: { organizationId: string; userId: string },
	rows: Row[],
): Promise<Set<Row>> {
	if (rows.length === 0) return new Set();
	const times = rows.map((row) => Date.parse(row.occurredAt));
	const live = await listLearningEventTimesInThreads(db, {
		organizationId: input.organizationId,
		actorId: input.userId,
		surface: DECISION_CAPTURE_LEARNING_SURFACE,
		threadIds: [...new Set(rows.map((row) => row.threadId.toLowerCase()))],
		from: new Date(Math.min(...times) - LIVE_CAPTURE_MATCH_MS).toISOString(),
		to: new Date(Math.max(...times) + LIVE_CAPTURE_MATCH_MS).toISOString(),
	});
	const unused = live.map((event) => ({
		threadId: event.threadId,
		at: Date.parse(event.occurredAt),
	}));
	const matched = new Set<Row>();
	rows.forEach((row, index) => {
		let best = -1;
		for (let i = 0; i < unused.length; i++) {
			const event = unused[i]!;
			const gap = Math.abs(event.at - times[index]!);
			if (
				event.threadId === row.threadId.toLowerCase() &&
				gap <= LIVE_CAPTURE_MATCH_MS &&
				(best < 0 || gap < Math.abs(unused[best]!.at - times[index]!))
			)
				best = i;
		}
		if (best < 0) return;
		unused.splice(best, 1);
		matched.add(row);
	});
	return matched;
}
