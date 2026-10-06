import { describe, expect, it } from "vite-plus/test";
import {
	hasSuccessfulCompletionEvidence,
	hasTerminalJobCompletionEvidence,
} from "./runtime-execution-evidence";

const workstationReceipt = {
	completionEvidence: {
		operation: "read_execution",
		status: "succeeded",
		supportedClaims: ["the command completed successfully"],
	},
};

describe("runtime execution evidence", () => {
	it("finds a nested terminal workstation receipt", () => {
		expect(
			hasTerminalJobCompletionEvidence({ result: workstationReceipt }),
		).toBe(true);
		expect(
			hasSuccessfulCompletionEvidence({ result: workstationReceipt }),
		).toBe(true);
	});

	it("does not promote a job acceptance or prose to terminal proof", () => {
		expect(
			hasTerminalJobCompletionEvidence({
				completionEvidence: {
					operation: "exec",
					status: "pending",
					supportedClaims: ["the durable job was accepted"],
				},
			}),
		).toBe(false);
		expect(
			hasTerminalJobCompletionEvidence("All tests passed with read_execution"),
		).toBe(false);
	});

	it("fails closed on malformed and unsuccessful serialized receipts", () => {
		expect(
			hasTerminalJobCompletionEvidence(
				JSON.stringify({
					completionEvidence: {
						operation: "read_execution",
						status: "failed",
						supportedClaims: [],
					},
				}),
			),
		).toBe(false);
		expect(hasSuccessfulCompletionEvidence("{not-json")).toBe(false);
	});
});
