import { describe, expect, it } from "vite-plus/test";
import { FILING_CASES } from "./fixtures";
import { runFilingCase, type ArmOutcome } from "./harness";
import { summarizeFilingArm } from "./measure";

const outcomes = (await Promise.all(FILING_CASES.map(runFilingCase))).flat();
const arm = (name: ArmOutcome["arm"]) =>
	outcomes.filter((row) => row.arm === name);
const cell = (name: ArmOutcome["arm"], caseId: string) =>
	arm(name).find((row) => row.caseId === caseId)!;
const baseline = summarizeFilingArm(arm("baseline"));
const candidate = summarizeFilingArm(arm("candidate"));

describe("filing chooser vs previous path on the frozen holdout", () => {
	it("matches on clean cases, abstains the same, and reuses Work", () => {
		const terminal = ({
			status,
			projectId,
			confidence,
			factoryProposal,
			actionable,
			workItemId,
			createdWorkProjectId,
		}: ArmOutcome) => ({
			status,
			projectId,
			confidence,
			factoryProposal,
			actionable,
			workItemId,
			createdWorkProjectId,
		});
		for (const id of ["h01", "h02", "h03", "h04", "h06", "h17", "h18"])
			expect(terminal(cell("candidate", id))).toEqual(
				terminal(cell("baseline", id)),
			);
		expect(cell("candidate", "h05")).toMatchObject({
			status: "filed",
			projectId: "proj-docs",
			workItemId: "work-docs",
		});
		expect(cell("candidate", "h17")).toMatchObject({
			status: "filed",
			actionable: false,
		});
		for (const id of ["h09", "h10", "h14", "h19", "h20"]) {
			expect(cell("candidate", id).status).toBe("pending");
			expect(cell("candidate", id).suggestedProjectId).toBe(
				cell("baseline", id).suggestedProjectId,
			);
		}
		expect(cell("candidate", "h14").workItemId).toBe("work-billing");
	});
	it("suppresses the writer except for a confident novel container", () => {
		expect(candidate.calls.writer).toBe(3);
		expect(candidate.calls.chooser).toBe(23);
		expect(baseline.calls.writer).toBe(25);
		expect(baseline.calls.scorer).toBe(15);
		expect(cell("candidate", "h13").factoryProposal).toBe(true);
		expect(cell("candidate", "h13").calls).toMatchObject({
			writer: 1,
			chooser: 1,
		});
		expect(cell("candidate", "h14").calls.writer).toBe(0);
	});
	it("stops flagging NONE/UNCLEAR abstentions as factory proposals", () => {
		expect(candidate.factoryProposals).toBe(1);
		expect(baseline.factoryProposals).toBe(5);
		for (const id of ["h11", "h12", "h19", "h20"]) {
			expect(cell("baseline", id).factoryProposal).toBe(true);
			expect(cell("candidate", id).factoryProposal).toBe(false);
		}
	});
	it("rejects a novel writer that claims an existing project", () => {
		expect(cell("candidate", "h15").error).toBe(
			"Novel brief cannot choose existing resources",
		);
		expect(cell("baseline", "h15")).toMatchObject({
			status: "filed",
			projectId: "proj-docs",
			createdWorkProjectId: "proj-docs",
		});
	});
	it("fails closed instead of filing from a truncated portfolio", () => {
		expect(cell("baseline", "h24")).toMatchObject({
			status: "filed",
			projectId: "proj-docs",
			createdWorkProjectId: "proj-docs",
		});
		expect(cell("candidate", "h24")).toMatchObject({
			status: "error",
			error: "Request filing portfolio exceeds choice window",
			calls: { chooser: 0, writer: 0, scorer: 0 },
		});
		expect(cell("candidate", "h25")).toMatchObject({
			status: "error",
			error: "Request filing inventory may be truncated",
			calls: { chooser: 0, writer: 0, scorer: 0 },
		});
		expect(cell("baseline", "h25").status).toBe("error");
	});
	it("keeps error cases unfiled on both arms", () => {
		for (const id of ["h16", "h21", "h22", "h23"]) {
			expect(cell("baseline", id).status).toBe("error");
			expect(cell("candidate", id).status).toBe("error");
		}
	});
	it("records the comparison summary", () => {
		expect(baseline).toMatchObject({
			cases: 25,
			filed: 12,
			pending: 8,
			errors: 5,
			correct: 20,
			wrongProjectFilings: 4,
			missedCorrectFilings: 1,
			callsPer1000: 1600,
			failedCaseCallsPer1000: 240,
		});
		expect(candidate).toMatchObject({
			cases: 25,
			filed: 10,
			pending: 8,
			errors: 7,
			correct: 21,
			wrongProjectFilings: 2,
			missedCorrectFilings: 2,
			callsPer1000: 1040,
			failedCaseCallsPer1000: 280,
		});
	});
});
