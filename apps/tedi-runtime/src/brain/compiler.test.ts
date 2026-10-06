/**
 * LLM compile provenance mapping.
 *
 * The compile prompt allows the model to SKIP patterns (rule 7: "return fewer
 * directives"), so directives must attach to input patterns via the echoed
 * "patternId" — never by array position. These tests pin that mapping:
 * a skipped middle pattern must not shift provenance (rationaleIds,
 * evidenceCount, successRate) onto the wrong pattern, unknown/duplicate
 * echoes are dropped with a warning, and the golden path is unchanged.
 */

import { describe, expect, it, vi } from "bun:test";
import { compileDirectives } from "./compiler.js";
import type { LlmClient } from "./llm-client.js";
import type { PlatformClient } from "./platform-client.js";

/**
 * Three promotable all-success patterns, in deterministic order:
 *   P1 = deployment (d-0..d-2), P2 = auth (a-0..a-2), P3 = billing (b-0..b-2).
 * Categories partition clustering, and identical actions cluster together.
 */
const RECORDS = [
	...Array.from({ length: 3 }, (_, i) => ({
		id: `d-${i}`,
		action: "Deploy the widget bundle to staging",
		category: "deployment",
		outcomeStatus: "success",
	})),
	...Array.from({ length: 3 }, (_, i) => ({
		id: `a-${i}`,
		action: "Authenticate the customer before any order action",
		category: "auth",
		outcomeStatus: "success",
	})),
	...Array.from({ length: 3 }, (_, i) => ({
		id: `b-${i}`,
		action: "Reconcile the invoice ledger before charging",
		category: "billing",
		outcomeStatus: "success",
	})),
];

function makePlatform() {
	return {
		getRationaleChain: vi.fn(async () => ({ data: RECORDS })),
		getContrastiveDecisions: vi.fn(async () => ({
			successes: [],
			failures: [],
		})),
	} as unknown as PlatformClient;
}

function makeLlm(directives: unknown[]) {
	return {
		chat: vi.fn(async () => ({ content: JSON.stringify({ directives }) })),
	};
}

function makeLogger() {
	const lines: string[] = [];
	return { lines, logger: { log: (msg: string) => lines.push(msg) } };
}

async function compile(llm: LlmClient, logger: { log(msg: string): void }) {
	return compileDirectives({
		platform: makePlatform(),
		llm,
		model: "test-model",
		logger,
	});
}

describe("llmCompile provenance mapping", () => {
	it("golden path: all three patterns echoed → provenance maps 1:1", async () => {
		const { logger } = makeLogger();
		const llm = makeLlm([
			{
				patternId: "P1",
				strength: "always",
				directive: "Always deploy the widget bundle to staging first",
				category: "deployment",
			},
			{
				patternId: "P2",
				strength: "always",
				directive: "Always authenticate the customer before order actions",
				category: "auth",
			},
			{
				patternId: "P3",
				strength: "always",
				directive: "Always reconcile the invoice ledger before charging",
				category: "billing",
			},
		]);
		const directives = await compile(llm, logger);

		expect(directives).toHaveLength(3);
		expect(directives.map((d) => d.rationaleIds)).toEqual([
			["d-0", "d-1", "d-2"],
			["a-0", "a-1", "a-2"],
			["b-0", "b-1", "b-2"],
		]);
		expect(directives.map((d) => d.category)).toEqual([
			"deployment",
			"auth",
			"billing",
		]);
		for (const d of directives) {
			expect(d.evidenceCount).toBe(3);
			expect(d.successRate).toBe(1);
		}

		// The prompt labels each pattern with the id the model must echo.
		const userMessage = (
			llm.chat.mock.calls[0]![0] as {
				messages: Array<{ role: string; content: string }>;
			}
		).messages.find((m) => m.role === "user")!.content;
		expect(userMessage).toContain("Pattern P1 ");
		expect(userMessage).toContain("Pattern P3 ");
	});

	it("model skips the middle pattern → remaining directives attach to the RIGHT patterns", async () => {
		const { lines, logger } = makeLogger();
		const llm = makeLlm([
			{
				patternId: "P1",
				strength: "always",
				directive: "Always deploy the widget bundle to staging first",
			},
			// P2 (auth) skipped by the model as too vague.
			{
				patternId: "P3",
				strength: "always",
				directive: "Always reconcile the invoice ledger before charging",
			},
		]);
		const directives = await compile(llm, logger);

		expect(directives).toHaveLength(2);
		// Positional mapping would attribute the P3 directive to the auth
		// pattern (a-0..a-2); identifier mapping must attach it to billing.
		expect(directives[0]!.rationaleIds).toEqual(["d-0", "d-1", "d-2"]);
		expect(directives[0]!.category).toBe("deployment");
		expect(directives[1]!.rationaleIds).toEqual(["b-0", "b-1", "b-2"]);
		expect(directives[1]!.category).toBe("billing");
		expect(lines.filter((l) => l.includes("dropped"))).toHaveLength(0);
	});

	it("unknown pattern id → dropped with warning, others still map", async () => {
		const { lines, logger } = makeLogger();
		const llm = makeLlm([
			{
				patternId: "P1",
				strength: "always",
				directive: "Always deploy the widget bundle to staging first",
			},
			{
				patternId: "P9",
				strength: "always",
				directive: "Always do something invented",
			},
			{
				patternId: "P3",
				strength: "always",
				directive: "Always reconcile the invoice ledger before charging",
			},
		]);
		const directives = await compile(llm, logger);

		expect(directives).toHaveLength(2);
		expect(directives.map((d) => d.rationaleIds)).toEqual([
			["d-0", "d-1", "d-2"],
			["b-0", "b-1", "b-2"],
		]);
		expect(lines.some((l) => l.includes('unknown pattern id "P9"'))).toBe(true);
	});

	it("duplicate pattern id → second echo dropped with warning", async () => {
		const { lines, logger } = makeLogger();
		const llm = makeLlm([
			{
				patternId: "P1",
				strength: "always",
				directive: "Always deploy the widget bundle to staging first",
			},
			{
				patternId: "P1",
				strength: "never",
				directive: "Never deploy the widget bundle to staging",
			},
		]);
		const directives = await compile(llm, logger);

		expect(directives).toHaveLength(1);
		expect(directives[0]!.strength).toBe("always");
		expect(directives[0]!.rationaleIds).toEqual(["d-0", "d-1", "d-2"]);
		expect(
			lines.some((l) => l.includes('duplicate directive for pattern id "P1"')),
		).toBe(true);
	});

	it("no directive carries a usable pattern id → falls back rather than returning nothing", async () => {
		const { lines, logger } = makeLogger();
		const llm = makeLlm([
			{
				strength: "always",
				directive: "Always deploy the widget bundle to staging first",
			},
		]);
		const directives = await compile(llm, logger);

		// fallbackCompile emits one directive per promoted pattern.
		expect(directives).toHaveLength(3);
		expect(directives.map((d) => d.rationaleIds)).toEqual([
			["d-0", "d-1", "d-2"],
			["a-0", "a-1", "a-2"],
			["b-0", "b-1", "b-2"],
		]);
		expect(lines.some((l) => l.includes("using fallback compilation"))).toBe(
			true,
		);
	});
});
