import { describe, it, expect, vi } from "vite-plus/test";
import {
	buildMemoryQualityRequest,
	interpretMemoryQuality,
	evaluateMemoryQuality,
	extractMemoryQualityEvidence,
	formatMemorySourceEvidence,
	memoryQualityDisposition,
	memorySourceEvidenceHash,
	shouldEvaluateAfterTurnMemory,
} from "./jev-memory-quality";
import { resolveMemoryJudgmentRoute } from "./jev-memory-policy";
import { MEMORY_QUALITY_CASES } from "../../eval/jev/memory-quality";
const executor = vi.hoisted(() => vi.fn());
const getOrganization = vi.hoisted(() =>
	vi.fn(async () => ({ metadata: {} as Record<string, unknown> })),
);
vi.mock("./jev-judgment", () => ({ executeJevJudgment: executor }));
vi.mock("@tedix/db/queries/organizations", () => ({
	getOrganizationById: getOrganization,
}));
const route = {
	mode: "shadow" as const,
	model: "@cf/cloudflare/clef-flash" as const,
	transport: "cloudflare" as const,
	timeoutMs: 2000,
};
function answers(supported: number) {
	return { supported: { type: "noul" as const, noul: supported } };
}
describe("advisory memory quality", () => {
	it("strips request-only user evidence and untrusted verdicts before persistence", () => {
		expect(
			extractMemoryQualityEvidence({
				producer: "afterTurn",
				sourceEvidence: "The user's original request",
				memoryQuality: { verdict: "supported" },
			}),
		).toEqual({
			evidence: "The user's original request",
			metadata: { producer: "afterTurn" },
		});
	});
	it("judges the turn the Observer saw and never persists it", () => {
		const sourceEvidence = {
			userTurn: "Summarize the Example Co invoices.",
			assistantReply:
				"The invoice tool reported 3 open invoices for Example Co.",
			toolReceipts: [
				{ tool: "invoices_list", outcome: "succeeded" as const },
				{ tool: "crm_lookup", outcome: "failed" as const },
			],
		};
		const extracted = extractMemoryQualityEvidence(
			{ producer: "afterTurn", sourceEvidence: "legacy user turn" },
			sourceEvidence,
		);
		expect(extracted.metadata).toEqual({ producer: "afterTurn" });
		expect(extracted.evidence).toBe(
			[
				"## User turn\nSummarize the Example Co invoices.",
				"## Assistant reply (the worker's report of this turn, including what its tools returned)\nThe invoice tool reported 3 open invoices for Example Co.",
				"## Tool receipts (recorded by the runtime)\n- invoices_list: succeeded\n- crm_lookup: failed",
			].join("\n\n"),
		);
		expect(formatMemorySourceEvidence({ userTurn: "Only the request" })).toBe(
			"## User turn\nOnly the request",
		);
		expect(extractMemoryQualityEvidence(null, sourceEvidence).metadata).toBe(
			null,
		);
	});
	it("records a source fingerprint without keeping the excerpt", async () => {
		expect(await memorySourceEvidenceHash("")).toBeNull();
		expect(await memorySourceEvidenceHash("user source")).toMatch(
			/^[a-f0-9]{64}$/,
		);
	});
	it("assesses only observations from the trusted runtime bridge", () => {
		const trusted = {
			source: "observation://2026-09-24/11:00/0",
			producer: "afterTurn",
			authType: "service-binding",
			forwardedTediId: "tedi-1",
		};
		expect(shouldEvaluateAfterTurnMemory(trusted)).toBe(true);
		expect(
			shouldEvaluateAfterTurnMemory({ ...trusted, authType: "apikey" }),
		).toBe(false);
		expect(
			shouldEvaluateAfterTurnMemory({ ...trusted, source: "doc://example" }),
		).toBe(false);
		expect(
			shouldEvaluateAfterTurnMemory({ ...trusted, forwardedTediId: null }),
		).toBe(false);
	});
	it("restricts only an explicit adverse verdict", () => {
		expect(memoryQualityDisposition("unsupported").restrict).toBe(true);
		for (const verdict of [
			"supported",
			"uncertain",
			"unavailable",
			"insufficient_evidence",
		] as const) {
			expect(memoryQualityDisposition(verdict).restrict).toBe(false);
		}
	});
	it("restricts only clearly unsupported facts", () => {
		expect(interpretMemoryQuality(answers(0.9))).toBe("supported");
		expect(interpretMemoryQuality(answers(0.11))).toBe("supported");
		expect(interpretMemoryQuality(answers(0.1))).toBe("unsupported");
		expect(interpretMemoryQuality(answers(0))).toBe("unsupported");
		expect(interpretMemoryQuality({})).toBe("uncertain");
		expect(interpretMemoryQuality(answers(NaN))).toBe("uncertain");
	});
	it("never truncates evidence or dispatches without evidence", async () => {
		expect(
			buildMemoryQualityRequest({
				fact: "A fact",
				evidence: "界".repeat(10000),
			}),
		).toBeNull();
		expect(
			await evaluateMemoryQuality({
				fact: "A fact",
				evidence: "",
				db: {} as never,
				env: {} as never,
				context: { organizationId: "org" },
				route,
			}),
		).toBe("insufficient_evidence");
		expect(executor).not.toHaveBeenCalled();
	});
	it("keeps fixed labeled synthetic cases within provider bounds", () => {
		for (const fixture of MEMORY_QUALITY_CASES) {
			const request = buildMemoryQualityRequest(fixture);
			if (fixture.evidence) {
				expect(request).not.toBeNull();
				expect(
					new TextEncoder().encode(JSON.stringify(request)).byteLength,
				).toBeLessThan(28000);
			} else expect(request).toBeNull();
		}
	});
	it("uses shared accounting and preserves persistence errors", async () => {
		executor.mockRejectedValueOnce(new Error("receipt unavailable"));
		await expect(
			evaluateMemoryQuality({
				fact: "A fact",
				evidence: "Source fact",
				db: {} as never,
				env: {} as never,
				context: { organizationId: "org" },
				route,
			}),
		).rejects.toThrow("receipt unavailable");
		expect(executor.mock.calls[0]![0]).toMatchObject({
			source: "system:memory-quality",
			billingSource: "system",
		});
	});
	it("routes memory quality to Clef and enforces it by default", async () => {
		const resolve = () =>
			resolveMemoryJudgmentRoute({} as never, "org", "memoryQuality");
		expect(await resolve()).toEqual({ ...route, mode: "enforce" });
		getOrganization.mockResolvedValueOnce({
			metadata: { jev: { enabled: false } },
		});
		expect(await resolve()).toBeNull();
		getOrganization.mockResolvedValueOnce({
			metadata: {
				jev: {
					transport: "direct",
					timeoutMs: 1500,
					purposes: { memoryQuality: { mode: "shadow" } },
				},
			},
		});
		// Clef exists only on Workers AI, so a tenant direct route cannot apply to it.
		expect(await resolve()).toEqual({ ...route, timeoutMs: 1500 });
		getOrganization.mockResolvedValueOnce({
			metadata: {
				jev: {
					transport: "direct",
					purposes: { memoryQuality: { model: "typesafe/jev" } },
				},
			},
		});
		expect(await resolve()).toMatchObject({
			model: "typesafe/jev",
			transport: "direct",
		});
	});
	it("dispatches on the resolved route", async () => {
		executor.mockResolvedValueOnce(null);
		await evaluateMemoryQuality({
			fact: "A durable preference",
			evidence: "Please retain this preference in future sessions.",
			db: {} as never,
			env: {} as never,
			context: { organizationId: "org" },
			route: { ...route, timeoutMs: 1500 },
		});
		expect(executor).toHaveBeenLastCalledWith(
			expect.objectContaining({
				model: "@cf/cloudflare/clef-flash",
				transport: "cloudflare",
				timeoutMs: 1500,
			}),
		);
	});
});
