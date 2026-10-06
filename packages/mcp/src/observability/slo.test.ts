import { describe, expect, it } from "vite-plus/test";
import { evaluateMcpSlos, MCP_SLO_DEFINITIONS, MCP_SLO_LANES } from "./slo";

describe("MCP SLO contract", () => {
	it("defines every governed lane exactly once", () => {
		expect(MCP_SLO_DEFINITIONS.map((row) => row.lane)).toEqual(MCP_SLO_LANES);
	});

	it("distinguishes healthy, breached, and missing evidence", () => {
		const report = evaluateMcpSlos([
			{ lane: "auth", successRate: 1, p95LatencyMs: 100, sampleCount: 10 },
			{
				lane: "discovery",
				successRate: 0.5,
				p95LatencyMs: 100,
				sampleCount: 10,
			},
		]);
		expect(report.find((row) => row.lane === "auth")?.status).toBe("healthy");
		expect(report.find((row) => row.lane === "discovery")?.status).toBe(
			"breach",
		);
		expect(report.find((row) => row.lane === "trace")?.status).toBe(
			"unobserved",
		);
	});
});
