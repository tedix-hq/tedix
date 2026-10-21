import { expect, it } from "vite-plus/test";
import { AgentSessionDecisionSchema } from "./agent-session-decisions";
import { AgentSessionEventSchema } from "./agent-session-requests";
import { ReportWorkAgentSessionStatusInputSchema } from "./work-agent-sessions";

const sessionKey = "ses_ea08bec38ffeGv2rruD2pzxAuC";
const status = {
	harness: "opencode",
	sessionKey,
	state: "working",
	summary: "Working",
	label: "example",
};
const event = {
	harness: "opencode",
	sessionKey,
	kind: "prompt",
	sourceAt: "2026-10-21T12:00:00.000Z",
	text: "Check the example",
};
const decision = {
	harness: "opencode",
	sessionId: sessionKey,
	turnId: "msg_example",
	repository: "example",
	occurredAt: event.sourceAt,
	agentMessage: "Use the same validation?",
	reply: "Yes, keep every existing guard.",
};

it("accepts OpenCode status, ledger events and decision pairs", () => {
	expect(
		ReportWorkAgentSessionStatusInputSchema.safeParse(status).success,
	).toBe(true);
	expect(AgentSessionEventSchema.safeParse(event).success).toBe(true);
	expect(AgentSessionDecisionSchema.safeParse(decision).success).toBe(true);
});

it("retains harness, key, state, size and strict-object validation", () => {
	for (const change of [
		{ harness: "unknown-host" },
		{ sessionKey: "../escape" },
		{ state: "approved" },
		{ summary: "x".repeat(201) },
		{ organizationId: "other" },
	])
		expect(
			ReportWorkAgentSessionStatusInputSchema.safeParse({
				...status,
				...change,
			}).success,
		).toBe(false);
	expect(
		AgentSessionEventSchema.safeParse({ ...event, text: "" }).success,
	).toBe(false);
	expect(
		AgentSessionEventSchema.safeParse({ ...event, harness: "unknown-host" })
			.success,
	).toBe(false);
	expect(
		AgentSessionDecisionSchema.safeParse({
			...decision,
			reply: "x".repeat(1001),
		}).success,
	).toBe(false);
});
