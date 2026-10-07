/**
 * Historic import of a person's own past local agent sessions (Claude Code,
 * Codex) as decision learning events (MCP: `import_agent_session_decisions`).
 *
 * Each decision is one pair the CLI extracted and redacted locally: the tail
 * of the agent's last message before a genuine user reply, and that reply.
 * Whole transcripts never leave the machine. The server records every pair as
 * a personal-scope learning event for the calling person, idempotent by
 * (harness, sessionId, turnId), so re-running an import never duplicates.
 */

import * as z from "zod";

export const AGENT_SESSION_DECISION_HARNESSES = [
	"claude-code",
	"codex",
] as const;
/** Bounds shared with the CLI extractor so a pair is never rejected for size. */
export const AGENT_SESSION_DECISION_LIMITS = {
	agentMessageChars: 600,
	replyChars: 1000,
	perCall: 25,
} as const;

export const AgentSessionDecisionSchema = z.strictObject({
	harness: z.enum(AGENT_SESSION_DECISION_HARNESSES),
	sessionId: z.string().trim().min(1).max(200),
	turnId: z
		.string()
		.trim()
		.min(1)
		.max(200)
		.describe("Stable id of the user turn inside its session"),
	repository: z
		.string()
		.trim()
		.min(1)
		.max(100)
		.nullable()
		.describe(
			"Repository name of the session's checkout, or null for a session outside any repository",
		),
	branch: z.string().trim().max(200).optional(),
	topic: z
		.string()
		.trim()
		.min(1)
		.max(40)
		.optional()
		.describe("Coarse reply class, e.g. `correction` or `ship`"),
	occurredAt: z.iso.datetime(),
	agentMessage: z
		.string()
		.max(AGENT_SESSION_DECISION_LIMITS.agentMessageChars)
		.describe("Redacted tail of the agent's last message before the reply"),
	reply: z
		.string()
		.trim()
		.min(1)
		.max(AGENT_SESSION_DECISION_LIMITS.replyChars)
		.describe("The person's redacted reply"),
});
export type AgentSessionDecision = z.infer<typeof AgentSessionDecisionSchema>;

export const ImportAgentSessionDecisionsInputSchema = z.strictObject({
	decisions: z
		.array(AgentSessionDecisionSchema)
		.min(1)
		.max(AGENT_SESSION_DECISION_LIMITS.perCall),
});
export type ImportAgentSessionDecisionsInput = z.infer<
	typeof ImportAgentSessionDecisionsInputSchema
>;

export const ImportAgentSessionDecisionsResultSchema = z.object({
	received: z.number().int(),
	recorded: z.number().int().describe("New learning events written"),
	duplicates: z
		.number()
		.int()
		.describe("Pairs already imported earlier (idempotent re-run)"),
});
export type ImportAgentSessionDecisionsResult = z.infer<
	typeof ImportAgentSessionDecisionsResultSchema
>;
