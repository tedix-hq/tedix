import { describe, expect, it } from "vite-plus/test";
import {
	SkillWorkflowRunTimelineSchema,
	type SkillWorkflowTimelineEvent,
} from "@tedix/api-contract/schemas/cognitive";
import { encodeTimelineReceipt } from "@tedix/api-contract/utils/workflow-timeline-receipt";
import { buildSkillWorkflowTimeline } from "./skill-workflow-timeline";

const run = {
	id: "run-1",
	status: "running" as const,
	startedAt: "2026-01-01T00:00:00.000Z",
	completedAt: null,
	executionEpoch: 3,
};
const marker = {
	path: "timeline/epochs/3/coverage.json",
	contentInline: JSON.stringify({
		schemaVersion: 1,
		kind: "coverage",
		executionEpoch: 3,
	}),
};
function receipt(
	index: number,
	overrides: Partial<SkillWorkflowTimelineEvent> = {},
) {
	const path = `epochs/3/steps/x:fetch/1/calls/run/${index}.json`;
	return {
		path: `timeline/${path}`,
		contentInline: JSON.stringify({
			schemaVersion: 1,
			id: path,
			path,
			executionEpoch: 3,
			kind: "network",
			name: "fetch",
			count: index,
			lane: "network",
			startedAt: null,
			endedAt: null,
			durationMs: null,
			status: "pending",
			outcome: "pending",
			...overrides,
		}),
	};
}
describe("compact workflow timeline", () => {
	it("returns 300 receipts without truncation or body reads", () => {
		const result = buildSkillWorkflowTimeline(run, [
			marker,
			...Array.from({ length: 300 }, (_, i) => receipt(i)),
		]);
		expect(result.events).toHaveLength(300);
		expect(result.coverage).toBe("complete");
		expect(result.truncated).toBe(false);
		expect(result.phases[0]?.calls).toEqual({ ok: 0, failed: 0, pending: 300 });
		expect(SkillWorkflowRunTimelineSchema.safeParse(result).success).toBe(true);
	});
	it("marks historical runs partial without inventing events or timing", () => {
		expect(
			buildSkillWorkflowTimeline(run, [
				{ path: "timeline.json", contentInline: '{"steps":[{}]}' },
			]),
		).toMatchObject({
			coverage: "partial",
			events: [],
			phases: [],
			lanes: [],
			truncated: false,
		});
	});
	it("ignores other epochs and rejects invalid or non-inline current receipts", () => {
		const result = buildSkillWorkflowTimeline(run, [
			marker,
			receipt(1, { executionEpoch: 2 }),
			{ path: "timeline/epochs/3/bad.json", contentInline: "{" },
			{ path: "timeline/epochs/3/r2.json", contentInline: null },
			{ ...marker, path: "timeline/epochs/2/coverage.json" },
		]);
		expect(result.coverage).toBe("partial");
		expect(result.events).toEqual([]);
		expect(result.warnings).toHaveLength(3);
	});
	it("rejects a compact receipt stored under a different original path", () => {
		const result = buildSkillWorkflowTimeline(run, [
			marker,
			{
				...receipt(1),
				path: "timeline/epochs/3/steps/different.json",
			},
		]);
		expect(result.coverage).toBe("partial");
		expect(result.events).toEqual([]);
		expect(result.warnings).toHaveLength(1);
	});
	it("groups observed run and rollback calls while retaining unknown timing", () => {
		const result = buildSkillWorkflowTimeline(run, [
			marker,
			receipt(1, {
				outcome: "success",
				startedAt: "2026-01-01T00:00:01Z",
				endedAt: "2026-01-01T00:00:02Z",
				durationMs: 1000,
			}),
			receipt(2, { kind: "mcp", phase: "rollback", outcome: "failure" }),
			receipt(3, { kind: "step", outcome: "success" }),
		]);
		expect(result.phases).toEqual([
			{
				id: "run",
				label: "Run",
				startedAt: "2026-01-01T00:00:01Z",
				endedAt: null,
				calls: { ok: 1, failed: 0, pending: 0 },
			},
			{
				id: "rollback",
				label: "Rollback",
				startedAt: null,
				endedAt: null,
				calls: { ok: 0, failed: 1, pending: 0 },
			},
		]);
		expect(result.lanes).toEqual([
			{ id: "network", label: "network", kind: "mixed" },
		]);
	});
	it.each(["completed", "failed", "canceled"] as const)(
		"marks %s runs with pending receipts partial without changing the receipts",
		(status) => {
			const result = buildSkillWorkflowTimeline({ ...run, status }, [
				marker,
				receipt(1),
			]);
			expect(result.coverage).toBe("partial");
			expect(result.events[0]?.outcome).toBe("pending");
			expect(result.events[0]?.endedAt).toBeNull();
			expect(result.warnings).toContain(
				"This terminal run has pending receipts; recording may have been interrupted.",
			);
		},
	);
	it("keeps failed calls visible even when their enclosing step succeeds", () => {
		const result = buildSkillWorkflowTimeline({ ...run, status: "completed" }, [
			marker,
			receipt(1, {
				kind: "network",
				httpStatus: 429,
				outcome: "failure",
				status: "failed",
			}),
			receipt(2, { kind: "step", outcome: "success", status: "succeeded" }),
		]);
		expect(result.coverage).toBe("complete");
		expect(
			result.events.find((event) => event.kind === "network")?.httpStatus,
		).toBe(429);
		expect(result.phases[0]?.calls).toEqual({ ok: 0, failed: 1, pending: 0 });
	});
	it("reads schema-2 receipts next to schema-1 rows with identical events", () => {
		const v1 = receipt(1, {
			kind: "mcp",
			namespace: "tedi",
			method: "work_items_list",
			lane: "tedi",
			phase: "run",
			attempt: 1,
			startedAt: "2026-01-01T00:00:01.000Z",
			endedAt: "2026-01-01T00:00:02.500Z",
			durationMs: 1500,
			status: "succeeded",
			outcome: "success",
		});
		const event = JSON.parse(v1.contentInline) as SkillWorkflowTimelineEvent;
		const v2 = {
			path: v1.path,
			contentInline: JSON.stringify(encodeTimelineReceipt(event)),
		};
		expect(v2.contentInline.length).toBeLessThan(v1.contentInline.length / 2);
		const legacy = buildSkillWorkflowTimeline(run, [marker, v1]);
		const compact = buildSkillWorkflowTimeline(run, [marker, v2]);
		expect(compact).toEqual(legacy);
		expect(compact.coverage).toBe("complete");
		expect(compact.events[0]?.endedAt).toBe("2026-01-01T00:00:02.500Z");
		expect(SkillWorkflowRunTimelineSchema.safeParse(compact).success).toBe(
			true,
		);
	});
	it("rejects an invalid schema-2 receipt as a warning", () => {
		const result = buildSkillWorkflowTimeline(run, [
			marker,
			{
				path: "timeline/epochs/3/steps/x:a/1/attempts/1.json",
				contentInline: JSON.stringify({ v: 2, k: "step", n: "a" }),
			},
		]);
		expect(result.events).toEqual([]);
		expect(result.coverage).toBe("partial");
	});
	it("requires a valid marker for this epoch", () => {
		expect(
			buildSkillWorkflowTimeline(run, [
				{
					...marker,
					contentInline: JSON.stringify({
						schemaVersion: 1,
						kind: "coverage",
						executionEpoch: 2,
					}),
				},
			]).coverage,
		).toBe("partial");
	});
});
