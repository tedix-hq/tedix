import { describe, expect, it, vi } from "vite-plus/test";
import {
	buildSkillUtilityRequest,
	interpretSkillUtility,
	assessSkillUtility,
} from "./jev-skill-utility";

const mocks = vi.hoisted(() => ({ judge: vi.fn() }));
vi.mock("./jev-judgment", () => ({ executeJevJudgment: mocks.judge }));

const evidence = {
	id: "66666666-6666-4666-8666-666666666666",
	observedState: "confirmed" as const,
	effectNote: "A recipient confirmed the report appeared in their inbox.",
	evidenceRef: "mailbox://receipt/1",
};

describe("Jev skill effect alignment", () => {
	it("rejects absent or oversized evidence without clipping away negation", () => {
		expect(
			buildSkillUtilityRequest({ doneLooksLike: "", observations: [evidence] }),
		).toBeNull();
		expect(
			buildSkillUtilityRequest({
				doneLooksLike: "Send report",
				observations: [],
			}),
		).toBeNull();
		expect(
			buildSkillUtilityRequest({
				doneLooksLike: "x".repeat(13000),
				observations: [evidence],
			}),
		).toBeNull();
	});

	it("abstains on invalid, conflicting, or low-support model answers", () => {
		expect(
			interpretSkillUtility({
				supports: { type: "noul", noul: 0.95 },
				contradicts: { type: "noul", noul: 0.95 },
			}),
		).toBe("unknown");
		expect(
			interpretSkillUtility({
				supports: { type: "noul", noul: 0.5 },
				contradicts: { type: "noul", noul: 0.1 },
			}),
		).toBe("unknown");
		expect(
			interpretSkillUtility({
				supports: { type: "noul", noul: Number.NaN },
				contradicts: { type: "noul", noul: 0 },
			}),
		).toBe("unknown");
		expect(
			interpretSkillUtility({
				supports: { type: "noul", noul: 0.9 },
				contradicts: { type: "noul", noul: 0.1 },
			}),
		).toBe("supports");
		expect(
			interpretSkillUtility({
				supports: { type: "noul", noul: 0.1 },
				contradicts: { type: "noul", noul: 0.9 },
			}),
		).toBe("contradicts");
	});

	it("uses one governed attributed judgment and never calls it for ineligible evidence", async () => {
		mocks.judge.mockReset();
		mocks.judge.mockResolvedValue({
			answers: {
				supports: { type: "noul", noul: 0.9 },
				contradicts: { type: "noul", noul: 0.1 },
			},
		});
		const base = {
			db: {} as never,
			env: {} as never,
			context: {
				organizationId: "org-1",
				tediId: "tedi-1",
				runId: "run-1",
				executionAttempts: [],
			},
			doneLooksLike: "The report arrives in the inbox",
			observations: [evidence],
			transport: "cloudflare" as const,
			timeoutMs: 2000,
		};
		expect(await assessSkillUtility({ ...base, observations: [] })).toBe(
			"unknown",
		);
		expect(mocks.judge).not.toHaveBeenCalled();
		expect(await assessSkillUtility(base)).toBe("supports");
		expect(mocks.judge).toHaveBeenCalledTimes(1);
		expect(mocks.judge).toHaveBeenCalledWith(
			expect.objectContaining({
				source: "skills:effect-alignment",
				billingSource: "system",
				sessionType: "tedi",
				transport: "cloudflare",
				context: expect.objectContaining({
					organizationId: "org-1",
					tediId: "tedi-1",
					runId: "run-1",
				}),
			}),
		);
	});
});
