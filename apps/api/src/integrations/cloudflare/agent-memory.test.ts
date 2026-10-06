import { describe, expect, it, vi } from "vite-plus/test";
import {
	agentMemoryFactSessionId,
	agentMemoryOrgProfileName,
	agentMemoryTediProfileName,
	deleteCanonicalMemoryProjection,
	factIdFromAgentMemorySession,
	projectCanonicalMemory,
	reconcileCanonicalMemoryProjection,
	recallCanonicalMemoryCandidates,
	startRelevanceRecall,
} from "./agent-memory";

const FACT_A = "11111111-1111-4111-8111-111111111111";
const FACT_B = "22222222-2222-4222-8222-222222222222";

function namespace() {
	const profiles = new Map<string, AgentMemoryProfile>();
	const getProfile = vi.fn(async (name: string) => {
		let profile = profiles.get(name);
		if (!profile) {
			profile = {
				deleteSession: vi.fn(async () => undefined),
				remember: vi.fn(async ({ content, sessionId }) => ({
					id: "memory",
					type: "fact",
					summary: content,
					content,
					sessionId: sessionId ?? null,
					createdAt: new Date(0),
					updatedAt: new Date(0),
				})),
				recall: vi.fn(async () => ({ count: 0, answer: "", candidates: [] })),
			} as unknown as AgentMemoryProfile;
			profiles.set(name, profile);
		}
		return profile;
	});
	return {
		binding: { getProfile } as unknown as AgentMemoryNamespace,
		getProfile,
		profiles,
	};
}

describe("Agent Memory canonical projection", () => {
	it("uses bounded deterministic profile and fact session names", () => {
		expect(agentMemoryOrgProfileName("org-1")).toBe("org-org-1");
		expect(agentMemoryTediProfileName("org-1", "tedi-1")).toBe(
			"org-org-1-tedi-tedi-1",
		);
		expect(agentMemoryFactSessionId(FACT_A)).toBe(`fact:${FACT_A}`);
		expect(factIdFromAgentMemorySession(`fact:${FACT_A}`)).toBe(FACT_A);
		expect(factIdFromAgentMemorySession("conversation:unsafe")).toBeNull();
	});

	it("replaces one deterministic session with an explicit memory", async () => {
		const mock = namespace();
		await projectCanonicalMemory(mock.binding, "org-org-1", {
			factId: FACT_A,
			content: "Use D1 as canonical memory.",
			factType: "knowledge",
			confidence: 0.9,
		});
		const profile = mock.profiles.get("org-org-1")!;
		expect(profile.deleteSession).toHaveBeenCalledWith(`fact:${FACT_A}`);
		expect(profile.remember).toHaveBeenCalledWith(
			expect.objectContaining({ sessionId: `fact:${FACT_A}` }),
		);
	});

	it("returns only deterministic fact candidates and deduplicates profiles", async () => {
		const mock = namespace();
		const org = await mock.getProfile("org-org-1");
		const tedi = await mock.getProfile("org-org-1-tedi-tedi-1");
		vi.mocked(org.recall).mockResolvedValue({
			count: 2,
			answer: "must not be consumed",
			candidates: [
				{ id: "a", summary: "a", sessionId: `fact:${FACT_A}`, score: 0.7 },
				{ id: "x", summary: "x", sessionId: "raw-session", score: 1 },
			],
		});
		vi.mocked(tedi.recall).mockResolvedValue({
			count: 2,
			answer: "also ignored",
			candidates: [
				{ id: "a2", summary: "a2", sessionId: `fact:${FACT_A}`, score: 0.9 },
				{ id: "b", summary: "b", sessionId: `fact:${FACT_B}`, score: 0.8 },
			],
		});
		expect(
			await recallCanonicalMemoryCandidates(mock.binding, {
				orgId: "org-1",
				tediId: "tedi-1",
				query: "canonical memory",
				limit: 2,
			}),
		).toEqual([
			{ factId: FACT_A, score: 0.9 },
			{ factId: FACT_B, score: 0.8 },
		]);
	});

	it("ignores no-match neighbors while retaining matches from another profile", async () => {
		const mock = namespace();
		const org = await mock.getProfile("org-org-1");
		const tedi = await mock.getProfile("org-org-1-tedi-tedi-1");
		vi.mocked(org.recall).mockResolvedValue({
			count: 1,
			answer: "  ",
			candidates: [
				{
					id: "a",
					summary: "irrelevant",
					sessionId: `fact:${FACT_A}`,
					score: 1,
				},
			],
		});
		vi.mocked(tedi.recall).mockResolvedValue({
			count: 1,
			answer: "A matching memory",
			candidates: [
				{
					id: "b",
					summary: "relevant",
					sessionId: `fact:${FACT_B}`,
					score: 0.5,
				},
			],
		});
		expect(
			await recallCanonicalMemoryCandidates(mock.binding, {
				orgId: "org-1",
				query: "query",
				limit: 2,
			}),
		).toEqual([]);
		expect(
			await recallCanonicalMemoryCandidates(mock.binding, {
				orgId: "org-1",
				tediId: "tedi-1",
				query: "query",
				limit: 2,
			}),
		).toEqual([{ factId: FACT_B, score: 0.5 }]);
	});

	it("deletes a canonical fact session from every selected profile", async () => {
		const mock = namespace();
		await deleteCanonicalMemoryProjection(
			mock.binding,
			["org-org-1", "org-org-1-tedi-tedi-1"],
			FACT_A,
		);
		for (const profile of mock.profiles.values()) {
			expect(profile.deleteSession).toHaveBeenCalledWith(`fact:${FACT_A}`);
		}
	});

	it("reconciles blocked D1 lifecycle state by deleting instead of remembering", async () => {
		const mock = namespace();
		await reconcileCanonicalMemoryProjection(mock.binding, {
			factId: FACT_A,
			orgId: "org-1",
			memoryScope: "org",
			usePolicy: "do_not_inject_automatically",
			reviewStatus: "restricted",
			content: "Must not be projected",
			factType: "knowledge",
			confidence: 0.9,
		});
		const profile = mock.profiles.get("org-org-1")!;
		expect(profile.deleteSession).toHaveBeenCalledWith(`fact:${FACT_A}`);
		expect(profile.remember).not.toHaveBeenCalled();
	});
});

