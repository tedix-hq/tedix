import { describe, expect, it } from "vite-plus/test";
import {
	DEFAULT_EVAL_LANE,
	decidePromotion,
	EXAMPLE_HARNESS_EVAL_RESULT,
	EXAMPLE_HARNESS_VERSION,
	EXAMPLE_TRACE_BUNDLE,
	evalGateForCertification,
	HarnessEvalResultSchema,
	HarnessEvalRunReportSchema,
	HarnessEvalRunSchema,
	type HarnessEvalSummary,
	HarnessSubjectTraceBundleSchema,
	HarnessVersionSchema,
	summarizeHarnessEvalTrials,
	TraceBundleSchema,
} from "./harness-version";

const INPUT_DIGEST = `sha256:${"a".repeat(64)}`;
const SETTINGS_DIGEST = `sha256:${"b".repeat(64)}`;

function trial(
	ordinal: number,
	cacheReadTokens: number,
	costUsdMicros: number,
) {
	return {
		id: `trial-${ordinal}`,
		ordinal,
		seed: `seed-${ordinal}`,
		inputDigest: INPUT_DIGEST,
		settingsDigest: SETTINGS_DIGEST,
		status: "completed" as const,
		score: ordinal === 1 ? 1 : 0,
		passed: ordinal === 1,
		steps: [
			{
				sequence: 1,
				inputTokens: 1_200,
				outputTokens: 100,
				costUsdMicros,
				cacheBoundaries: [
					{
						key: "system:v1",
						opportunityTokens: 1_000,
						cacheReadTokens,
					},
				],
			},
		],
	};
}

function summary(over: Partial<HarnessEvalSummary> = {}): HarnessEvalSummary {
	return {
		harnessVersionId: "hv_01",
		total: 1,
		passedCount: 1,
		failedCount: 0,
		latestScore: 0.9,
		latestCreatedAt: "2026-05-31T00:00:00.000Z",
		lanes: [DEFAULT_EVAL_LANE],
		latestPassByLane: { [DEFAULT_EVAL_LANE]: true },
		...over,
	};
}

describe("HarnessVersionSchema", () => {
	it("parses a representative harness version", () => {
		expect(() =>
			HarnessVersionSchema.parse(EXAMPLE_HARNESS_VERSION),
		).not.toThrow();
		expect(EXAMPLE_HARNESS_VERSION.components.model).toBe("tedi-system1-v1");
	});

	it("defaults promotionStatus to proposed", () => {
		const parsed = HarnessVersionSchema.parse({
			id: "hv_x",
			tediId: "tedi_x",
			version: "2",
			components: { model: "m" },
			createdAt: "2026-05-31T00:00:00.000Z",
		});
		expect(parsed.promotionStatus).toBe("proposed");
	});

	it("rejects a non-string component hash value", () => {
		expect(() =>
			HarnessVersionSchema.parse({
				...EXAMPLE_HARNESS_VERSION,
				components: { model: 123 },
			}),
		).toThrow();
	});

	it("rejects an invalid promotion status", () => {
		expect(() =>
			HarnessVersionSchema.parse({
				...EXAMPLE_HARNESS_VERSION,
				promotionStatus: "deployed",
			}),
		).toThrow();
	});

	it("rejects a version missing required fields", () => {
		expect(() =>
			HarnessVersionSchema.parse({ id: "hv_y", version: "1" }),
		).toThrow();
	});
});

