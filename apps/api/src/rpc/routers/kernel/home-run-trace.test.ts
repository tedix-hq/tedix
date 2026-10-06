import { describe, expect, it } from "vite-plus/test";
import {
	expectedHomeTraceBundleId,
	homeRunTraceBranchEvidence,
	homeRunTraceBranchRefs,
	homeRunTraceLatency,
	homeRunTraceRequiresSynthesis,
	homeRunTraceWakeIsPending,
	synthesisChildRunIds,
	synthesisEventBelongsToHomeRun,
} from "./home-run-trace";

function runRow() {
	return {
		id: "home-1",
		organizationId: "org-1",
		conversationId: "home:main",
		status: "completed" as const,
		inputMessageId: null,
		outputMessageId: null,
		delegatedTediId: "tedi-cto",
		childRunId: "child-cto",
		childConversationId: null,
		progressValue: 100,
		progressLabel: "Complete",
		progressDetail: null,
		latestEventKind: "run.completed" as const,
		latestEventAt: "2026-07-12T12:00:00.000Z",
		preview: null,
		runtimeBackend: "custom" as const,
		runtimeExternalId: null,
		runtimeExternalUrl: null,
		runtimeMetadata: null,
		metadata: {
			workItemId: "wi-cto",
			homePlan: {
				assignments: [
					{
						ownerTediId: "tedi-cto",
						childRunId: "child-cto",
						workItemId: "wi-cto",
					},
					{
						ownerTediId: "tedi-cpo",
						childRunId: "child-cpo",
						workItemId: "wi-cpo",
					},
				],
			},
		},
		startedAt: "2026-07-12T11:59:00.000Z",
		completedAt: "2026-07-12T12:00:00.000Z",
		createdAt: "2026-07-12T11:59:00.000Z",
		updatedAt: "2026-07-12T12:00:00.000Z",
	};
}

