import { describe, expect, it } from "vite-plus/test";
import { workAttemptFailureReason } from "./attempt-failure";

describe("attempt failure reason", () => {
	it("uses the structured reason as one line", () => {
		expect(
			workAttemptFailureReason("progress", {
				failureReason: " API failed\n retry later ",
			}),
		).toBe("API failed retry later");
	});
	it("finds a blocker beneath a partial progress report", () => {
		expect(
			workAttemptFailureReason(
				"Prepared an editorial packet.\n\nRemaining blocker: owner authorization is missing.\nNo CMS writes.",
				undefined,
			),
		).toBe("Remaining blocker: owner authorization is missing.");
	});
	it("does not invent a missing cause", () => {
		expect(workAttemptFailureReason(" \n", undefined)).toBe(
			"Attempt failed without a reported reason; inspect its run history.",
		);
	});
});
