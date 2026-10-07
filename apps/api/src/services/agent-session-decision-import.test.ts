import type { DbClient } from "@tedix/db/client";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tedix/db/queries/learning-feedback", () => ({
	recordLearningInteractionsBatch: vi.fn(async (_db, rows: unknown[]) => ({
		recorded: rows.length - 1,
	})),
}));

import { recordLearningInteractionsBatch } from "@tedix/db/queries/learning-feedback";
import {
	agentSessionDecisionRows,
	importAgentSessionDecisions,
} from "./agent-session-decision-import";

const decision = {
	harness: "codex" as const,
	sessionId: "session-a",
	turnId: "turn-1",
	repository: "Acme-App",
	topic: "correction",
	occurredAt: "2025-03-01T10:00:00.000Z",
	agentMessage: "Shall I open a pull request?",
	reply: "No pull requests here; commit straight to main after tests pass.",
};

describe("agentSessionDecisionRows", () => {
	it("records a personal answered event in decision-capture shape", async () => {
		const [row] = await agentSessionDecisionRows({
			organizationId: "org-1",
			userId: "user-1",
			decisions: [decision],
		});
		expect(row).toMatchObject({
			actorType: "user",
			actorId: "user-1",
			scopeKind: "personal",
			scopeId: "user-1",
			eventKind: "answered",
			surface: "agent_session_import",
			issueKey: "decision:acme-app:codex:correction",
			threadId: "session-a",
			occurredAt: decision.occurredAt,
			metadata: {
				scope: { repo: "acme-app", harness: "codex", topic: "correction" },
				question: { tail: decision.agentMessage },
				answer: decision.reply,
				source: "historic-import",
			},
		});
		expect(row!.clientEventId).toMatch(/^agent-session-import:[0-9a-f]{64}$/);
	});

	it("is idempotent by harness, session and turn, and reaches every repo without one", async () => {
		const [a, b, c] = await agentSessionDecisionRows({
			organizationId: "org-1",
			userId: "user-1",
			decisions: [
				decision,
				{ ...decision, reply: "edited later, same turn", repository: null },
				{ ...decision, turnId: "turn-2" },
			],
		});
		expect(b!.clientEventId).toBe(a!.clientEventId);
		expect(c!.clientEventId).not.toBe(a!.clientEventId);
		expect(b!.issueKey).toBe("decision:general:codex:correction");
	});
});

describe("importAgentSessionDecisions", () => {
	it("drops repeated turns in a batch and counts duplicates", async () => {
		const result = await importAgentSessionDecisions({} as DbClient, {
			organizationId: "org-1",
			userId: "user-1",
			decisions: [decision, decision, { ...decision, turnId: "turn-2" }],
		});
		expect(
			vi.mocked(recordLearningInteractionsBatch).mock.calls[0]![1],
		).toHaveLength(2);
		expect(result).toEqual({ received: 3, recorded: 1, duplicates: 2 });
	});
});
