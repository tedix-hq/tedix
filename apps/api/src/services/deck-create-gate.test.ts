import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { DecisionLearningConfigSchema } from "@tedix/api-contract/schemas/decision-learning";
import type { BaseContext } from "../rpc/orpc";
import { deckCreateGate } from "./deck-create-gate";

const mocks = vi.hoisted(() => ({ config: vi.fn() }));
vi.mock("@tedix/db/queries/decision-learning", () => ({
	getDecisionLearningConfig: mocks.config,
}));

const orgId = "11111111-1111-4111-8111-111111111111";
const context = { db: {} } as BaseContext;
const actor = { type: "tedi" as const, id: "test-worker" };
const recipientId = "recipient-1";
const status = {
	kind: "question",
	subject: "Attempt failed",
	prompt: "Failed: the attempt stopped without a reported reason.",
	metadata: {},
	recipientId,
};
const rule = (reason: string) => ({
	id: `rule-${reason}`,
	recipientId,
	sourceKey: "tedi:test-worker",
	reason,
	sentence: "Asks from tedi test-wor go back to the agent to handle itself.",
	evidenceIds: ["a", "b", "c"],
	createdAt: "2026-10-20T00:00:00.000Z",
});

beforeEach(() => {
	mocks.config.mockReset();
	mocks.config.mockResolvedValue(DecisionLearningConfigSchema.parse({}));
});

describe("deckCreateGate", () => {
	it("returns a malformed agent card to its agent with the reason", async () => {
		await expect(deckCreateGate(context, orgId, actor, status)).rejects.toThrow(
			/returned to you: it needs a clear ask.*recommendation.*evidence/,
		);
	});

	it("passes a protected ask and flags it", async () => {
		expect(
			await deckCreateGate(context, orgId, actor, {
				...status,
				prompt: "Failed: please approve the payment of the invoice.",
				metadata: { riskLevel: "high" },
			}),
		).toEqual({
			expiresAt: undefined,
			receipt: {
				verdict: "pass_protected",
				mode: "enforce",
				missing: ["recommendation", "evidence"],
				rule: null,
			},
		});
	});

	it("records but never blocks in shadow mode", async () => {
		mocks.config.mockResolvedValue(
			DecisionLearningConfigSchema.parse({
				deckPipeline: { createGate: { mode: "shadow" } },
			}),
		);
		expect(
			(await deckCreateGate(context, orgId, actor, status))?.receipt,
		).toMatchObject({ verdict: "bounce", mode: "shadow" });
	});

	it("passes a complete ask without a receipt", async () => {
		expect(
			await deckCreateGate(context, orgId, actor, {
				...status,
				subject: "Choose the venue?",
				prompt: "I recommend the lakeside venue.",
				workItemId: orgId,
			}),
		).toEqual({ expiresAt: undefined, receipt: null });
	});

	it("applies learned rules: agent-could-do bounces, expired ends at the due time", async () => {
		mocks.config.mockResolvedValue(
			DecisionLearningConfigSchema.parse({
				deckPipeline: { rules: [rule("agent_could_do")] },
			}),
		);
		await expect(
			deckCreateGate(context, orgId, actor, {
				...status,
				subject: "Choose the venue?",
				prompt: "I recommend the lakeside venue.",
				workItemId: orgId,
			}),
		).rejects.toThrow(/learned rule/);
		mocks.config.mockResolvedValue(
			DecisionLearningConfigSchema.parse({
				deckPipeline: { rules: [rule("expired")] },
			}),
		);
		expect(
			await deckCreateGate(context, orgId, actor, {
				...status,
				subject: "Choose the venue?",
				prompt: "I recommend the lakeside venue.",
				workItemId: orgId,
				dueAt: "2026-12-01T00:00:00.000Z",
			}),
		).toMatchObject({
			expiresAt: "2026-12-01T00:00:00.000Z",
			receipt: { verdict: "pass", expiryRule: "rule-expired" },
		});
	});

	it("does nothing when the organization turned it off", async () => {
		mocks.config.mockResolvedValue(
			DecisionLearningConfigSchema.parse({
				deckPipeline: { createGate: { mode: "off" } },
			}),
		);
		expect(await deckCreateGate(context, orgId, actor, status)).toBeNull();
	});
});
