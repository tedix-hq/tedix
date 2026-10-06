/**
 * brain-digest.test.ts — unit tests for the two confirmed live defects:
 *
 * 1. SILENT FACT DROP: LLM may omit high-confidence facts under token pressure.
 *    Fixed by a post-LLM coverage check that appends missing facts verbatim in
 *    a "### additional facts" section and records budget-dropped fact ids.
 *
 * 2. DOMAIN MISMATCH: facts seeded with domain='benchmark' (a plain string name,
 *    not a UUID key in the id→name map) ended up in "### general" and the digest's
 *    domains array was empty. Fixed by treating the raw value as the name when
 *    the UUID map lookup misses.
 */

import { describe, expect, it } from "bun:test";
import { compileBrainDigest } from "./brain-digest.js";
import type { LlmClient } from "./llm-client.js";
import type { PlatformClient } from "./platform-client.js";

// ── helpers ───────────────────────────────────────────────────────────────────

type MinPlatform = Pick<PlatformClient, "getDomains" | "memorySearch">;

function makePlatform(
	facts: Array<{
		factId: string;
		summary: string;
		domain?: string;
		confidence?: number;
	}>,
	domainMap: Map<string, string> = new Map(),
): MinPlatform {
	return {
		getDomains: async () => domainMap,
		memorySearch: async (_query, _limit) => ({
			results: facts.map((f) => ({
				factId: f.factId,
				score: f.confidence ?? 0.9,
				fact: {
					id: f.factId,
					summary: f.summary,
					confidence: f.confidence ?? 0.9,
					domain: f.domain,
				},
			})),
		}),
	};
}

/**
 * An LLM stub that returns a digest string containing only the facts whose
 * summaries appear in the `include` set. Everything else is silently dropped —
 * mimicking the real LLM behaviour that triggered defect #1.
 */
function makeLlmStub(
	include: Set<string>,
	extraPrefix = "## Knowledge Digest\n\n### stub\n",
): LlmClient {
	return {
		chat: async ({ messages }) => {
			// Build a digest from the user message but only include `include` facts.
			const userMsg = messages.find((m) => m.role === "user")?.content ?? "";
			const lines = userMsg.split("\n").filter((line) => {
				if (!line.startsWith("- ")) return false;
				const body = line.slice(2);
				return [...include].some((token) =>
					body.toLowerCase().startsWith(token),
				);
			});
			const content = `${extraPrefix}${lines.join("\n")}`;
			// Return something >50 chars to pass the null-check in llmDigest.
			return { content: content.padEnd(60, " ") };
		},
	};
}

/** An LLM stub that echoes all facts back so no coverage gap is triggered. */
function makeEchoLlm(): LlmClient {
	return {
		chat: async ({ messages }) => {
			const userMsg = messages.find((m) => m.role === "user")?.content ?? "";
			return { content: `## Knowledge Digest\n\n${userMsg}` };
		},
	};
}

// ── Defect 1: silent fact drop ─────────────────────────────────────────────────

