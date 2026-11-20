/**
 * When an agent run a tedi started ends, the tedi keeps one short lesson in
 * its Tedix memory: what was asked, how it ended and what the run said about
 * it. It is written through `memoryGraph.learn`, the path a tedi's own
 * memory writes take, so recall finds it when the tedi briefs its next run.
 */

import { createRouterClient } from "@orpc/server";
import { containsCardSecret } from "@tedix/api-contract/utils/card-secrets";
import { AGENT_RUN_SOURCE } from "@tedix/db/queries/work-items/agent-runs";
import { getTediByIdForOrganization } from "@tedix/db/queries/tedis";
import type { WorkAttempt, WorkItem } from "@tedix/db/schema/work-items";
import { safeExceptionTopology } from "../lib/safe-log-metadata";
import {
	deliverMemoryReflection,
	memoryReflectionEnabled,
	reflectionText,
} from "./tedi-memory-reflection";
import type { BaseContext } from "../rpc/orpc";
import { buildInternalServiceBindingContext } from "../rpc/routers/kernel/runtime-shared";

const TITLE_LIMIT = 160;
const NOTE_LIMIT = 280;
/** The whole entry stays under this many characters. */
export const OUTCOME_LESSON_LIMIT = 700;

type LessonWork = Pick<
	WorkItem,
	| "id"
	| "orgId"
	| "title"
	| "executorId"
	| "stewardType"
	| "stewardId"
	| "metadata"
>;
type LessonAttempt = Pick<
	WorkAttempt,
	| "id"
	| "executorType"
	| "outcome"
	| "summary"
	| "attemptNumber"
	| "startedAt"
	| "finishedAt"
	| "metadata"
>;

export interface AgentRunOutcomeLesson {
	tediId: string;
	summary: string;
	content: string;
	source: string;
	topicKey: string;
	metadata: Record<string, string | number>;
}

function oneLine(text: string, limit: number) {
	const clean = text.replace(/\s+/g, " ").trim();
	return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

/**
 * The run's own closing note, shortened to one line. Code blocks are dropped
 * because they hold command output or file contents, and a note that looks
 * like it carries a credential is left out whole.
 */
function settlementNote(summary: string | null): string {
	if (!summary || containsCardSecret(summary)) return "";
	return oneLine(
		summary
			.replace(/```[\s\S]*?(?:```|$)/g, " ")
			.replace(/^\s*(?:Result|Failed):\s*/i, ""),
		NOTE_LIMIT,
	);
}

/**
 * The lesson for the tedi that started this run, or null when the Work Item
 * is not an agent run a tedi started or the Attempt has not ended.
 */
export function agentRunOutcomeLesson(
	work: LessonWork,
	attempt: LessonAttempt,
): AgentRunOutcomeLesson | null {
	if (work.stewardType !== "tedi" || !work.stewardId) return null;
	if (work.metadata?.source !== AGENT_RUN_SOURCE) return null;
	if (attempt.executorType !== "external_agent" || !attempt.outcome)
		return null;
	const executor = work.executorId ?? "an agent";
	const title = oneLine(work.title, TITLE_LIMIT);
	const minutes = attempt.finishedAt
		? Math.max(
				0,
				Math.round(
					(Date.parse(attempt.finishedAt) - Date.parse(attempt.startedAt)) /
						60_000,
				),
			)
		: null;
	const declared = (
		attempt.metadata?.laneResult as { commitSha?: unknown } | undefined
	)?.commitSha;
	const commit =
		typeof declared === "string" && /^[a-f0-9]{40}$/.test(declared)
			? declared
			: null;
	const note = settlementNote(attempt.summary);
	const worked = attempt.outcome === "succeeded";
	const content = [
		`Agent run I started: asked ${executor} to "${title}".`,
		`Outcome: ${attempt.outcome}${minutes === null ? "" : ` after ${minutes} min`} (run ${attempt.attemptNumber}).`,
		commit ? `Commit the run declared: ${commit}.` : "",
		note
			? `${worked ? "What the run reported" : "What went wrong, as the run reported it"}: ${note}`
			: "",
		`Task: /work/items/${work.id}`,
	]
		.filter(Boolean)
		.join(" ")
		.slice(0, OUTCOME_LESSON_LIMIT);
	return {
		tediId: work.stewardId,
		summary: oneLine(`Agent run ${attempt.outcome}: ${title}`, 200),
		content,
		source: `work-attempt://${attempt.id}/outcome`,
		topicKey: `agent-run-outcome:${attempt.id}`,
		metadata: {
			producer: "agent-run-outcome",
			workItemId: work.id,
			attemptId: attempt.id,
			outcome: attempt.outcome,
			executor,
		},
	};
}

type Learn = (
	context: BaseContext,
	lesson: AgentRunOutcomeLesson,
) => Promise<unknown>;

const learnThroughMemoryGraph: Learn = async (context, lesson) => {
	const { memoryGraphContractRouter } =
		await import("../rpc/routers/memory-graph");
	return createRouterClient(memoryGraphContractRouter, { context }).learn({
		content: lesson.content,
		summary: lesson.summary,
		domain: "agent-runs",
		factType: "episode",
		tediId: lesson.tediId,
		visibility: "private",
		confidence: 0.6,
		source: lesson.source,
		topicKey: lesson.topicKey,
		memoryScope: "tedi",
		usePolicy: "can_use_as_evidence",
		reviewStatus: "pending",
		metadata: lesson.metadata,
	});
};

type Reflect = (
	context: BaseContext,
	orgId: string,
	lesson: AgentRunOutcomeLesson,
) => Promise<unknown>;

/**
 * Gives the tedi one turn to update its own memory from how the run ended.
 * It runs inside the once-per-Attempt claim below, so a run end causes at
 * most one such turn.
 */
const reflectOnAgentRun: Reflect = async (context, orgId, lesson) => {
	const tedi = await getTediByIdForOrganization(
		context.db,
		lesson.tediId,
		orgId,
	);
	if (!tedi || !memoryReflectionEnabled(tedi.runtimeOverrides)) return;
	await deliverMemoryReflection({
		db: context.db,
		env: context.env,
		send: (request) => context.env.TEDI_SERVICE.fetch(request),
		orgId,
		tediId: tedi.id,
		slug: tedi.slug,
		subject: `run:${lesson.metadata.attemptId}`,
		text: reflectionText("run", lesson.content),
	});
};

/**
 * Stores the lesson and never throws: the settle that calls this has already
 * been recorded. Call it only from the settle that ended the Attempt.
 */
export async function recordAgentRunOutcomeLesson(
	context: BaseContext,
	work: LessonWork,
	attempt: LessonAttempt,
	learn: Learn = learnThroughMemoryGraph,
	reflect: Reflect = reflectOnAgentRun,
): Promise<"stored" | "skipped" | "failed"> {
	const lesson = agentRunOutcomeLesson(work, attempt);
	if (!lesson) return "skipped";
	try {
		await learn(
			buildInternalServiceBindingContext(context, work.orgId),
			lesson,
		);
		await reflect(context, work.orgId, lesson).catch((error) =>
			console.warn("[agent-run-outcome] no reflection turn", {
				attemptId: attempt.id,
				exception: safeExceptionTopology(error),
			}),
		);
		return "stored";
	} catch (error) {
		console.warn("[agent-run-outcome] could not store the lesson", {
			attemptId: attempt.id,
			exception: safeExceptionTopology(error),
		});
	}
	return "failed";
}
