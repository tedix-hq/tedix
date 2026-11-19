/**
 * Lets the tedi that supervises an agent run tell the person something about
 * it, in the chat the run was started from. It uses the same two deliveries
 * as the notice that a run ended: a message to the tedi in its own chat, or
 * a message to Home in the person's chat when the person picked the tedi
 * there. The chat's agent then tells the person in its own words.
 */

import { claimAgentRunPersonUpdate } from "@tedix/db/queries/work-items/agent-runs";
import type { WorkItem } from "@tedix/db/schema/work-items";
import { safeExceptionTopology } from "../lib/safe-log-metadata";
import type { BaseContext } from "../rpc/orpc";
import { buildInternalServiceBindingContext } from "../rpc/routers/kernel/runtime-shared";
import {
	enqueueHomeMessage,
	enqueueTediMessage,
} from "./agent-run-ended-notice";

/** At most one update per run in this long. */
export const AGENT_RUN_UPDATE_WINDOW_MS = 5 * 60_000;

type UpdateWork = Pick<
	WorkItem,
	"id" | "orgId" | "title" | "sourceSessionKey" | "stewardType" | "stewardId"
>;

export type AgentRunPersonUpdate =
	| {
			chat: "tedi";
			tediId: string;
			conversationId: string;
			idempotencyKey: string;
			content: string;
	  }
	| {
			chat: "home";
			organizationId: string;
			conversationId: string;
			idempotencyKey: string;
			content: string;
	  };

/**
 * The message for the chat that started the run, or null when the Work Item
 * did not come from a chat a tedi can report into.
 */
export function agentRunPersonUpdate(
	work: UpdateWork,
	message: string,
	now: number,
): AgentRunPersonUpdate | null {
	const conversationId = work.sourceSessionKey?.trim();
	if (!conversationId || work.stewardType !== "tedi" || !work.stewardId)
		return null;
	const window = Math.floor(now / AGENT_RUN_UPDATE_WINDOW_MS);
	const text = `${message.replace(/\s+/g, " ").trim()} Task: /work/items/${work.id}`;
	if (conversationId.toLowerCase().startsWith("agent:"))
		return {
			chat: "tedi",
			tediId: work.stewardId,
			conversationId,
			idempotencyKey: `agent-run-update:${work.id}:${window}`,
			content: `[System: while checking on the agent run for "${work.title}", which you started from this chat, you decided the person should know the following. Tell them in your own words. Do not start new work.] ${text}`,
		};
	if (conversationId.startsWith("home:"))
		return {
			chat: "home",
			organizationId: work.orgId,
			conversationId,
			idempotencyKey: `agent-run-update-${work.id}-${window}`,
			content: `[System: the tedi that started the agent run for "${work.title}" from this chat has an update for the person. Tell the person. Do not start new work.] ${text}`,
		};
	return null;
}

export type AgentRunPersonUpdateResult = {
	status: "sent" | "too_soon" | "no_chat" | "failed";
	chat?: "tedi" | "home";
};

export async function sendAgentRunPersonUpdate(
	context: BaseContext,
	work: UpdateWork,
	message: string,
	now = Date.now(),
): Promise<AgentRunPersonUpdateResult> {
	const update = agentRunPersonUpdate(work, message, now);
	if (!update) return { status: "no_chat" };
	const { chat } = update;
	if (
		!(await claimAgentRunPersonUpdate(context.db, {
			orgId: work.orgId,
			workItemId: work.id,
			at: new Date(now).toISOString(),
			notBefore: new Date(now - AGENT_RUN_UPDATE_WINDOW_MS).toISOString(),
		}))
	)
		return { status: "too_soon", chat };
	const internal = buildInternalServiceBindingContext(context, work.orgId);
	try {
		const result =
			update.chat === "tedi"
				? await enqueueTediMessage(
						internal,
						{
							tediId: update.tediId,
							conversationId: update.conversationId,
							idempotencyKey: update.idempotencyKey,
							content: update.content,
						},
						"agent-run-update",
					)
				: await enqueueHomeMessage(
						internal,
						{
							organizationId: update.organizationId,
							conversationId: update.conversationId,
							idempotencyKey: update.idempotencyKey,
							content: update.content,
						},
						{ agentRunUpdate: true },
					);
		if (result.status !== "failed") return { status: "sent", chat };
	} catch (error) {
		console.warn("[agent-run-update] could not message the chat", {
			workItemId: work.id,
			exception: safeExceptionTopology(error),
		});
	}
	// The mark stays: a failed delivery does not open the door to a retry loop.
	return { status: "failed", chat };
}