describe("coverage guarantee (defect 1 — silent fact drop)", () => {
	const allFacts = [
		{
			factId: "f1",
			summary: "ALPHA fact about the system architecture",
			confidence: 0.9,
			domain: "benchmark",
		},
		{
			factId: "f2",
			summary: "BETA fact about deployment pipeline config",
			confidence: 0.9,
			domain: "benchmark",
		},
		{
			factId: "f3",
			summary: "GAMMA fact about database connection pool",
			confidence: 0.9,
			domain: "benchmark",
		},
		{
			factId: "f4",
			summary: "DELTA fact about rate limiting thresholds",
			confidence: 0.9,
			domain: "benchmark",
		},
		{
			factId: "f5",
			summary: "EPSILON fact about auth token expiry policy",
			confidence: 0.9,
			domain: "benchmark",
		},
		{
			factId: "f6",
			summary: "ZETA fact about worker memory limits",
			confidence: 0.9,
			domain: "benchmark",
		},
	];

	it("appends facts that the LLM silently omitted", async () => {
		// LLM only includes f2–f6; silently drops f1 (ALPHA).
		const includedTokens = new Set([
			"beta fact",
			"gamma fact",
			"delta fact",
			"epsilon fact",
			"zeta fact",
		]);
		const platform = makePlatform(
			allFacts,
			new Map([["benchmark-uuid", "benchmark"]]),
		);
		const llm = makeLlmStub(includedTokens);

		const digest = await compileBrainDigest(platform, { llm, model: "stub" });

		expect(digest).not.toBeNull();
		expect(digest!.summary).toContain("### additional facts");
		// The dropped ALPHA fact must appear somewhere after the LLM section.
		expect(digest!.summary.toLowerCase()).toContain("alpha fact");
	});

	it("does NOT add additional facts when the LLM included everything", async () => {
		const platform = makePlatform(
			allFacts,
			new Map([["benchmark-uuid", "benchmark"]]),
		);
		const llm = makeEchoLlm();

		const digest = await compileBrainDigest(platform, { llm, model: "stub" });

		expect(digest).not.toBeNull();
		expect(digest!.summary).not.toContain("### additional facts");
		expect(digest!.droppedFactIds).toBeUndefined();
	});

	it("reuses an unchanged digest without another inference call", async () => {
		const platform = makePlatform(
			allFacts,
			new Map([["benchmark-uuid", "benchmark"]]),
		);
		let calls = 0;
		const llm = {
			async chat() {
				calls += 1;
				return {
					content:
						"## Knowledge Digest\n\n### benchmark\n" +
						allFacts.map((fact) => `- ${fact.summary}`).join("\n"),
				};
			},
		};

		const first = await compileBrainDigest(platform, { llm, model: "stub" });
		const second = await compileBrainDigest(platform, {
			llm,
			model: "stub",
			previousDigest: first,
		});

		expect(calls).toBe(1);
		expect(second).toBe(first);
		expect(first?.sourceFingerprint).toMatch(/^[a-f0-9]{64}$/);
	});

	it("records droppedFactIds when missing facts exceed MAX_APPENDED_FACTS (20)", async () => {
		// Build 25 facts; LLM will only echo the first 3.
		const manyFacts = Array.from({ length: 25 }, (_, i) => ({
			factId: `f${i}`,
			summary: `Fact number ${String(i).padStart(3, "0")} about important config value ${i}`,
			confidence: 0.9,
			domain: "benchmark",
		}));

		const includedTokens = new Set([
			"fact number 000",
			"fact number 001",
			"fact number 002",
		]);
		const platform = makePlatform(
			manyFacts,
			new Map([["benchmark-uuid", "benchmark"]]),
		);
		const llm = makeLlmStub(includedTokens);

		const digest = await compileBrainDigest(platform, { llm, model: "stub" });

		expect(digest).not.toBeNull();
		// 22 facts are missing from the LLM output; 20 are appended, 2 are dropped.
		expect(digest!.droppedFactIds).toBeDefined();
		expect(digest!.droppedFactIds!.length).toBeGreaterThan(0);
		// The appended section must be present.
		expect(digest!.summary).toContain("### additional facts");
	});

	it("appended facts carry confidence percentages", async () => {
		const includedTokens = new Set([
			"beta fact",
			"gamma fact",
			"delta fact",
			"epsilon fact",
			"zeta fact",
		]);
		const platform = makePlatform(allFacts, new Map());
		const llm = makeLlmStub(includedTokens);

		const digest = await compileBrainDigest(platform, { llm, model: "stub" });

		expect(digest).not.toBeNull();
		// Coverage section should show confidence (90% for 0.9).
		expect(digest!.summary).toMatch(/\(90%\)/);
	});
});

// ── Defect 2: domain mismatch ──────────────────────────────────────────────────

