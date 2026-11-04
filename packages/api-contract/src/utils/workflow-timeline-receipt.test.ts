import { describe, expect, it } from "vite-plus/test";
import type { SkillWorkflowTimelineEvent } from "../schemas/cognitive";
import {
	decodeTimelineReceipt,
	encodeTimelineReceipt,
	SkillWorkflowTimelineReceiptSchema,
} from "./workflow-timeline-receipt";

const path = "epochs/0/steps/x:read-queue/1/attempts/1/calls/run/3.json";
// Shape of a production receipt sampled on 3 Nov 2026 (434 bytes as schema 1).
const mcp: SkillWorkflowTimelineEvent = {
	schemaVersion: 1,
	id: path,
	path,
	executionEpoch: 0,
	kind: "mcp",
	name: "read-queue",
	count: 1,
	attempt: 1,
	phase: "run",
	lane: "tedi",
	startedAt: "2026-11-03T15:25:40.127Z",
	endedAt: "2026-11-03T15:25:48.164Z",
	durationMs: 8037,
	status: "succeeded",
	outcome: "success",
	namespace: "tedi",
	method: "work_items_list",
};
const roundTrip = (event: SkillWorkflowTimelineEvent) => {
	const stored = JSON.parse(JSON.stringify(encodeTimelineReceipt(event)));
	const receipt = SkillWorkflowTimelineReceiptSchema.parse(stored);
	return decodeTimelineReceipt(receipt, event.path, event.executionEpoch);
};

describe("workflow timeline receipt schema 2", () => {
	it("restores the full event and stores less than half the bytes", () => {
		expect(roundTrip(mcp)).toEqual(mcp);
		const before = JSON.stringify(mcp).length;
		const after = JSON.stringify(encodeTimelineReceipt(mcp)).length;
		expect(before).toBe(434);
		expect(after).toBeLessThan(before / 2);
	});

	it.each<[string, Partial<SkillWorkflowTimelineEvent>]>([
		[
			"pending",
			{
				endedAt: null,
				durationMs: null,
				status: "pending",
				outcome: "pending",
			},
		],
		["no timing", { startedAt: null, endedAt: null, durationMs: null }],
		["duration without end", { endedAt: null }],
		["end that disagrees with duration", { endedAt: "2026-11-03T15:25:50Z" }],
		[
			"non-canonical start",
			{ startedAt: "2026-11-03T15:25:40Z", endedAt: "2026-11-03T15:25:48Z" },
		],
		["fractional duration", { durationMs: 8037.5 }],
		["count and no attempt", { count: 4, attempt: undefined }],
		["count zero", { count: 0 }],
		["rollback phase", { kind: "rollback", phase: "rollback", lane: "x" }],
		[
			"network call",
			{
				kind: "network",
				namespace: undefined,
				method: "GET",
				host: "example.test",
				lane: "example.test",
				httpStatus: 429,
				outcome: "failure",
				status: "failed",
			},
		],
		["null http status", { httpStatus: null }],
	])("round-trips %s", (_, overrides) => {
		const event = { ...mcp, ...overrides };
		expect(roundTrip(event)).toEqual(
			Object.fromEntries(
				Object.entries(event).filter(([, value]) => value !== undefined),
			),
		);
	});
});
