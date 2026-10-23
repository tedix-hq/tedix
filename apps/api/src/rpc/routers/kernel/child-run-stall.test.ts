import { describe, expect, it } from "vite-plus/test";
import type { KernelRuntimeRun } from "@tedix/db/queries/kernel-runtime-runs";
import {
	DELEGATED_CHILD_STALL_GRACE_MS,
	stalledChildRunStatus,
} from "./child-run-stall";

const STARTED_AT = "2026-10-23T14:50:52.000Z";
const DEADLINE_MS = 600_000;

function row(metadata: Record<string, unknown>): KernelRuntimeRun {
	return {
		id: "home-run-1",
		status: "running",
		startedAt: STARTED_AT,
		createdAt: STARTED_AT,
		metadata,
	} as unknown as KernelRuntimeRun;
}

const workOrder = {
	delegationWorkOrder: {
		budget: { maxToolCalls: 12, deadlineMs: DEADLINE_MS },
	},
};
const running = {
	childRunStatus: "running",
	childRunLatestEventAt: "2026-10-23T14:57:09.120Z",
	childRunLatestEventKind: "context.injected",
	childRunPreview: null,
};
const pastGrace =
	Date.parse(STARTED_AT) + DEADLINE_MS + DELEGATED_CHILD_STALL_GRACE_MS;

describe("stalledChildRunStatus", () => {
	it("leaves a child inside its deadline and grace alone", () => {
		expect(
			stalledChildRunStatus(row(workOrder), running, pastGrace - 1),
		).toBeNull();
	});

	it("fails a non-terminal child past its deadline with a plain reason", () => {
		const stalled = stalledChildRunStatus(row(workOrder), running, pastGrace);
		expect(stalled).toMatchObject({
			childRunStatus: "failed",
			childRunTerminalEventKind: "run.failed",
			childRunLatestEventKind: "run.failed",
			childRunTerminalAt: new Date(pastGrace).toISOString(),
		});
		expect(stalled?.childRunPreview).toBe(
			"The tedi stopped responding and did not finish within its 10-minute limit. Its last activity was at 2026-10-23T14:57:09.120Z. Retry the request.",
		);
	});

	it("never rewrites a child that already settled", () => {
		for (const childRunStatus of ["completed", "partial", "failed", "canceled"])
			expect(
				stalledChildRunStatus(
					row(workOrder),
					{ ...running, childRunStatus },
					pastGrace,
				),
			).toBeNull();
	});

	it("has no opinion without a delegation deadline", () => {
		expect(stalledChildRunStatus(row({}), running, pastGrace * 2)).toBeNull();
	});
});
