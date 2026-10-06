/**
 * Operator-consent attestation — the gateway half.
 *
 * The whole feature stands on one narrow rule: only a skill-workflow caller
 * whose admission row says a human started the run attests as operator
 * consent. Everything else — agents, tedis, schedules, M2M, absent identity —
 * is the fail-closed negative control. Prompt text never reaches this code:
 * the inputs are service-binding headers built from host-side bridge props.
 */
import { describe, expect, it } from "vite-plus/test";
import { buildOperatorConsentHeader } from "./handler";

describe("buildOperatorConsentHeader", () => {
	it("attests an operator-started skill run", () => {
		const header = buildOperatorConsentHeader({
			skillRunId: "run-1",
			skillId: "skill-1",
			skillRunCreatedBy: "user:U39z24M4F456C31EdxA3a39gsuLH",
		});
		expect(header).not.toBeNull();
		const envelope = JSON.parse(header!) as Record<string, unknown>;
		expect(envelope).toEqual({
			v: 1,
			runId: "run-1",
			skillId: "skill-1",
			createdBy: "user:U39z24M4F456C31EdxA3a39gsuLH",
			attestedBy: "tedix-mcp-gateway",
		});
	});

	it("refuses every non-operator starter class — the negative control", () => {
		for (const createdBy of [
			"agent:5eed0015-0000-4000-8000-000000000015",
			"tedi:5eed0038-0000-4000-8000-000000000038",
			"schedule",
			"m2m",
			"service-binding",
			"unknown",
			// A forged prefix embedded mid-string must not pass either.
			"agent:user:sneaky",
			"",
		]) {
			expect(
				buildOperatorConsentHeader({
					skillRunId: "run-1",
					skillRunCreatedBy: createdBy,
				}),
			).toBeNull();
		}
	});

	it("refuses when the caller is not a skill run at all", () => {
		expect(buildOperatorConsentHeader(undefined)).toBeNull();
		expect(buildOperatorConsentHeader(null)).toBeNull();
		expect(
			buildOperatorConsentHeader({ skillRunCreatedBy: "user:someone" }),
		).toBeNull();
		expect(buildOperatorConsentHeader({ skillRunId: "run-1" })).toBeNull();
	});
});
