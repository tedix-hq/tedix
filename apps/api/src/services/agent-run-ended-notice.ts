import {
	WorkAttemptSettlementSchema,
	workSettlementCommits,
} from "@tedix/api-contract/schemas/work-items";
import { createRouterClient } from "@orpc/server";
import { z } from "zod";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import type { WorkAttempt, WorkItem } from "@tedix/db/schema/work-items";
import { safeExceptionTopology } from "../lib/safe-log-metadata";
import type { BaseContext } from "../rpc/orpc";
import { buildInternalServiceBindingContext } from "../rpc/routers/kernel/runtime-shared";

const NOTE_LIMIT = 500;

type NoticeWork = Pick<
	WorkItem,
	| "id"
	| "orgId"
	| "title"
	| "sourceSessionKey"
	| "sourceIntentId"
	| "stewardType"
	| "stewardId"
	| "executorId"
>;
type NoticeAttempt = Pick<
	WorkAttempt,
	"id" | "executorType" | "outcome" | "summary" | "metadata"
>;

export type AgentRunEndedMessage = {
	tediId: string;
	conversationId: string;
	idempotencyKey: string;
	content: string;
};

type Enqueue = (
	context: BaseContext,
	message: AgentRunEndedMessage,
) => Promise<{ status: string; error?: string }>;

/**
 * Sends a message to the tedi in its own chat, the way the person's message
 * arrives, so the tedi answers in that thread. `source` labels the message
 * in the run's history.
 */
export const enqueueTediMessage = async (
	context: BaseContext,
	message: AgentRunEndedMessage,
	source = "agent-run-ended",
): Promise<{ status: string; error?: string }> => {
	const { cognitiveRuntimeContractRouter } =
		await import("../rpc/routers/cognitive-runtime");
	const client = createRouterClient(cognitiveRuntimeContractRouter, {
		context,
	});
	return client.enqueueMessage({
		...message,
		metadata: { source, dispatchMode: "async" },
	});
};

export type AgentRunEndedHomeMessage = {
	organizationId: string;
	conversationId: string;
	idempotencyKey: string;
	content: string;
	delegateToTediId?: string;
};

type EnqueueHome = (
	context: BaseContext,
	message: AgentRunEndedHomeMessage,
) => Promise<{ status: string; error?: string }>;

export const enqueueHomeMessage = async (
	context: BaseContext,
	message: AgentRunEndedHomeMessage,
	metadata: Record<string, boolean> = { agentRunEnded: true },
): Promise<{ status: string; error?: string }> => {
	const { kernelRuntimeContractRouter } =
		await import("../rpc/routers/kernel-runtime");
	const client = createRouterClient(kernelRuntimeContractRouter, { context });
	return client.enqueueMessage({
		...message,
		metadata: message.delegateToTediId
			? { ...metadata, source: "platform" }
			: metadata,
	});
};