describe("TraceBundleSchema", () => {
	it("parses a representative trace bundle that references rows by id", () => {
		expect(() => TraceBundleSchema.parse(EXAMPLE_TRACE_BUNDLE)).not.toThrow();
		expect(EXAMPLE_TRACE_BUNDLE.eventIds).toContain("evt_a");
		expect(EXAMPLE_TRACE_BUNDLE.harnessVersionId).toBe("hv_01");
	});

	it("defaults ref arrays to empty when omitted", () => {
		const parsed = TraceBundleSchema.parse({
			id: "tb_x",
			tediId: "tedi_x",
			runId: "run_x",
			harnessVersionId: "hv_x",
			createdAt: "2026-05-31T00:00:00.000Z",
		});
		expect(parsed.eventIds).toEqual([]);
		expect(parsed.rationaleRecordIds).toEqual([]);
		expect(parsed.artifactIds).toEqual([]);
		expect(parsed.workstation).toBeNull();
	});

	it("preserves workstation evidence for CodeMode-backed episodes", () => {
		const parsed = TraceBundleSchema.parse({
			...EXAMPLE_TRACE_BUNDLE,
			workstation: {
				profileId: "general",
				workstationId: "ws_coding_1",
				leaseId: "lease_coding_1",
				sessionIds: ["codemode_session_1", "browser_session_1"],
				participantIds: ["participant_cto"],
			},
		});

		expect(parsed.workstation).toEqual({
			profileId: "general",
			workstationId: "ws_coding_1",
			leaseId: "lease_coding_1",
			sessionIds: ["codemode_session_1", "browser_session_1"],
			participantIds: ["participant_cto"],
		});
	});

	it("rejects a bundle missing runId or harnessVersionId", () => {
		expect(() =>
			TraceBundleSchema.parse({
				id: "tb_y",
				tediId: "tedi_y",
				createdAt: "2026-05-31T00:00:00.000Z",
			}),
		).toThrow();
	});

	it("rejects an invalid outcome enum", () => {
		expect(() =>
			TraceBundleSchema.parse({
				...EXAMPLE_TRACE_BUNDLE,
				outcome: "winning",
			}),
		).toThrow();
	});

	it("rejects non-string ids inside eventIds", () => {
		expect(() =>
			TraceBundleSchema.parse({
				...EXAMPLE_TRACE_BUNDLE,
				eventIds: ["evt_a", 7],
			}),
		).toThrow();
	});
});

describe("HarnessSubjectTraceBundleSchema", () => {
	it("parses an identity-less kernel trace bundle", () => {
		const parsed = HarnessSubjectTraceBundleSchema.parse({
			id: "kernel-run-1:bundle",
			subjectKind: "kernel",
			subjectId: "kernel:org_1",
			tediId: null,
			orgId: "org_1",
			conversationId: "home:main",
			runId: "kernel-run-1",
			harnessVersionId: "khv_1",
			createdAt: "2026-06-13T00:00:00.000Z",
			eventIds: ["evt_message_completed", "evt_run_completed"],
			outcome: "success",
		});
		expect(parsed.subjectKind).toBe("kernel");
		expect(parsed.tediId).toBeNull();
		expect(parsed.eventIds).toHaveLength(2);
	});

	it("defaults ref arrays for subject bundles", () => {
		const parsed = HarnessSubjectTraceBundleSchema.parse({
			id: "kernel-run-2:bundle",
			subjectKind: "kernel",
			subjectId: "kernel:org_1",
			runId: "kernel-run-2",
			harnessVersionId: "khv_1",
			createdAt: "2026-06-13T00:00:00.000Z",
		});
		expect(parsed.eventIds).toEqual([]);
		expect(parsed.rationaleRecordIds).toEqual([]);
		expect(parsed.artifactIds).toEqual([]);
		expect(parsed.workstation).toBeNull();
	});

	it("preserves workstation evidence for kernel subject bundles", () => {
		const parsed = HarnessSubjectTraceBundleSchema.parse({
			id: "kernel-run-3:bundle",
			subjectKind: "kernel",
			subjectId: "kernel:org_1",
			runId: "kernel-run-3",
			harnessVersionId: "khv_1",
			createdAt: "2026-06-13T00:00:00.000Z",
			workstation: {
				profileId: "general",
				workstationId: "ws_coding_1",
				leaseId: null,
				sessionIds: ["mcp_session_1"],
				participantIds: [],
			},
		});

		expect(parsed.workstation?.profileId).toBe("general");
		expect(parsed.workstation?.sessionIds).toEqual(["mcp_session_1"]);
	});
});