describe("home run trace convergence", () => {
	it("requires synthesis for completed or failed branches, not operator cancellation", () => {
		expect(
			homeRunTraceRequiresSynthesis({ branchCount: 1, status: "completed" }),
		).toBe(true);
		expect(
			homeRunTraceRequiresSynthesis({ branchCount: 1, status: "failed" }),
		).toBe(true);
		expect(
			homeRunTraceRequiresSynthesis({ branchCount: 1, status: "canceled" }),
		).toBe(false);
		expect(
			homeRunTraceRequiresSynthesis({ branchCount: 0, status: "completed" }),
		).toBe(false);
	});

	it("does not require a queued wake to acknowledge after parent cancellation", () => {
		expect(
			homeRunTraceWakeIsPending({
				ackedAt: null,
				parentStatus: "canceled",
			}),
		).toBe(false);
		expect(
			homeRunTraceWakeIsPending({
				ackedAt: null,
				parentStatus: "completed",
			}),
		).toBe(true);
	});

	it("deduplicates the direct child while retaining every plan assignment", () => {
		expect(homeRunTraceBranchRefs(runRow())).toEqual([
			{
				delegatedTediId: "tedi-cto",
				childRunId: "child-cto",
				workItemId: "wi-cto",
			},
			{
				delegatedTediId: "tedi-cpo",
				childRunId: "child-cpo",
				workItemId: "wi-cpo",
			},
		]);
	});

	it("classifies tool, workstation, artifact, final-message, and terminal refs", () => {
		const common = {
			approvalRequestId: null,
			artifactId: null,
			conversationId: "agent:main",
			messageId: null,
			organizationId: "org-1",
			payload: null,
			runId: "child-cto",
			runtimeBackend: "cloudflare-agents" as const,
			runtimeExternalId: null,
			runtimeExternalUrl: null,
			runtimeMetadata: null,
			sequence: null,
			tediId: "tedi-cto",
			toolCallId: null,
			delta: null,
		};
		const branch = homeRunTraceBranchEvidence({
			ref: {
				delegatedTediId: "tedi-cto",
				childRunId: "child-cto",
				workItemId: "wi-cto",
			},
			rows: {
				observedRunIds: ["child-cto", "runtime-child-cto"],
				eventRows: [
					{
						...common,
						id: "run-terminal",
						kind: "run.completed",
						createdAt: "2026-07-12T12:04:00.000Z",
					},
					{
						...common,
						id: "final-message",
						kind: "message.completed",
						createdAt: "2026-07-12T12:03:00.000Z",
					},
					{
						...common,
						id: "workstation-process",
						kind: "workstation.egress.allow",
						createdAt: "2026-07-12T12:02:00.000Z",
					},
					{
						...common,
						id: "workstation-process-artifact",
						kind: "artifact.created",
						payload: {
							artifact: {
								name: "workstation_process/job-1/stdout.log",
								metadata: {
									eventType: "workstation.process.completed",
									exitCode: 0,
									processId: "job-1",
									source: "workstation_process",
								},
							},
						},
						createdAt: "2026-07-12T12:01:30.000Z",
					},
					{
						...common,
						id: "tool-completed",
						kind: "tool.completed",
						createdAt: "2026-07-12T12:01:00.000Z",
					},
				],
				artifactRows: [
					{
						id: "artifact-1",
						organizationId: "org-1",
						tediId: "tedi-cto",
						conversationId: "agent:main",
						runId: "child-cto",
						messageId: null,
						kind: "document" as const,
						name: "proof",
						mimeType: "text/plain",
						uri: null,
						sizeBytes: 5,
						metadata: null,
						createdAt: "2026-07-12T12:02:30.000Z",
					},
				],
			},
		});

		expect(branch).toMatchObject({
			status: "completed",
			toolEventIds: ["tool-completed"],
			workstationEventIds: [
				"workstation-process",
				"workstation-process-artifact",
			],
			artifactIds: ["artifact-1"],
			finalMessageEventId: "final-message",
			terminalEventId: "run-terminal",
			evidenceAvailable: true,
		});
	});

	it("uses the existing deterministic harness trace anchor id", () => {
		expect(expectedHomeTraceBundleId("home-1")).toBe("home-1:bundle");
	});

	it("derives durable wake and synthesis latency from canonical timestamps", () => {
		expect(
			homeRunTraceLatency({
				createdAt: "2026-07-12T11:59:00.000Z",
				completedAt: "2026-07-12T12:00:00.000Z",
				wakeReceipts: [
					{
						queuedAt: "2026-07-12T11:59:55.000Z",
						ackedAt: "2026-07-12T11:59:55.300Z",
					},
					{
						queuedAt: "2026-07-12T11:59:56.000Z",
						ackedAt: "2026-07-12T11:59:56.450Z",
					},
				],
				synthesis: [{ createdAt: "2026-07-12T11:59:56.700Z" }],
			}),
		).toEqual({
			parentElapsedMs: 60_000,
			maxWakeQueueMs: 450,
			finalWakeToSynthesisMs: 700,
		});
	});

	it("reports unavailable latency honestly instead of manufacturing zeroes", () => {
		expect(
			homeRunTraceLatency({
				createdAt: "not-a-date",
				completedAt: null,
				wakeReceipts: [{ queuedAt: "2026-07-12T12:00:00Z", ackedAt: null }],
				synthesis: [],
			}),
		).toEqual({
			parentElapsedMs: null,
			maxWakeQueueMs: null,
			finalWakeToSynthesisMs: null,
		});
	});

	it("trusts explicit plan branches over a cross-plan wake batch", () => {
		expect(
			synthesisChildRunIds({
				payload: {
					metadata: {
						branchRunIds: ["child-first", "child-last", "child-optional"],
					},
				},
			}),
		).toEqual(["child-first", "child-last", "child-optional"]);
	});

	it("does not treat wake inbox metadata as synthesis provenance", () => {
		expect(
			synthesisChildRunIds({
				payload: { metadata: {} },
			}),
		).toEqual([]);
	});

	it("recognizes direct async-completion child evidence without a wake batch", () => {
		expect(
			synthesisChildRunIds({
				payload: {
					metadata: {
						asyncCompletion: true,
						childRunId: "child-direct",
					},
				},
			}),
		).toEqual(["child-direct"]);
	});

	it("rejects a neighboring plan synthesis from the same alarm batch", () => {
		expect(
			synthesisEventBelongsToHomeRun({
				eventRunId: "home-plan-b",
				homeRunId: "home-plan-a",
				hasHomePlan: true,
			}),
		).toBe(false);
		expect(
			synthesisEventBelongsToHomeRun({
				eventRunId: "home-plan-a",
				homeRunId: "home-plan-a",
				hasHomePlan: true,
			}),
		).toBe(true);
	});

	it("retains child-id matching for direct delegation synthesis", () => {
		expect(
			synthesisEventBelongsToHomeRun({
				eventRunId: "wake-run",
				homeRunId: "direct-parent",
				hasHomePlan: false,
			}),
		).toBe(true);
	});
});
