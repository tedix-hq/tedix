import { describe, expect, it } from "vite-plus/test";
import { renderComparison, type TrajectoryReport } from "./trajectory-eval";

function report(
	commit: string,
	metrics: TrajectoryReport["metrics"],
): TrajectoryReport {
	return {
		schemaVersion: 1,
		generatedAt: "2026-10-27T00:00:00.000Z",
		commit,
		model: "@cf/openai/gpt-oss-120b",
		pricing: {
			basis: "documented_model_unit_price",
			inputUsdPerMillion: 0.35,
			outputUsdPerMillion: 0.75,
		},
		metrics,
		trajectories: [
			{
				id: "repair-total",
				passed: true,
				...metrics,
				durationMs: 1_500,
				inputTokens: 10,
				outputTokens: 5,
				error: null,
			},
		],
	};
}

describe("trajectory comparison", () => {
	it("reports metric changes against the previous live run", () => {
		const markdown = renderComparison(
			report("current", {
				modelTurns: 5,
				toolCalls: 8,
				toolErrors: 1,
				costUsd: 0.0015,
			}),
			report("baseline", {
				modelTurns: 4,
				toolCalls: 10,
				toolErrors: 0,
				costUsd: 0.001,
			}),
		);

		expect(markdown).toContain("| modelTurns | 4 | 5 | 1 |");
		expect(markdown).toContain("| toolCalls | 10 | 8 | -2 |");
		expect(markdown).toContain("| toolErrors | 0 | 1 | 1 |");
		expect(markdown).toContain(
			"| costUsd | $0.001000 | $0.001500 | $0.000500 |",
		);
		expect(markdown).toContain("Baseline: `baseline`");
	});

	it("makes the first-run baseline gap explicit", () => {
		const markdown = renderComparison(
			report("current", {
				modelTurns: 2,
				toolCalls: 3,
				toolErrors: 0,
				costUsd: 0.0002,
			}),
			null,
		);

		expect(markdown).toContain("| modelTurns | n/a | 2 | n/a |");
		expect(markdown).toContain("no previous successful workflow artifact");
	});

	it("does not report unavailable cost as zero", () => {
		const markdown = renderComparison(
			report("current", {
				modelTurns: 2,
				toolCalls: 3,
				toolErrors: 0,
				costUsd: null,
			}),
			report("baseline", {
				modelTurns: 2,
				toolCalls: 3,
				toolErrors: 0,
				costUsd: 0.0002,
			}),
		);

		expect(markdown).toContain("| costUsd | $0.000200 | n/a | n/a |");
	});
});
