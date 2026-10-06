import { describe, expect, it } from "vite-plus/test";
import { buildBodyExecutionResult } from "./body-execution-result";
import {
	buildHarnessSubjectTraceBundle,
	buildTraceBundle,
	traceBundleMetadata,
	traceBundleWorkstationFromBodyResult,
} from "./trace-bundle";

describe("trace bundle helpers", () => {
	it("builds tedi trace bundles with shared defaults and body-result metadata", () => {
		const bodyExecutionResult = buildBodyExecutionResult({
			bodyKind: "agent",
			status: "completed",
			runId: "run-1",
			tediId: "tedi-1",
			orgId: "org-1",
			conversationId: "agent:main:qa",
			harnessVersionId: "hv-1",
			traceBundleId: "run-1:bundle",
			startedAt: "2026-06-13T10:00:00.000Z",
			endedAt: "2026-06-13T10:00:01.000Z",
		});

		const bundle = buildTraceBundle({
			id: "run-1:bundle",
			tediId: "tedi-1",
			orgId: "org-1",
			conversationId: "agent:main:qa",
			runId: "run-1",
			harnessVersionId: "hv-1",
			createdAt: "2026-06-13T10:00:01.000Z",
			bodyExecutionResult,
		});

		expect(bundle).toMatchObject({
			id: "run-1:bundle",
			tediId: "tedi-1",
			orgId: "org-1",
			conversationId: "agent:main:qa",
			runId: "run-1",
			harnessVersionId: "hv-1",
			eventIds: [],
			rationaleRecordIds: [],
			artifactIds: [],
			workstation: null,
			evalResultId: null,
			bundleUri: null,
			summary: null,
			metadata: { bodyExecutionResult },
		});
	});

	it("projects body workstation evidence into trace bundle session ids", () => {
		const bodyExecutionResult = buildBodyExecutionResult({
			bodyKind: "kernel",
			status: "completed",
			runId: "run-workstation-1",
			traceBundleId: "run-workstation-1:bundle",
			workstation: {
				profileId: "general",
				workstationId: "ws_1",
				leaseId: "lease_1",
				sessionId: "session_1",
				participantIds: ["participant_cto"],
			},
			startedAt: "2026-06-13T10:00:00.000Z",
			endedAt: "2026-06-13T10:00:01.000Z",
		});

		expect(traceBundleWorkstationFromBodyResult(bodyExecutionResult)).toEqual({
			profileId: "general",
			workstationId: "ws_1",
			leaseId: "lease_1",
			sessionIds: ["session_1"],
			participantIds: ["participant_cto"],
		});
	});

	it("builds subject trace bundles without a tedi identity", () => {
		const bodyExecutionResult = buildBodyExecutionResult({
			bodyKind: "kernel",
			status: "blocked",
			runId: "home-run-1",
			orgId: "org-1",
			conversationId: "home:main",
			harnessVersionId: "khv-1",
			traceBundleId: "home-run-1:bundle",
			startedAt: "2026-06-13T10:00:00.000Z",
			endedAt: "2026-06-13T10:00:01.000Z",
		});

		const bundle = buildHarnessSubjectTraceBundle({
			id: "home-run-1:bundle",
			subjectKind: "kernel",
			subjectId: "kernel:org-1",
			tediId: null,
			orgId: "org-1",
			conversationId: "home:main",
			runId: "home-run-1",
			harnessVersionId: "khv-1",
			eventIds: ["event-1"],
			createdAt: "2026-06-13T10:00:01.000Z",
			outcome: "escalated",
			metadata: {
				routerVersion: "abc123",
				bodyExecutionResult: { spoofed: true },
			},
			bodyExecutionResult,
		});

		expect(bundle).toMatchObject({
			subjectKind: "kernel",
			subjectId: "kernel:org-1",
			tediId: null,
			eventIds: ["event-1"],
			outcome: "escalated",
			metadata: {
				routerVersion: "abc123",
				bodyExecutionResult,
			},
		});
	});

	it("keeps body execution result authoritative over extra metadata", () => {
		const bodyExecutionResult = buildBodyExecutionResult({
			bodyKind: "workstation",
			status: "completed",
			runId: "run-workstation",
			startedAt: "2026-06-13T10:00:00.000Z",
			endedAt: "2026-06-13T10:00:01.000Z",
		});

		expect(
			traceBundleMetadata({
				bodyExecutionResult,
				extraMetadata: {
					bodyExecutionResult: { id: "spoofed" },
					source: "test",
				},
			}),
		).toEqual({
			source: "test",
			bodyExecutionResult,
		});
	});
});
