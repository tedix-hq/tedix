import { describe, expect, it } from "vite-plus/test";
import { ErrorCodes } from "../rpc/orpc";
import {
	parseSkillRuntimeErrorBody,
	skillRuntimeErrorCode,
} from "./skill-runtime-error";

describe("skill runtime error projection", () => {
	it("preserves actionable client status classes", () => {
		expect(skillRuntimeErrorCode(400)).toBe(ErrorCodes.BAD_REQUEST);
		expect(skillRuntimeErrorCode(404)).toBe(ErrorCodes.NOT_FOUND);
		expect(skillRuntimeErrorCode(409)).toBe(ErrorCodes.CONFLICT);
		expect(skillRuntimeErrorCode(429)).toBe(ErrorCodes.TOO_MANY_REQUESTS);
		expect(skillRuntimeErrorCode(500)).toBe(ErrorCodes.BAD_GATEWAY);
	});

	it("extracts a stable runtime error code and message", () => {
		expect(
			parseSkillRuntimeErrorBody(
				JSON.stringify({
					error: "WORKFLOW_APPROVAL_DECISION_CONFLICT",
					message: "approval already finalized",
				}),
			),
		).toEqual({
			code: "WORKFLOW_APPROVAL_DECISION_CONFLICT",
			message: "approval already finalized",
		});
	});
});
