import { describe, expect, it, vi } from "vite-plus/test";
import {
	hasWorkersObservabilityConfig,
	queryWorkersTraceEvidence,
} from "./workers-observability";

describe("Workers Observability trace evidence", () => {
	it("fails closed when the dedicated token is absent", () => {
		expect(
			hasWorkersObservabilityConfig({
				CF_ACCOUNT_ID: "account",
				CF_OBSERVABILITY_TOKEN: "",
			}),
		).toBe(false);
	});

	it("joins a Tedix trace attribute to the re-rooted Cloudflare trace", async () => {
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(
				Response.json({
					success: true,
					result: {
						events: {
							events: [
								{
									$metadata: { traceId: "cf-trace" },
									tedix: { trace_id: "tedix-trace" },
								},
							],
						},
					},
				}),
			)
			.mockResolvedValueOnce(
				Response.json({
					success: true,
					result: {
						traces: [
							{
								id: "cursor",
								traceId: "cf-trace",
								services: ["tedix-mcp-production"],
								spans: 7,
								traceDurationMs: 42,
								traceStartMs: 1_000,
								traceEndMs: 1_042,
								errors: ["redacted upstream detail"],
							},
						],
					},
				}),
			);

		const result = await queryWorkersTraceEvidence(
			{
				CF_ACCOUNT_ID: "account",
				CF_OBSERVABILITY_TOKEN: "token",
			},
			{ fromMs: 0, toMs: 2_000, traceIds: ["tedix-trace"] },
		);

		expect(result.get("tedix-trace")).toEqual({
			cloudflareTraceId: "cf-trace",
			durationMs: 42,
			errorCount: 1,
			serviceNames: ["tedix-mcp-production"],
			spanCount: 7,
			traceEndAt: "1970-01-01T00:00:01.042Z",
			traceStartAt: "1970-01-01T00:00:01.000Z",
		});
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(await fetchMock.mock.calls[0]?.[1]?.body).not.toContain(
			"redacted upstream detail",
		);
	});
});
