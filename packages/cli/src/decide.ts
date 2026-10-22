import {
	ListAgentDecisionsInputSchema,
	ListAgentDecisionsResultSchema,
	RecordAgentDecisionInputSchema,
	RecordAgentDecisionOutcomeInputSchema,
	RecordAgentDecisionOutcomeResultSchema,
	RecordAgentDecisionResultSchema,
} from "@tedix/api-contract/schemas/agent-decisions";
import { normalizeCodeResult, truncationErrorMessage } from "./code-result";
import { errorText } from "./format";
import type { NativeToolContext } from "./work";
import { resolveAgentSession } from "./work-identity";
import { callConfiguredNativeTool } from "./work-native";

export function decideUsage(): string {
	return `tedix decide '<decision-json>' [--json]
tedix decide outcome <decision-id> <worked|reverted|partial> '<evidence>' [person] [--json]
tedix decide list [--limit <n>] [--json]

Records a decision this agent made on its own, so people can review it and Tedix can learn from it.
Decision JSON: {"decisionClass":"lane.pause","question":"…","options":[{"id":"pause","label":"Pause"},{"id":"keep","label":"Keep running"}],"chosen":"pause","reason":"…","reversibility":"two_way","confidence":0.8,"workItemId":"<uuid>","commitShas":["<sha>"]}
Optional: agentName (e.g. "Lead"), protectedEffects, tasteOrStrategy, outputId, priorDecisionId + priorRelation (depends_on|supersedes), approvalRef, occurredAt.
agentSession defaults to this session (TEDIX_AGENT_SESSION or the harness session).
Add "person" to an outcome when a person overrode or undid the decision: it is recorded as a correction.
Recording a decision grants no authority. Decisions that need a person still go through approvals.`;
}

export interface DecideCommandContext extends NativeToolContext {
	json: boolean;
	positionals: string[];
	limit?: number;
}

export async function runDecideCommand(
	ctx: DecideCommandContext,
): Promise<number> {
	try {
		const args = [...ctx.positionals];
		const first = args[0];
		let tool: string;
		let input: Record<string, unknown>;
		let schema:
			| typeof RecordAgentDecisionResultSchema
			| typeof RecordAgentDecisionOutcomeResultSchema
			| typeof ListAgentDecisionsResultSchema;
		if (first === "outcome") {
			const [, decisionId, outcome, evidence, by, ...rest] = args;
			if (!decisionId || !outcome || !evidence || rest.length)
				throw new Error(decideUsage());
			if (by !== undefined && by !== "person") throw new Error(decideUsage());
			input = RecordAgentDecisionOutcomeInputSchema.parse({
				decisionId,
				outcome,
				evidence,
				by: by === "person" ? "person" : "agent",
			});
			tool = "record_agent_decision_outcome";
			schema = RecordAgentDecisionOutcomeResultSchema;
		} else if (first === "list") {
			if (args.length > 1) throw new Error(decideUsage());
			input = ListAgentDecisionsInputSchema.parse(
				ctx.limit !== undefined ? { limit: ctx.limit } : {},
			);
			tool = "list_agent_decisions";
			schema = ListAgentDecisionsResultSchema;
		} else {
			if (!first?.startsWith("{") || args.length !== 1)
				throw new Error(decideUsage());
			const raw = JSON.parse(first) as Record<string, unknown>;
			const agentSession =
				typeof raw.agentSession === "string"
					? raw.agentSession
					: resolveAgentSession()?.session;
			input = RecordAgentDecisionInputSchema.parse({ ...raw, agentSession });
			tool = "record_agent_decision";
			schema = RecordAgentDecisionResultSchema;
		}
		const raw = await callConfiguredNativeTool(ctx, `decision.${tool}`, input);
		const normalized = normalizeCodeResult(raw);
		if (normalized.truncated)
			throw new Error(truncationErrorMessage(normalized));
		const value = schema.parse(normalized.value);
		if (ctx.json) console.log(JSON.stringify(value, null, 2));
		else if ("summary" in value) {
			console.log(value.summary);
			for (const decision of value.decisions)
				console.log(
					`${decision.id}  ${decision.decisionClass}  ${decision.chosen.label}${decision.outcome ? ` (${decision.outcome.outcome})` : ""}\n  ${decision.question}`,
				);
		} else if ("classId" in value) {
			console.log(
				`${value.duplicate ? "Already recorded" : "Recorded"} ${value.decisionId} as ${value.classId}${value.askable ? " (shown in the morning review)" : ""}`,
			);
			if (value.notice) console.log(value.notice);
		} else
			console.log(
				`${value.duplicate ? "Already recorded" : "Recorded"} outcome for ${value.decisionId}${value.correction ? " as a correction" : ""}`,
			);
		return 0;
	} catch (error) {
		console.error(errorText(error));
		return 2;
	}
}