describe("HarnessEvalResultSchema", () => {
	it("parses a representative eval result", () => {
		expect(() =>
			HarnessEvalResultSchema.parse(EXAMPLE_HARNESS_EVAL_RESULT),
		).not.toThrow();
		expect(EXAMPLE_HARNESS_EVAL_RESULT.passed).toBe(true);
		expect(EXAMPLE_HARNESS_EVAL_RESULT.gates.task_success).toBe(true);
	});

	it("rejects a non-boolean gate value", () => {
		expect(() =>
			HarnessEvalResultSchema.parse({
				...EXAMPLE_HARNESS_EVAL_RESULT,
				gates: { task_success: "yes" },
			}),
		).toThrow();
	});

	it("rejects a missing score", () => {
		expect(() =>
			HarnessEvalResultSchema.parse({
				id: "her_y",
				harnessVersionId: "hv_y",
				tediId: "tedi_y",
				gates: {},
				passed: false,
				createdAt: "2026-05-31T00:00:00.000Z",
			}),
		).toThrow();
	});
});

describe("evalGateForCertification", () => {
	it("is NOT eligible when no evals are recorded", () => {
		const decision = evalGateForCertification(
			summary({ total: 0, passedCount: 0, lanes: [], latestPassByLane: {} }),
		);
		expect(decision.eligible).toBe(false);
		expect(decision.reasons[0]).toMatch(/no eval results/);
	});

	it("is eligible when every present lane's latest eval passes", () => {
		const decision = evalGateForCertification(
			summary({
				total: 2,
				passedCount: 2,
				lanes: ["validation", "canary"],
				latestPassByLane: { validation: true, canary: true },
			}),
		);
		expect(decision.eligible).toBe(true);
		expect(decision.reasons).toEqual([]);
	});

	it("is NOT eligible when any present lane's latest eval fails", () => {
		const decision = evalGateForCertification(
			summary({
				total: 2,
				passedCount: 1,
				failedCount: 1,
				lanes: ["validation", "canary"],
				latestPassByLane: { validation: true, canary: false },
			}),
		);
		expect(decision.eligible).toBe(false);
		expect(decision.reasons).toContain(
			'latest eval on lane "canary" did not pass',
		);
	});

	it("requires a passing eval for an explicitly required lane that is missing", () => {
		const decision = evalGateForCertification(
			summary({
				lanes: ["validation"],
				latestPassByLane: { validation: true },
			}),
			{ requiredLanes: ["validation", "locked-test"] },
		);
		expect(decision.eligible).toBe(false);
		expect(decision.reasons).toContain(
			'required lane "locked-test" has no eval result',
		);
	});

	it("only gates on explicitly required lanes (ignores other failing lanes)", () => {
		const decision = evalGateForCertification(
			summary({
				total: 2,
				lanes: ["validation", "canary"],
				latestPassByLane: { validation: true, canary: false },
			}),
			{ requiredLanes: ["validation"] },
		);
		// canary fails but is not required → still eligible.
		expect(decision.eligible).toBe(true);
	});
});

