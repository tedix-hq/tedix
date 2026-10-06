import type {
	HarnessEvalResultRow,
	HarnessEvalRunRow,
	HarnessSubjectTraceBundleRow,
} from "@tedix/db/schema/harness-versions";
import { describe, expect, it } from "vite-plus/test";
import {
	harnessEvalResultRowToContract,
	harnessEvalRunRowToContract,
	harnessSubjectTraceBundleRowToContract,
} from "./harness-persistence";

describe("harness persistence normalization", () => {
	it("normalizes nullable eval fields and validates JSON metadata", () => {
		const row: HarnessEvalResultRow = {
			id: "eval-1",
			harnessVersionId: "harness-1",
			tediId: "tedi-1",
			orgId: null,
			score: 0.42,
			gates: null as unknown as Record<string, boolean>,
			passed: false,
			lane: null,
			taskSetId: null,
			metadata: null,
			createdAt: "2026-08-01T00:00:00.000Z",
		};

		const contract = harnessEvalResultRowToContract(row);
		expect(contract.orgId).toBeUndefined();
		expect(contract.metadata).toBeUndefined();
		expect(contract.gates).toEqual({});
	});

	it("rejects non-JSON metadata at the API boundary", () => {
		const row: HarnessEvalResultRow = {
			id: "eval-2",
			harnessVersionId: "harness-1",
			tediId: "tedi-1",
			orgId: "org-1",
			score: 1,
			gates: {},
			passed: true,
			lane: "validation",
			taskSetId: null,
			metadata: { invalid: undefined },
			createdAt: "2026-08-01T00:00:00.000Z",
		};

		expect(() => harnessEvalResultRowToContract(row)).toThrow();
	});

	it("validates replay reports read from D1", () => {
		const row: HarnessEvalRunRow = {
			id: "run-1",
			harnessVersionId: "harness-1",
			tediId: "tedi-1",
			orgId: "org-1",
			lane: "validation",
			taskSetId: "tasks-1",
			total: 2,
			passed: 2,
			failed: 0,
			meanScore: 1,
			eligible: true,
			report: {
				protocolVersion: 1,
				replayGroupKey: "cohort-1",
				trials: [],
				summary: {
					trialCount: 0,
					completedTrials: 0,
					totalInputTokens: 0,
					totalOutputTokens: 0,
					totalCostUsdMicros: 0,
					meanCostUsdMicros: 0,
					cacheOpportunityTokens: 0,
					cacheReadTokens: 0,
					cacheBreakTokens: 0,
					cacheHitRate: null,
					cacheBreakRate: null,
					boundaries: [],
				},
			},
			metadata: null,
			createdAt: "2026-08-01T00:00:00.000Z",
		};

		expect(() => harnessEvalRunRowToContract(row)).toThrow();
	});

	it("hydrates workstation evidence from trace metadata", () => {
		const row: HarnessSubjectTraceBundleRow = {
			id: "run-1:bundle",
			subjectKind: "kernel",
			subjectId: "kernel:org-1",
			tediId: null,
			orgId: "org-1",
			conversationId: "home:main",
			runId: "run-1",
			harnessVersionId: "harness-1",
			eventIds: [],
			rationaleRecordIds: [],
			artifactIds: [],
			evalResultId: null,
			bundleUri: null,
			summary: "coding proof",
			outcome: "success",
			metadata: {
				workstation: {
					profileId: "general",
					workstationId: "ws-1",
					leaseId: "lease-1",
					sessionIds: ["session-1"],
					participantIds: ["participant-1"],
				},
			},
			createdAt: "2026-08-01T00:00:00.000Z",
		};

		expect(harnessSubjectTraceBundleRowToContract(row).workstation).toEqual({
			profileId: "general",
			workstationId: "ws-1",
			leaseId: "lease-1",
			sessionIds: ["session-1"],
			participantIds: ["participant-1"],
		});
	});
});