describe("domain resolution fallback (defect 2 — domain mismatch)", () => {
	it("resolves plain-name domain to itself when not found in UUID map", async () => {
		// Simulate API-seeded facts with domain='benchmark' (not a UUID).
		// The UUID map is empty, so the old code would fall back to undefined → 'general'.
		const facts = [
			{
				factId: "f1",
				summary: "System uses Redis for session caching",
				confidence: 0.9,
				domain: "benchmark",
			},
			{
				factId: "f2",
				summary: "Database pool max size is 20 connections",
				confidence: 0.9,
				domain: "benchmark",
			},
			{
				factId: "f3",
				summary: "API rate limit is 100 req/min per IP",
				confidence: 0.9,
				domain: "benchmark",
			},
		];
		const emptyDomainMap = new Map<string, string>();
		const platform = makePlatform(facts, emptyDomainMap);
		const llm = makeEchoLlm();

		const digest = await compileBrainDigest(platform, { llm, model: "stub" });

		expect(digest).not.toBeNull();
		// domains array must NOT be empty when facts carry a domain name.
		expect(digest!.domains).toContain("benchmark");
		// The domain section must be labelled 'benchmark', NOT 'general'.
		expect(digest!.summary).not.toContain("### general");
	});

	it("resolves UUID domain key to its mapped name correctly", async () => {
		const uuidKey = "550e8400-e29b-41d4-a716-446655440000";
		const facts = [
			{
				factId: "f1",
				summary: "Primary deployment target is Cloudflare Workers",
				confidence: 0.9,
				domain: uuidKey,
			},
			{
				factId: "f2",
				summary: "Secondary region is eu-west-1 for latency",
				confidence: 0.9,
				domain: uuidKey,
			},
			{
				factId: "f3",
				summary: "Failover SLA target is 99.9% uptime",
				confidence: 0.9,
				domain: uuidKey,
			},
		];
		const domainMap = new Map([[uuidKey, "infrastructure"]]);
		const platform = makePlatform(facts, domainMap);
		const llm = makeEchoLlm();

		const digest = await compileBrainDigest(platform, { llm, model: "stub" });

		expect(digest).not.toBeNull();
		expect(digest!.domains).toContain("infrastructure");
		expect(digest!.domains).not.toContain(uuidKey);
	});

	it("populates digest.domains from plain-name domains (not empty)", async () => {
		const facts = [
			{
				factId: "f1",
				summary: "Benchmark probe uses confidence 0.9 threshold",
				confidence: 0.9,
				domain: "benchmark",
			},
			{
				factId: "f2",
				summary: "Benchmark probe rotates facts every 24h",
				confidence: 0.9,
				domain: "benchmark",
			},
			{
				factId: "f3",
				summary: "Benchmark probe validates 6 probe facts minimum",
				confidence: 0.9,
				domain: "benchmark",
			},
		];
		const platform = makePlatform(facts, new Map());
		const llm = makeEchoLlm();

		const digest = await compileBrainDigest(platform, { llm, model: "stub" });

		expect(digest).not.toBeNull();
		// domains must be populated — was empty in the original defect.
		expect(digest!.domains.length).toBeGreaterThan(0);
		expect(digest!.domains).toContain("benchmark");
	});

	it("falls through to 'general' only when fact has no domain at all", async () => {
		const facts = [
			{
				factId: "f1",
				summary: "General config value alpha equals 42",
				confidence: 0.9,
			},
			{
				factId: "f2",
				summary: "General config value beta equals 100",
				confidence: 0.9,
			},
			{
				factId: "f3",
				summary: "General config value gamma equals 5s timeout",
				confidence: 0.9,
			},
		];
		// No domain field on any fact.
		const platform = makePlatform(facts, new Map());
		const llm = makeEchoLlm();

		const digest = await compileBrainDigest(platform, { llm, model: "stub" });

		expect(digest).not.toBeNull();
		// Bucket must be 'general' since no domain was set.
		// (domains array excludes 'general' because it's the fallback label, not
		//  a real fact.domain value — but the summary should contain the heading.)
		expect(digest!.summary).toContain("### general");
	});
});
