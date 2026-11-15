import { describe, expect, it, vi } from "vite-plus/test";
import type {
	OfficeActivityRow,
	OfficeCanonicalRow,
} from "@tedix/api-contract/schemas/office-activity";
vi.mock("@/lib/os-query-options", () => ({
	officeOperationsQueryOptions: vi.fn(),
}));
import {
	canonicalOfficeLine,
	officeTimelineRows,
} from "./office-activity-timeline";

const row: OfficeCanonicalRow = {
	id: "event",
	at: "2026-11-03T12:00:00Z",
	source: "work",
	stage: "work_closed",
	sessionKey: "codex:example",
	host: "codex",
	workItemId: null,
	attemptId: null,
	requestId: null,
	resultRecorded: false,
};
describe("Office evidence wording", () => {
	it("keeps closure, Attempt success, result and delivery distinct", () => {
		expect(canonicalOfficeLine({ ...row, stage: "queued" }).outcome).toBe(
			"unknown",
		);
		expect(canonicalOfficeLine(row)).toEqual({
			title:
				"Work closed in its canonical history; result evidence needs review",
			outcome: "observed",
		});
		expect(
			canonicalOfficeLine({ ...row, stage: "attempt_succeeded" }).outcome,
		).toBe("unknown");
		expect(canonicalOfficeLine({ ...row, stage: "saved" }).outcome).toBe(
			"unknown",
		);
		expect(canonicalOfficeLine({ ...row, stage: "handed_off" }).outcome).toBe(
			"deferred",
		);
		expect(
			canonicalOfficeLine({ ...row, stage: "acknowledged" }).title,
		).toContain("acknowledged");
	});
	it("orders canonical timestamps and retains event identity without using status badges", () => {
		const rows = officeTimelineRows(
			[],
			[row, { ...row, id: "older", at: "2026-11-03 11:00:00" }],
		);
		expect(rows.map((row) => row.id)).toEqual(["event", "older"]);
		expect(rows[0]!.evidence).toContain(
			"live acceptance require their own evidence",
		);
	});
	it("names cancelled, expired and unknown Attempt settlements and legacy replies", () => {
		expect(canonicalOfficeLine({ ...row, stage: "attempt_cancelled" })).toEqual(
			{
				title: "Attempt cancelled before it recorded a result",
				outcome: "observed",
			},
		);
		expect(
			canonicalOfficeLine({ ...row, stage: "attempt_expired" }).outcome,
		).toBe("failed");
		expect(canonicalOfficeLine({ ...row, stage: "unknown" }).title).toBe(
			"Attempt ended; its outcome is unknown",
		);
		expect(
			canonicalOfficeLine({ ...row, source: "reply", stage: "unknown" }).title,
		).toContain("Reply delivery method is unknown");
	});
	it("shows an OpenCode runner permission ask as auto-approved and counts combined reports", () => {
		const hook: OfficeActivityRow = {
			id: "00000000-0000-4000-8000-000000000001",
			at: "2026-11-03T12:00:00.000Z",
			firstAt: "2026-11-03T11:00:00.000Z",
			occurrences: 40,
			source: "hook",
			host: "opencode",
			sessionKey: "opencode:ses_example",
			trigger: "PermissionRequest",
			reportedState: "error",
			outcome: "observed",
			reason: "reported",
			reporterVersion: "0.19.3",
			workItemId: null,
		};
		const [line] = officeTimelineRows([hook], []);
		expect(line!.title).toContain("the runner approves it automatically");
		expect(line!.title).not.toContain("error");
		expect(line!.evidence).toContain("40 matching reports combined since");
		const [claude] = officeTimelineRows(
			[{ ...hook, host: "claude-code", reportedState: "needs_you" }],
			[],
		);
		expect(claude!.title).toBe(
			"PermissionRequest · Status hook observed; Work completion is separate · Session reported Needs you",
		);
	});
});