describe("Agent Memory diagnostics", () => {
	it("reports a failed remember stage without logging fact content", async () => {
		const mock = namespace();
		const profile = await mock.getProfile("org-org-1");
		vi.mocked(profile.remember).mockRejectedValue(
			new Error("private memory content", {
				cause: new TypeError("provider unavailable"),
			}),
		);
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await expect(
				projectCanonicalMemory(mock.binding, "org-org-1", {
					factId: FACT_A,
					content: "private memory content",
					factType: "fact",
					confidence: 0.9,
				}),
			).rejects.toThrow("private memory content");
			expect(log).toHaveBeenCalledWith(
				expect.objectContaining({
					component: "api.agent-memory",
					operation: "projection",
					stage: "remember",
					totalMs: expect.any(Number),
					exception: { type: "Error", cause: { type: "TypeError" } },
				}),
			);
			expect(JSON.stringify(log.mock.calls)).not.toMatch(
				/private memory content|provider unavailable|org-org-1|11111111/,
			);
		} finally {
			log.mockRestore();
		}
	});
	it("records recall duration and canonical candidate count without raw query or answer", async () => {
		const mock = namespace();
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			await recallCanonicalMemoryCandidates(mock.binding, {
				orgId: "org-1",
				query: "private query",
				limit: 3,
			});
			expect(log).toHaveBeenCalledWith(
				"[agent-memory.recall] complete",
				expect.objectContaining({
					totalMs: expect.any(Number),
					candidateCount: 0,
					canonicalCandidateCount: 0,
				}),
			);
			expect(JSON.stringify(log.mock.calls)).not.toContain("private query");
		} finally {
			log.mockRestore();
		}
	});

	it("reports direct recall failure topology without query or profile identity", async () => {
		const mock = namespace();
		const profile = await mock.getProfile("org-org-1");
		vi.mocked(profile.recall).mockRejectedValue(new Error("private query"));
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await expect(
				recallCanonicalMemoryCandidates(mock.binding, {
					orgId: "org-1",
					query: "private query",
					limit: 3,
				}),
			).rejects.toThrow("private query");
			expect(log).toHaveBeenCalledWith(
				expect.objectContaining({
					operation: "recall",
					stage: "recall",
					exception: { type: "Error" },
				}),
			);
			expect(JSON.stringify(log.mock.calls)).not.toMatch(
				/private query|org-org-1|org-1/,
			);
		} finally {
			log.mockRestore();
		}
	});

	it("returns no candidates after a failed Home recall without leaking its error", async () => {
		const mock = namespace();
		mock.getProfile.mockRejectedValue(new Error("private home query"));
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await expect(
				startRelevanceRecall(mock.binding, {
					orgId: "org-1",
					query: "private home query",
					limit: 3,
				}),
			).resolves.toEqual([]);
			expect(log).toHaveBeenCalledWith(
				expect.objectContaining({
					operation: "recall",
					stage: "get_profile",
					exception: { type: "Error" },
				}),
			);
			expect(log).toHaveBeenCalledWith(
				expect.objectContaining({
					operation: "relevance_recall",
					stage: "fallback",
					exception: { type: "Error" },
				}),
			);
			expect(JSON.stringify(log.mock.calls)).not.toMatch(
				/private home query|org-org-1|org-1/,
			);
		} finally {
			log.mockRestore();
		}
	});
});
