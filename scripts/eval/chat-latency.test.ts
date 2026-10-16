import { describe, expect, test } from "bun:test";
import {
	checkOutput,
	fixtures,
	percentiles,
	phases,
	summarize,
	unwrap,
} from "./chat-latency.mjs";

describe("live chat eval accounting", () => {
	test("question samples are counted once per group", () => {
		expect(
			summarize([{ operation: "question", ok: true, wallMs: 100 }]).question
				.count,
		).toBe(1);
	});
	test("fixed coverage is ten writes and ten questions, with all output kinds and edits", () => {
		expect(fixtures).toHaveLength(20);
		expect(fixtures.filter((f) => f.kind)).toHaveLength(10);
		expect(fixtures.filter((f) => f.topic)).toHaveLength(10);
		expect(
			new Set(fixtures.filter((f) => f.target).map((f) => f.kind)),
		).toEqual(new Set(["document", "sheet", "presentation"]));
	});
	test("nearest-rank p50/p90 exclude missing measurements", () => {
		expect(
			percentiles([
				null,
				undefined,
				NaN,
				...Array.from({ length: 20 }, (_, i) => i + 1),
			]),
		).toEqual({ n: 20, p50: 10, p90: 18 });
		expect(percentiles([null])).toEqual({ n: 0, p50: null, p90: null });
	});
	test("hedge token time includes launch delay, never substitutes a missing token", () => {
		expect(
			phases({
				kernelRouteHedge: {
					winner: "hedge",
					afterMs: 5000,
					hedgeFirstPartialMs: 2000,
				},
			}).routeFirstTokenMs,
		).toBe(7000);
		expect(
			phases({
				kernelRouteHedge: {
					winner: "hedge",
					afterMs: 5000,
					hedgeFirstPartialMs: null,
				},
			}).routeFirstTokenMs,
		).toBeNull();
	});
	test("calculates phase durations and execution from durable timestamps", () => {
		const result = phases(
			{
				kernelTurnTimings: {
					turnType: "write_proposal",
					stages: {
						routePlanStarted: 10,
						plannerFirstProgress: 30,
						routePlanEnded: 130,
						writeProposalPlanStarted: 130,
						writeProposalPlanEnded: 230,
					},
				},
				kernelWriteExecutedAt: "2026-01-01T00:00:00Z",
			},
			"2026-01-01T00:00:02Z",
		);
		expect(result).toMatchObject({
			contextMs: 20,
			routeDecisionMs: 100,
			writePlanMs: 100,
			executeMs: 2000,
			firstAnswerMs: null,
		});
	});
	test("unwraps Code Mode and inspect envelopes", () => {
		expect(
			unwrap({ result: { result: { run: { id: "fictional" } } } }),
		).toEqual({ run: { id: "fictional" } });
	});
	test("an edit must preserve expected content and advance the same output", () => {
		const fixture = { kind: "document", contains: ["Welcome", "Fresh bread"] };
		const target = { id: "fictional", revision: 1 };
		const detail = {
			output: { id: "fictional" },
			currentRevision: {
				revision: 2,
				content: {
					kind: "document",
					blocks: [{ text: "Welcome. Fresh bread." }],
				},
			},
		};
		expect(() => checkOutput(fixture, detail, target)).not.toThrow();
		expect(() =>
			checkOutput(
				fixture,
				{
					...detail,
					currentRevision: { ...detail.currentRevision, revision: 1 },
				},
				target,
			),
		).toThrow("advance");
		expect(() =>
			checkOutput(fixture, { ...detail, output: { id: "other" } }, target),
		).toThrow("advance");
		expect(() =>
			checkOutput(
				fixture,
				{
					...detail,
					currentRevision: {
						revision: 2,
						content: { kind: "document", blocks: [{ text: "Fresh bread" }] },
					},
				},
				target,
			),
		).toThrow("Welcome");
		expect(() =>
			checkOutput(fixture, { ...detail, currentRevision: null }, target),
		).toThrow("canonical");
	});
});
