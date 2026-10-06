import "@orpc/openapi/extensions/route";

import { oc } from "@orpc/contract";
import * as z from "zod";
import { baseErrors } from "../errors";
import {
	AgentTurnTriagePolicyStateSchema,
	LabelAgentReplyInputSchema,
	LabelAgentReplyResultSchema,
	TriageAgentTurnInputSchema,
	TriageResultSchema,
	UpdateAgentTurnTriagePolicyInputSchema,
} from "../schemas/agent-turn-triage";

/**
 * Urgency triage of agent turns (MCP: `triage_agent_turn`,
 * `label_agent_reply`, `get_agent_turn_triage_policy`,
 * `update_agent_turn_triage_policy`).
 *
 * Triage and reply labelling are stateless model reads: nothing about the
 * submitted text is stored. A model failure or timeout is reported as
 * `status: "unavailable"`, never as an error, so callers can always fall back
 * to treating the turn as not urgent.
 */

const policyConflictErrors = {
	CONFLICT: {
		message: "Triage policy revision conflict",
		data: z
			.object({
				expectedRevision: z.number().int(),
				currentRevision: z.number().int().nullable(),
			})
			.optional(),
	},
} as const;

export const agentTurnTriageContract = oc
	.route({ tags: ["agent-turn-triage"], prefix: "/agent-turn-triage" })
	.errors(baseErrors)
	.router({
		triage: oc
			.route({
				method: "POST",
				path: "/triage",
				summary: "Triage an agent turn for urgency",
				description:
					"Scores the agent's message against the organization's triage questions and answers `now` when any probability reaches its threshold. Stores nothing. Model failure or timeout returns `status: \"unavailable\"` with urgency `later`.",
			})
			.input(TriageAgentTurnInputSchema)
			.output(TriageResultSchema),

		labelReply: oc
			.route({
				method: "POST",
				path: "/label-reply",
				summary: "Classify an operator's reply to an agent turn",
				description:
					'Classifies the reply into one fixed reply class using the agent turn as context. Stores nothing. Model failure or timeout returns `status: "unavailable"`.',
			})
			.input(LabelAgentReplyInputSchema)
			.output(LabelAgentReplyResultSchema),

		getPolicy: oc
			.route({
				method: "GET",
				path: "/policy",
				summary: "Get the caller's agent-turn triage policy",
				description:
					'Returns the stored policy for the credential-resolved organization, or the versioned defaults with `source: "default"` and `revision: 0` when none is stored.',
			})
			.input(z.object({}))
			.output(AgentTurnTriagePolicyStateSchema),

		updatePolicy: oc
			.route({
				method: "PUT",
				path: "/policy",
				summary: "Replace the caller's agent-turn triage policy",
				description:
					"Replaces the complete policy using the previously read `revision`. A lost compare-and-swap returns CONFLICT and writes nothing. The server assigns the next policy version.",
			})
			.errors(policyConflictErrors)
			.input(UpdateAgentTurnTriagePolicyInputSchema)
			.output(AgentTurnTriagePolicyStateSchema),
	});

export type AgentTurnTriageContract = typeof agentTurnTriageContract;