/** The sentence that reports a settled external agent run. */
function runEndedSentence(
	work: NoticeWork,
	attempt: NoticeAttempt,
): string | null {
	if (attempt.executorType !== "external_agent" || !attempt.outcome)
		return null;
	const outcome =
		attempt.outcome === "succeeded" ||
		attempt.outcome === "cancelled" ||
		attempt.outcome === "landed_unverified"
			? attempt.outcome
			: "failed";
	const note = (attempt.summary ?? "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, NOTE_LIMIT)
		.replace(/[.\s]+$/, "");
	return `The run for "${work.title}" ended: ${outcome === "landed_unverified" ? "landed, not verified" : outcome}.${note ? ` ${note}.` : ""} Task: /work/items/${work.id}`;
}

/**
 * The message for the tedi whose chat started this run, or null when the
 * Work Item did not come from a tedi chat or was not run by an external agent.
 * A tedi chat is a `source_session_key` that starts with `agent:` on a Work
 * Item whose steward is that tedi.
 */
export function agentRunEndedMessage(
	work: NoticeWork,
	attempt: NoticeAttempt,
): AgentRunEndedMessage | null {
	const conversationId = work.sourceSessionKey?.trim();
	if (!conversationId?.toLowerCase().startsWith("agent:")) return null;
	if (work.stewardType !== "tedi" || !work.stewardId) return null;
	const content = runEndedSentence(work, attempt);
	if (!content || !work.stewardId) return null;
	return {
		tediId: work.stewardId,
		conversationId,
		idempotencyKey: `agent-run-ended:${attempt.id}`,
		content,
	};
}

/**
 * The message for the person's chat when a tedi they picked there started
 * this run, or null for any other Work Item. Such a Work Item carries the
 * Home conversation (a key that starts with `home:`) as its
 * `source_session_key`.
 */
export function agentRunEndedHomeMessage(
	work: NoticeWork,
	attempt: NoticeAttempt,
): AgentRunEndedHomeMessage | null {
	const conversationId = work.sourceSessionKey?.trim();
	if (!conversationId?.startsWith("home:")) return null;
	if (work.stewardType !== "tedi" || !work.stewardId) return null;
	const sentence = runEndedSentence(work, attempt);
	if (!sentence) return null;
	return {
		organizationId: work.orgId,
		conversationId,
		delegateToTediId: work.stewardId,
		idempotencyKey: `agent-run-ended-${attempt.id}`,
		content: `[System: an agent run that a tedi started from this chat has ended. Tell the person the result. Do not start new work.] ${sentence}`,
	};
}

/** What the workspace store takes; `apps/workspace-do/src/run-report.ts`. */
export type WorkspaceRunReport =
	| {
			kind: "ended";
			conversationId: string;
			sourceTurnId: string | null;
			workItemId: string;
			attemptId: string;
			title: string;
			outcome: "succeeded" | "landed_unverified" | "failed" | "cancelled";
			result: string;
			commits: string[];
			unverified: string | null;
	  }
	| {
			kind: "question";
			conversationId: string;
			workItemId: string;
			attemptId: string;
			seq: number;
			title: string;
			executor: string;
	  };

/**
 * The workspace conversation a run was started from: `startRun` records it
 * as the source session `workspace:<workspace>:<conversation>`, and the turn
 * that started it as the source intent `<session>:<turn>`.
 */
function workspaceOrigin(work: NoticeWork) {
	const key = work.sourceSessionKey ?? "";
	const [prefix, workspaceId, conversationId, ...extra] = key.split(":");
	const uuid = z.uuid();
	if (
		prefix !== "workspace" ||
		extra.length ||
		!uuid.safeParse(workspaceId).success ||
		!uuid.safeParse(conversationId).success
	)
		return null;
	const intent = work.sourceIntentId ?? "";
	return {
		workspaceId: workspaceId!,
		conversationId: conversationId!,
		sourceTurnId: intent.startsWith(`${key}:`)
			? intent.slice(key.length + 1) || null
			: null,
	};
}

async function sendWorkspaceReport(
	context: BaseContext,
	work: NoticeWork,
	workspaceId: string,
	report: WorkspaceRunReport,
): Promise<{ status: string; error?: string }> {
	const runtime = context.env.WORKSPACE_RUNTIME as unknown as {
		reportAgentRun(
			scope: { organizationId: string; workspaceId: string },
			report: WorkspaceRunReport,
		): Promise<unknown>;
	};
	await runtime.reportAgentRun(
		{ organizationId: work.orgId, workspaceId },
		report,
	);
	return { status: "sent" };
}

/** The report of a settled run started from a workspace conversation. */
export function workspaceRunEndedReport(
	work: NoticeWork,
	attempt: NoticeAttempt,
): { workspaceId: string; report: WorkspaceRunReport } | null {
	const origin = workspaceOrigin(work);
	if (!origin || attempt.executorType !== "external_agent" || !attempt.outcome)
		return null;
	const metadata = isRecord(attempt.metadata) ? attempt.metadata : {};
	const shas = workSettlementCommits(
		WorkAttemptSettlementSchema.safeParse(metadata.settlement).data,
	);
	const lane = isRecord(metadata.laneResult) ? metadata.laneResult : {};
	const unverified =
		typeof lane.unverified === "string"
			? lane.unverified
			: typeof lane.remaining === "string"
				? lane.remaining
				: null;
	return {
		workspaceId: origin.workspaceId,
		report: {
			kind: "ended",
			conversationId: origin.conversationId,
			sourceTurnId: origin.sourceTurnId,
			workItemId: work.id,
			attemptId: attempt.id,
			title: work.title,
			outcome:
				attempt.outcome === "succeeded" ||
				attempt.outcome === "cancelled" ||
				attempt.outcome === "landed_unverified"
					? attempt.outcome
					: "failed",
			result: (attempt.summary ?? "").slice(0, 4_000),
			commits: shas.slice(0, 10),
			unverified: unverified?.slice(0, 1_800) ?? null,
		},
	};
}

function workspaceRunNotice(work: NoticeWork, attempt: NoticeAttempt) {
	const ended = workspaceRunEndedReport(work, attempt);
	return ended
		? (context: BaseContext) =>
				sendWorkspaceReport(context, work, ended.workspaceId, ended.report)
		: null;
}

/**
 * Reports the end of a run in the chat that started it and never throws after
 * settlement has been recorded. Call it only from the settle that ended the
 * Attempt: a settled Attempt cannot be updated, so it carries no "reported"
 * mark, and the chats drop a repeat by its Attempt id.
 */
export async function notifyAgentRunEnded(
	context: BaseContext,
	work: NoticeWork,
	attempt: NoticeAttempt,
	enqueue: Enqueue = enqueueTediMessage,
	enqueueHome: EnqueueHome = enqueueHomeMessage,
): Promise<"sent" | "skipped" | "failed"> {
	const tediMessage = agentRunEndedMessage(work, attempt);
	const homeMessage = tediMessage
		? null
		: agentRunEndedHomeMessage(work, attempt);
	const send = tediMessage
		? (internal: BaseContext) => enqueue(internal, tediMessage)
		: homeMessage
			? (internal: BaseContext) => enqueueHome(internal, homeMessage)
			: workspaceRunNotice(work, attempt);
	if (!send) return "skipped";
	try {
		const result = await send(
			buildInternalServiceBindingContext(context, work.orgId),
		);
		if (result.status !== "failed") return "sent";
		console.warn("[agent-run-ended] the chat did not accept the message", {
			attemptId: attempt.id,
			error: result.error,
		});
	} catch (error) {
		console.warn("[agent-run-ended] could not message the chat", {
			attemptId: attempt.id,
			exception: safeExceptionTopology(error),
		});
	}
	return "failed";
}
