import type { AgentReplyDeliveryGatePolicy } from "@tedix/api-contract/schemas/agent-turn-triage";
import { describe, expect, it, vi } from "vite-plus/test";
import {
	evaluateReplyDraftGate,
	scoreReplyDraftGate,
} from "./reply-draft-gate";

const GATE: AgentReplyDeliveryGatePolicy = {
	model: "@cf/cloudflare/clef-flash",
	questions: [
		{
			id: "reversible_step",
			instructions: "Reversible?",
			autoWhen: { gte: 0.8 },
		},
		{ id: "needs_human", instructions: "Needs human?", autoWhen: { lte: 0.3 } },
	],
};

function env(run: (...args: unknown[]) => Promise<unknown>) {
	return { AI: { run: vi.fn(run) } } as unknown as Parameters<
		typeof evaluateReplyDraftGate
	>[0];
}

describe("scoreReplyDraftGate", () => {
	it.each([
		[{ reversible_step: 0.8, needs_human: 0.3 }, "pass", [true, true]],
		[{ reversible_step: 0.79, needs_human: 0.3 }, "fail", [false, true]],
		[{ reversible_step: 0.9, needs_human: 0.31 }, "fail", [true, false]],
		[{ reversible_step: 0.9 }, "fail", [true, false]],
	])("scores %o as %s at the thresholds", (labels, status, passes) => {
		const result = scoreReplyDraftGate(GATE, labels);
		expect(result.status).toBe(status);
		expect(result.checks.map((check) => check.pass)).toEqual(passes);
	});
});

describe("evaluateReplyDraftGate", () => {
	it("asks Clef about the agent message and the draft", async () => {
		const e = env(async () => ({
			answers: {
				reversible_step: { type: "noul", noul: 0.9 },
				needs_human: { type: "noul", noul: 0.1 },
			},
		}));
		const result = await evaluateReplyDraftGate(e, {
			gate: GATE,
			agentMessage: "x".repeat(9_000),
			draftReply: "Continue.",
		});
		expect(result).toMatchObject({ status: "pass", model: GATE.model });
		const [model, input] = (e.AI.run as ReturnType<typeof vi.fn>).mock
			.calls[0] as [string, { state: Record<string, string> }];
		expect(model).toBe(GATE.model);
		expect(input.state.draft_reply).toBe("Continue.");
		expect(input.state.agent_message).toMatch(/^x{8000}\n\[truncated\]$/);
	});

	it("is unavailable on error, timeout, or a missing answer", async () => {
		for (const run of [
			async () => {
				throw new Error("boom");
			},
			() => new Promise(() => undefined),
			async () => ({
				answers: { reversible_step: { type: "noul", noul: 0.9 } },
			}),
		]) {
			const result = await evaluateReplyDraftGate(env(run), {
				gate: GATE,
				agentMessage: "Commit?",
				draftReply: "Yes.",
				timeoutMs: 5,
			});
			expect(result).toMatchObject({ status: "unavailable", checks: [] });
		}
	});
});