describe("HarnessEvalRunSchema", () => {
	it("parses a representative run grouping", () => {
		expect(() =>
			HarnessEvalRunSchema.parse({
				id: "evalrun_1",
				harnessVersionId: "hv_01",
				tediId: "tedi_cto",
				orgId: "org_tedix",
				lane: "validation",
				taskSetId: "isolate-core-v1",
				total: 3,
				passed: 3,
				failed: 0,
				meanScore: 0.92,
				eligible: true,
				createdAt: "2026-05-31T00:00:00.000Z",
			}),
		).not.toThrow();
	});

	it("accepts replayable trials and reports explicit cache opportunities and cost", () => {
		const trials = [trial(1, 1_000, 2_000), trial(2, 250, 4_000)];
		const summary = summarizeHarnessEvalTrials(trials);
		const report = HarnessEvalRunReportSchema.parse({
			protocolVersion: 1,
			replayGroupKey: "support-v1:gpt-5.6-sol",
			trials,
			summary,
		});

		expect(report.summary).toMatchObject({
			trialCount: 2,
			completedTrials: 2,
			totalInputTokens: 2_400,
			totalOutputTokens: 200,
			totalCostUsdMicros: 6_000,
			meanCostUsdMicros: 3_000,
			cacheOpportunityTokens: 2_000,
			cacheReadTokens: 1_250,
			cacheBreakTokens: 750,
			cacheHitRate: 0.625,
			cacheBreakRate: 0.375,
		});
		expect(report.summary.boundaries).toEqual([
			{
				key: "system:v1",
				opportunities: 2,
				opportunityTokens: 2_000,
				cacheReadTokens: 1_250,
				cacheBreakTokens: 750,
				hitRate: 0.625,
				breakRate: 0.375,
			},
		]);
	});

	it("rejects mismatched replay inputs and caller-invented summaries", () => {
		const trials = [trial(1, 1_000, 2_000), trial(2, 250, 4_000)];
		expect(() =>
			HarnessEvalRunReportSchema.parse({
				protocolVersion: 1,
				replayGroupKey: "support-v1:gpt-5.6-sol",
				trials: [
					trials[0],
					{ ...trials[1], inputDigest: `sha256:${"c".repeat(64)}` },
				],
				summary: summarizeHarnessEvalTrials(trials),
			}),
		).toThrow(/same input digest/);
		expect(() =>
			HarnessEvalRunReportSchema.parse({
				protocolVersion: 1,
				replayGroupKey: "support-v1:gpt-5.6-sol",
				trials,
				summary: {
					...summarizeHarnessEvalTrials(trials),
					totalCostUsdMicros: 1,
				},
			}),
		).toThrow(/canonical trial telemetry fold/);
	});
});

describe("decidePromotion", () => {
	it("stays when no evals exist", () => {
		const d = decidePromotion(
			"proposed",
			summary({ total: 0, lanes: [], latestPassByLane: {} }),
		);
		expect(d.advanced).toBe(false);
		expect(d.nextStatus).toBe("proposed");
		expect(d.reasons[0]).toMatch(/no eval results/);
	});

	it("stays when the stage's required lane has no eval yet", () => {
		// proposed gates on `validation`; only a `search` eval exists.
		const d = decidePromotion(
			"proposed",
			summary({ lanes: ["search"], latestPassByLane: { search: true } }),
		);
		expect(d.advanced).toBe(false);
		expect(d.reasons[0]).toMatch(/awaiting a "validation" eval/);
	});

	it("climbs the ladder lane by lane", () => {
		const validationPass = summary({
			lanes: ["validation"],
			latestPassByLane: { validation: true },
		});
		expect(decidePromotion("proposed", validationPass).nextStatus).toBe(
			"evaluated",
		);

		const lockedPass = summary({
			lanes: ["locked-test"],
			latestPassByLane: { "locked-test": true },
		});
		expect(decidePromotion("evaluated", lockedPass).nextStatus).toBe("canary");

		const canaryPass = summary({
			lanes: ["canary"],
			latestPassByLane: { canary: true },
		});
		const promoted = decidePromotion("canary", canaryPass);
		expect(promoted.nextStatus).toBe("promoted");
		expect(promoted.advanced).toBe(true);
	});

	it("rejects when a required stage lane fails", () => {
		const d = decidePromotion(
			"evaluated",
			summary({
				lanes: ["locked-test"],
				latestPassByLane: { "locked-test": false },
			}),
		);
		expect(d.nextStatus).toBe("rejected");
		expect(d.advanced).toBe(true);
		expect(d.reasons[0]).toMatch(/locked-test.*failed/);
	});

	it("treats promoted/rejected/active/rolled_back as terminal for the ladder", () => {
		for (const terminal of [
			"promoted",
			"rejected",
			"active",
			"rolled_back",
		] as const) {
			const d = decidePromotion(terminal, summary());
			expect(d.advanced).toBe(false);
			expect(d.nextStatus).toBe(terminal);
			expect(d.reasons[0]).toMatch(/terminal/);
		}
	});
});
