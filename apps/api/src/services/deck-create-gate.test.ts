import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { DecisionLearningConfigSchema } from "@tedix/api-contract/schemas/decision-learning";
import type { BaseContext } from "../rpc/orpc";
import { deckCreateGate } from "./deck-create-gate";

const mocks = vi.hoisted(() => ({
	config: vi.fn(),
	prior: vi.fn(),
	states: vi.fn(),
}));
vi.mock("@tedix/db/queries/decision-learning", () => ({
	getDecisionLearningConfig: mocks.config,
}));

vi.mock("@tedix/db/queries/decision-graph", () => ({
	findPriorDecision: mocks.prior,
}));
vi.mock("@tedix/db/queries/work-items/deck-sweep", () => ({
	listDeckSourceStates: mocks.states,
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
	mocks.prior.mockReset().mockResolvedValue(null);
	mocks.states.mockReset().mockResolvedValue(new Map());
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

it("blocks a cited prior decision and blocked sources without creating a card", async () => {
	mocks.prior.mockResolvedValue({
		node: { kind: "owner_instruction", id: "maple-lesson" },
		edge: { evidenceRef: "/lessons/maple-lesson" },
	});
	const input = {
		...status,
		subject: "Should Maple renew?",
		prompt: "I recommend renewal.",
		workItemId: orgId,
	};
	await expect(deckCreateGate(context, orgId, actor, input)).rejects.toThrow(
		"Already decided: /lessons/maple-lesson",
	);
	mocks.prior.mockResolvedValue(null);
	mocks.states.mockResolvedValue(new Map([[orgId, "blocked"]]));
	await expect(deckCreateGate(context, orgId, actor, input)).rejects.toThrow(
		"Withdrawn: check the source",
	);
	mocks.states.mockResolvedValue(new Map([[orgId, "accepted"]]));
	expect(await deckCreateGate(context, orgId, actor, input)).toMatchObject({
		receipt: null,
	});
});
it("returns incomplete owner chores to their producer for exact steps and duration", async () => {
	await expect(
		deckCreateGate(context, orgId, actor, {
			...status,
			subject: "Sign in with your MFA",
		}),
	).rejects.toThrow("metadata.ownerTask");
});
it("rejects a stale re-ask without a Work link and permits a refreshed ordinary ask", async () => {
	const input = {
		...status,
		subject: "Should Maple renew?",
		prompt:
			"I recommend renewal. Check the source before asking for a fresh decision.",
		dueAt: "2020-10-20",
		metadata: { evidenceRefs: ["fictional-quote"] },
	};
	await expect(deckCreateGate(context, orgId, actor, input)).rejects.toThrow(
		"Withdrawn: check the source",
	);
	expect(
		await deckCreateGate(context, orgId, actor, {
			...input,
			prompt: "I recommend renewal: the quote is still valid.",
		}),
	).toMatchObject({ receipt: null });
});
