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

export type AgentRunEndedHomeMessage = {
	organizationId: string;
	conversationId: string;
	idempotencyKey: string;
	content: string;
};

type EnqueueHome = (
	context: BaseContext,
	message: AgentRunEndedHomeMessage,
) => Promise<{ status: string; error?: string }>;

/**
 * Sends the notice as a message to Home in the person's chat, the same way
 * the person's own message arrives, so Home answers in that thread.
 */
export const enqueueHomeMessage: EnqueueHome = async (context, message) => {
	const { kernelRuntimeContractRouter } =
		await import("../rpc/routers/kernel-runtime");
	const client = createRouterClient(kernelRuntimeContractRouter, { context });
	return client.enqueueMessage({
		...message,
		metadata: { agentRunEnded: true },
	});
};

/**
 * The sentence that reports a finished run, or null when the Work Item was
 * not started by a tedi or the Attempt was not run by an external agent.
 */
function runEndedSentence(
	work: NoticeWork,
	attempt: NoticeAttempt,
): string | null {
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
	return `The run for "${work.title}" ended: ${outcome}.${note ? ` ${note}.` : ""} Task: /work/items/${work.id}`;
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
	const sentence = runEndedSentence(work, attempt);
	if (!sentence) return null;
	return {
		organizationId: work.orgId,
		conversationId,
		idempotencyKey: `agent-run-ended-${attempt.id}`,
		content: `[System: an agent run that a tedi started from this chat has ended. Tell the person the result. Do not start new work.] ${sentence}`,
	};
}

/**
 * Reports in the chat that started an agent run that the run ended: to the
 * tedi in its own chat, or to Home in the person's chat when the person
 * picked the tedi there. Sends at most one message per Attempt and never
 * throws: the settle that calls this has already been recorded.
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
			: null;
	if (!send) return "skipped";
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
	await releaseWorkAttemptConversationNotice(context.db, scope).catch(
		() => undefined,
	);
	return "failed";
}
