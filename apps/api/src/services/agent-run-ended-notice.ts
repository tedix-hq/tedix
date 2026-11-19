import { createRouterClient } from "@orpc/server";
import type { WorkAttempt, WorkItem } from "@tedix/db/schema/work-items";
import {
	claimWorkAttemptConversationNotice,
	releaseWorkAttemptConversationNotice,
} from "@tedix/db/queries/work-items/attempts";
import { safeExceptionTopology } from "../lib/safe-log-metadata";
import type { BaseContext } from "../rpc/orpc";
import { buildInternalServiceBindingContext } from "../rpc/routers/kernel/runtime-shared";

const NOTE_LIMIT = 500;

type NoticeWork = Pick<
	WorkItem,
	"id" | "orgId" | "title" | "sourceSessionKey" | "stewardType" | "stewardId"
>;
type NoticeAttempt = Pick<
	WorkAttempt,
	"id" | "executorType" | "outcome" | "summary"
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

const enqueueTediMessage: Enqueue = async (context, message) => {
	const { cognitiveRuntimeContractRouter } =
		await import("../rpc/routers/cognitive-runtime");
	const client = createRouterClient(cognitiveRuntimeContractRouter, {
		context,
	});
	return client.enqueueMessage({
		...message,
		metadata: { source: "agent-run-ended", dispatchMode: "async" },
	});
};

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
	if (attempt.executorType !== "external_agent" || !attempt.outcome)
		return null;
	const outcome =
		attempt.outcome === "succeeded" || attempt.outcome === "cancelled"
			? attempt.outcome
			: "failed";
	const note = (attempt.summary ?? "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, NOTE_LIMIT)
		.replace(/[.\s]+$/, "");
	return {
		tediId: work.stewardId,
		conversationId,
		idempotencyKey: `agent-run-ended:${attempt.id}`,
		content: `The run for "${work.title}" ended: ${outcome}.${note ? ` ${note}.` : ""} Task: /work/items/${work.id}`,
	};
}

/**
 * Tells the tedi, in the chat that started an agent run, that the run ended.
 * Sends at most one message per Attempt and never throws: the settle that
 * calls this has already been recorded.
 */
export async function notifyAgentRunEnded(
	context: BaseContext,
	work: NoticeWork,
	attempt: NoticeAttempt,
	enqueue: Enqueue = enqueueTediMessage,
): Promise<"sent" | "skipped" | "failed"> {
	const message = agentRunEndedMessage(work, attempt);
	if (!message) return "skipped";
	const scope = {
		orgId: work.orgId,
		workItemId: work.id,
		attemptId: attempt.id,
	};
	try {
		if (!(await claimWorkAttemptConversationNotice(context.db, scope)))
			return "skipped";
	} catch (error) {
		console.warn("[agent-run-ended] could not mark the Attempt as reported", {
			attemptId: attempt.id,
			exception: safeExceptionTopology(error),
		});
		return "failed";
	}
	try {
		const result = await enqueue(
			buildInternalServiceBindingContext(context, work.orgId),
			message,
		);
		if (result.status !== "failed") return "sent";
		console.warn("[agent-run-ended] the tedi did not accept the message", {
			attemptId: attempt.id,
			error: result.error,
		});
	} catch (error) {
		console.warn("[agent-run-ended] could not message the tedi", {
			attemptId: attempt.id,
			exception: safeExceptionTopology(error),
		});
	}
	await releaseWorkAttemptConversationNotice(context.db, scope).catch(
		() => undefined,
	);
	return "failed";
}
