/**
 * Clef delivery gate for tedi-drafted replies.
 *
 * The drafting tedi's own `reversible` flag is not trusted on its own: before
 * a draft may be sent without review, an independent Clef decision model
 * scores the agent's message and the drafted reply against the policy's
 * `deliveryGate` checks. Every check must pass. A model error, timeout, or
 * malformed answer is `unavailable`, which the caller delivers as `review`
 * (fail closed). The result is stored on the draft for audit.
 */

import type {
	AgentReplyDeliveryGatePolicy,
	AgentReplyDeliveryGateResult,
} from "@tedix/api-contract/schemas/agent-turn-triage";
import { type ClefQuestion, runClef } from "../lib/clef";

/** Agent messages are bounded like the drafting prompt's copy of them. */
const AGENT_MESSAGE_LIMIT = 8_000;

type GateEnv = Parameters<typeof runClef>[0];

/** Pure scoring step: per-check verdicts and the overall status. */
export function scoreReplyDraftGate(
	gate: AgentReplyDeliveryGatePolicy,
	probabilities: Record<string, number>,
): Pick<AgentReplyDeliveryGateResult, "status" | "checks"> {
	const checks = gate.questions.map((question) => {
		const p = probabilities[question.id];
		const pass =
			typeof p === "number" &&
			("gte" in question.autoWhen
				? p >= question.autoWhen.gte
				: p <= question.autoWhen.lte);
		return { id: question.id, p: p ?? 0, pass };
	});
	return {
		status: checks.every((check) => check.pass) ? "pass" : "fail",
		checks,
	};
}

export async function evaluateReplyDraftGate(
	env: GateEnv,
	params: {
		gate: AgentReplyDeliveryGatePolicy;
		agentMessage: string;
		draftReply: string;
		timeoutMs?: number;
	},
): Promise<AgentReplyDeliveryGateResult> {
	const questions: Record<string, ClefQuestion> = {};
	for (const question of params.gate.questions) {
		questions[question.id] = {
			type: "noul",
			instructions: question.instructions,
		};
	}
	const agentMessage =
		params.agentMessage.length > AGENT_MESSAGE_LIMIT
			? `${params.agentMessage.slice(0, AGENT_MESSAGE_LIMIT)}\n[truncated]`
			: params.agentMessage;
	const result = await runClef(env, {
		modelId: params.gate.model,
		state: { agent_message: agentMessage, draft_reply: params.draftReply },
		questions,
		surface: "agent-reply-delivery-gate",
		timeoutMs: params.timeoutMs,
	});
	if (!result.ok) {
		return {
			status: "unavailable",
			model: params.gate.model,
			checks: [],
			latencyMs: result.latencyMs,
		};
	}
	const probabilities: Record<string, number> = {};
	for (const [id, answer] of Object.entries(result.answers)) {
		if (answer.type === "noul") probabilities[id] = answer.noul;
	}
	return {
		...scoreReplyDraftGate(params.gate, probabilities),
		model: params.gate.model,
		latencyMs: result.latencyMs,
	};
}
