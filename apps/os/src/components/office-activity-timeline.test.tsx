import { describe, expect, it, vi } from "vite-plus/test";
import type { OfficeCanonicalRow } from "@tedix/api-contract/schemas/office-activity";
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
});
