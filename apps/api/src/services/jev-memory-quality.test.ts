import { describe, it, expect, vi } from "vite-plus/test";
import {
	buildMemoryQualityRequest,
	interpretMemoryQuality,
	evaluateMemoryQuality,
	extractMemoryQualityEvidence,
	memoryQualityDisposition,
	memorySourceEvidenceHash,
	shouldEvaluateAfterTurnMemory,
} from "./jev-memory-quality";
import { MEMORY_QUALITY_CASES } from "../../eval/jev/memory-quality";
const executor = vi.hoisted(() => vi.fn());
const getOrganization = vi.hoisted(() =>
	vi.fn(async () => ({ metadata: {} as Record<string, unknown> })),
);
vi.mock("./jev-judgment", () => ({ executeJevJudgment: executor }));
vi.mock("@tedix/db/queries/organizations", () => ({
	getOrganizationById: getOrganization,
}));
function answers(supported: number, durable: number, useful: number) {
	return {
		supported: { type: "noul" as const, noul: supported },
		durable: { type: "noul" as const, noul: durable },
		useful: { type: "noul" as const, noul: useful },
	};
}
describe("advisory memory quality", () => {
	it("strips request-only user evidence and untrusted verdicts before persistence", () => {
		expect(
			extractMemoryQualityEvidence({
				producer: "afterTurn",
				sourceEvidence: "The user's original request",
				memoryQuality: { verdict: "durable_candidate" },
			}),
		).toEqual({
			evidence: "The user's original request",
			metadata: { producer: "afterTurn" },
		});
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
		expect(memoryQualityDisposition("transient_or_unsupported").restrict).toBe(
			true,
		);
		for (const verdict of [
			"durable_candidate",
			"uncertain",
			"unavailable",
			"insufficient_evidence",
		] as const) {
			expect(memoryQualityDisposition(verdict).restrict).toBe(false);
		}
	});
	it("requires support, durability and usefulness independently", () => {
		expect(interpretMemoryQuality(answers(0.9, 0.9, 0.9))).toBe(
			"durable_candidate",
		);
		expect(interpretMemoryQuality(answers(0.61, 0.84, 0.62))).toBe(
			"durable_candidate",
		);
		expect(interpretMemoryQuality(answers(0.59, 0.99, 0.99))).toBe("uncertain");
		for (const values of [
			[0.1, 0.9, 0.9],
			[0.9, 0.1, 0.9],
			[0.9, 0.9, 0.1],
		])
			expect(
				interpretMemoryQuality(
					answers(...(values as [number, number, number])),
				),
			).toBe("transient_or_unsupported");
		expect(interpretMemoryQuality(answers(0.9, 0.6, 0.9))).toBe("uncertain");
		expect(interpretMemoryQuality({})).toBe("uncertain");
		expect(interpretMemoryQuality(answers(NaN, 1, 1))).toBe("uncertain");
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
			}),
		).rejects.toThrow("receipt unavailable");
		expect(executor.mock.calls[0]![0]).toMatchObject({
			source: "system:memory-quality",
			billingSource: "system",
		});
	});
	it("does not dispatch against an explicit tenant denial", async () => {
		getOrganization.mockResolvedValueOnce({
			metadata: { jev: { enabled: false } },
		});
		executor.mockClear();
		expect(
			await evaluateMemoryQuality({
				fact: "A durable preference",
				evidence: "Please retain this preference in future sessions.",
				db: {} as never,
				env: {} as never,
				context: { organizationId: "org" },
			}),
		).toBe("unavailable");
		expect(executor).not.toHaveBeenCalled();
	});
	it("uses the tenant's configured route and timeout", async () => {
		getOrganization.mockResolvedValueOnce({
			metadata: {
				jev: { enabled: true, transport: "direct", timeoutMs: 1500 },
			},
		});
		executor.mockResolvedValueOnce(null);
		await evaluateMemoryQuality({
			fact: "A durable preference",
			evidence: "Please retain this preference in future sessions.",
			db: {} as never,
			env: {} as never,
			context: { organizationId: "org" },
		});
		expect(executor).toHaveBeenLastCalledWith(
			expect.objectContaining({ transport: "direct", timeoutMs: 1500 }),
		);
	});
});
