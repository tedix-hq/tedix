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

/** The drafter, triage or gate configuration itself. */
const SELF_MODIFICATION =
	/\b(?:drafter|drafting (?:prompt|tedi|policy)|reply[- ]?draft(?:ing)?|(?:turn[- ]?)?triage (?:prompt|policy|questions?)|agent-turn-triage|work\.turn-triage|delivery[- ]?gate|auto[- ]?send)\b/i;
const PUSH = /\bpush(?:ed|es|ing)?\b/i;
const VALIDATION_PASSED =
	/\b(?:pass(?:ed|es|ing)?|green|validated|succeeded)\b/i;

/**
 * Deterministic checks no stored policy can relax, failed before any model
 * call: a draft about the drafting or triage prompt, policy or gate itself
 * (self-modification), and a push the agent has not reported as validated.
 */
export function guardReplyDraft(
	agentMessage: string,
	draftReply: string,
): AgentReplyDeliveryGateResult["checks"] {
	const checks: AgentReplyDeliveryGateResult["checks"] = [];
	if (
		SELF_MODIFICATION.test(draftReply) ||
		SELF_MODIFICATION.test(agentMessage)
	)
		checks.push({ id: "self_modification", p: 1, pass: false });
	if (
		PUSH.test(draftReply) &&
		(!VALIDATION_PASSED.test(agentMessage) || /\bfail/i.test(agentMessage))
	)
		checks.push({ id: "unvalidated_push", p: 1, pass: false });
	return checks;
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
	const guarded = guardReplyDraft(params.agentMessage, params.draftReply);
	if (guarded.length)
		return {
			status: "fail",
			model: params.gate.model,
			checks: guarded,
			latencyMs: 0,
		};
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
