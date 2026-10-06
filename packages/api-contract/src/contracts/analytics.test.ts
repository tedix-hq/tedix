import { describe, expect, it } from "vite-plus/test";
import { TediObservabilitySnapshotSchema } from "../schemas/analytics";
import { TediObservabilitySnapshotInputSchema } from "./analytics";

const TEDI_ID = "55555555-5555-4555-8555-555555555555";

describe("tedi observability snapshot contract", () => {
	it("bounds row count and defaults to a narrow snapshot", () => {
		expect(
			TediObservabilitySnapshotInputSchema.parse({
				tediId: TEDI_ID,
				from: "2026-09-03T00:00:00.000Z",
				to: "2026-09-03T01:00:00.000Z",
			}),
		).toMatchObject({ limit: 50 });
		expect(
			TediObservabilitySnapshotInputSchema.safeParse({
				tediId: TEDI_ID,
				from: "2026-09-03T00:00:00.000Z",
				to: "2026-09-03T01:00:00.000Z",
				limit: 101,
			}).success,
		).toBe(false);
	});

	it("exposes summaries without a raw payload field", () => {
		const parsed = TediObservabilitySnapshotSchema.parse({
			tediId: TEDI_ID,
			from: "2026-09-03T00:00:00.000Z",
			to: "2026-09-03T01:00:00.000Z",
			source: "tenant_d1",
			truncated: false,
			metrics: {
				runtimeEvents: 1,
				auditEvents: 0,
				invocations: 1,
				failedInvocations: 0,
				traceCount: 1,
				averageInvocationDurationMs: 12,
			},
			logs: [],
			invocations: [
				{
					id: "event-1",
					toolName: "list_apps",
					outcome: "success",
					durationMs: 12,
					runId: "run-1",
					traceId: "trace-1",
					occurredAt: "2026-09-03T00:30:00.000Z",
					payload: "must not cross the contract",
				},
			],
			traces: [
				{
					traceId: "trace-1",
					firstAt: "2026-09-03T00:30:00.000Z",
					lastAt: "2026-09-03T00:30:00.000Z",
					eventCount: 1,
					invocationCount: 1,
					failureCount: 0,
				},
			],
			auditEvents: [],
			auditReceiptId: "77777777-7777-4777-8777-777777777777",
		});
		expect(parsed.invocations[0]).not.toHaveProperty("payload");
	});
});
