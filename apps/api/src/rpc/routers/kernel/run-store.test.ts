import type {
	HomePlan,
	HomePlanAssignment,
	TediRunStatus,
} from "@tedix/api-contract/schemas/kernel-runtime";
import { homeRuntimeEventId } from "@tedix/api-contract/utils/runtime-events";
import type { kernelRuntimeRuns } from "@tedix/db/schema";
import { describe, expect, it } from "vite-plus/test";
import {
	asyncCompletionAssistantMessageId,
	homeDelegationCompletionContent,
	homePlanFinalSynthesisContent,
	homeRunStatusFromChildStatus,
	normalizeHomeRunRecord,
	reconcileHomePlanWithChildStatuses,
	homeDelegationProofMetadata,
	homeDelegationVerdictMetadata,
} from "./run-store";
import { childRunStatusKey } from "./runtime-shared";

type RunRow = typeof kernelRuntimeRuns.$inferSelect;

const NOW = "2026-07-01T00:00:00.000Z";

function makeRunRow(overrides: Partial<RunRow> = {}): RunRow {
	return {
		id: "run-1",
		organizationId: "org-1",
		conversationId: "home:main",
		status: "running",
		inputMessageId: null,
		outputMessageId: null,
		delegatedTediId: null,
		childRunId: null,
		childConversationId: null,
		progressValue: null,
		progressLabel: null,
		progressDetail: null,
		latestEventAt: null,
		latestEventKind: null,
		preview: null,
		runtimeBackend: "custom",
		runtimeExternalId: "run-1",
		runtimeExternalUrl: null,
		runtimeMetadata: {},
		metadata: {},
		startedAt: NOW,
		completedAt: null,
		createdAt: NOW,
		updatedAt: NOW,
		...overrides,
	} as unknown as RunRow;
}

function makeChildSummary(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		childRunStatus: "running",
		childRunPreview: null,
		childRunLatestEventAt: null,
		childRunLatestEventKind: null,
		childRunTerminalAt: null,
		childRunEventCount: 1,
		...overrides,
	};
}

function makeAssignment(
	overrides: Partial<HomePlanAssignment> = {},
): HomePlanAssignment {
	return {
		id: "assignment-1",
		ownerTediId: "tedi-cto",
		ownerLabel: "CTO",
		routeKind: "agent",
		objective: "ship the thing",
		expectedEvidence: [],
		risk: "low",
		confidence: 0.9,
		requiresApproval: true,
		required: true,
		status: "queued",
		...overrides,
	};
}

function makePlan(overrides: Partial<HomePlan> = {}): HomePlan {
	return {
		id: "plan-1",
		status: "dispatching",
		summary: "a plan",
		source: "kernelRuntime.plan.v0",
		createdAt: NOW,
		assignments: [],
		attentionRoutes: [],
		dependencies: [],
		...overrides,
	};
}

describe("homeRunStatusFromChildStatus", () => {
	it("maps terminal child statuses through unchanged", () => {
		expect(homeRunStatusFromChildStatus("completed", "queued")).toBe(
			"completed",
		);
		expect(homeRunStatusFromChildStatus("failed", "queued")).toBe("failed");
		expect(homeRunStatusFromChildStatus("canceled", "queued")).toBe("canceled");
	});

	it("collapses running/streaming to running and passes queued/approval through", () => {
		expect(homeRunStatusFromChildStatus("running", "queued")).toBe("running");
		expect(homeRunStatusFromChildStatus("streaming", "queued")).toBe("running");
		expect(homeRunStatusFromChildStatus("requires_approval", "queued")).toBe(
			"requires_approval",
		);
		expect(homeRunStatusFromChildStatus("queued", "running")).toBe("queued");
	});

	it("returns the fallback when child status is undefined", () => {
		const fallback: TediRunStatus = "requires_approval";
		expect(homeRunStatusFromChildStatus(undefined, fallback)).toBe(fallback);
	});
});

describe("normalizeHomeRunRecord", () => {
	it("retains the declared task failure separately from runtime completion", () => {
		const row = makeRunRow({
			delegatedTediId: "tedi-cto",
			childRunId: "child-1",
		});
		const summaries = new Map([
			[
				childRunStatusKey("tedi-cto", "child-1"),
				makeChildSummary({
					childRunStatus: "completed",
					childTaskOutcome: "failed",
					childRunPreview: "Outcome: failed\nI did not publish.",
				}),
			],
		]);
		const run = normalizeHomeRunRecord(row, summaries);
		expect(run.status).toBe("completed");
		expect(run.metadata).toMatchObject({ childTaskOutcome: "failed" });
	});

	it("maps a plain non-delegated run and never fills timeoutAt", () => {
		const run = normalizeHomeRunRecord(
			makeRunRow({
				status: "running",
				inputMessageId: "msg-in",
				preview: "row preview",
				latestEventAt: "2026-07-01T00:05:00.000Z",
				latestEventKind: "message.delta",
			}),
		);
		expect(run.id).toBe("run-1");
		expect(run.organizationId).toBe("org-1");
		expect(run.conversationId).toBe("home:main");
		expect(run.status).toBe("running");
		expect(run.inputMessageId).toBe("msg-in");
		expect(run.delegatedTediId).toBeNull();
		expect(run.childRunId).toBeNull();
		// Non-terminal → no completedAt; timeoutAt is always null on this surface.
		expect(run.completedAt).toBeNull();
		expect(run.timeoutAt).toBeNull();
		// With no child status the run-derived preview falls back to row.preview.
		expect(run.metadata?.childRunPreview).toBe("row preview");
		expect(run.metadata?.childRunStatus).toBe("running");
		// updatedAt/latestEventAt fall back to the row fields when no child summary.
		expect(run.metadata?.childRunLatestEventAt).toBe(
			"2026-07-01T00:05:00.000Z",
		);
		expect(run.metadata?.childRunLatestEventKind).toBe("message.delta");
	});

	it("prefers the row's own progress when no child status is present", () => {
		const run = normalizeHomeRunRecord(
			makeRunRow({
				progressValue: 40,
				progressLabel: "Working",
				progressDetail: "step 2",
			}),
		);
		expect(run.progress).toEqual({
			current: 40,
			total: 100,
			label: "Working",
			detail: "step 2",
		});
	});

	it("derives status/preview/completedAt from the child summary for a delegated run", () => {
		const terminalAt = "2026-07-01T01:00:00.000Z";
		const childKey = childRunStatusKey("tedi-cto", "child-1");
		const run = normalizeHomeRunRecord(
			makeRunRow({
				status: "running",
				delegatedTediId: "tedi-cto",
				childRunId: "child-1",
				childConversationId: "child:conv",
				preview: "stale row preview",
				metadata: { delegationStatus: "queued" },
			}),
			new Map([
				[
					childKey,
					makeChildSummary({
						childRunStatus: "completed",
						childRunPreview: "child done",
						childRunTerminalAt: terminalAt,
						childRunLatestEventAt: terminalAt,
						childRunLatestEventKind: "run.completed",
						childRunEventCount: 3,
					}),
				],
			]),
		);
		// Terminal child status wins over the row's own "running".
		expect(run.status).toBe("completed");
		// Preview + terminal timestamp come from the child summary, not the row.
		expect(run.metadata?.childRunPreview).toBe("child done");
		expect(run.completedAt).toBe(terminalAt);
		expect(run.updatedAt).toBe(terminalAt);
		expect(run.childRunId).toBe("child-1");
		expect(run.metadata?.childConversationId).toBe("child:conv");
		expect(run.metadata?.childRunStatus).toBe("completed");
		expect(run.metadata?.delegationStatus).toBe("completed");
	});

	it.each(["cached running", "late completed"])(
		"keeps parent cancellation authoritative with %s child evidence",
		(evidence) => {
			const canceledAt = "2026-07-01T01:00:00.000Z";
			const childAt =
				evidence === "cached running" ? NOW : "2026-07-01T02:00:00.000Z";
			const child = makeChildSummary({
				childRunStatus: evidence === "cached running" ? "running" : "completed",
				childRunPreview: "child output",
				childRunLatestEventAt: childAt,
				childRunTerminalAt: evidence === "late completed" ? childAt : null,
			});
			const row = makeRunRow({
				status: "canceled",
				delegatedTediId: "tedi-cto",
				childRunId: "child-1",
				preview: "Home run canceled by operator: stop",
				completedAt: canceledAt,
				updatedAt: canceledAt,
				progressValue: 100,
				progressLabel: "Stopped",
				progressDetail: "no runtime events",
				metadata: child,
			});
			const summaries =
				evidence === "late completed"
					? new Map([[childRunStatusKey("tedi-cto", "child-1"), child]])
					: new Map();
			for (let read = 0; read < 2; read += 1) {
				const run = normalizeHomeRunRecord(row, summaries);
				expect(run).toMatchObject({
					status: "canceled",
					completedAt: canceledAt,
					updatedAt: canceledAt,
					progress: {
						current: 100,
						total: 100,
						label: "Stopped",
						detail: "no runtime events",
					},
					metadata: {
						childRunPreview: row.preview,
						childRunStatus: child.childRunStatus,
						delegationStatus: "canceled",
						childRunLatestEventAt: childAt,
					},
				});
			}
		},
	);

	it("reads a persisted marker-only 'partial' as failed with the runtime's stop reason", () => {
		// Older rows persisted `partial` for a stop that left only the runtime's
		// early-stop notice behind. Nothing was produced: that is a failed run.
		const marker =
			"[Turn stopped early: per-turn provider-call ceiling reached (10/10 steps). Partial results above; remaining work was not attempted.]";
		const run = normalizeHomeRunRecord(
			makeRunRow({
				status: "completed",
				delegatedTediId: "tedi-cto",
				childRunId: "child-legacy-ceiling",
				preview: marker,
				completedAt: "2026-07-01T01:00:00.000Z",
				progressValue: 25,
				progressLabel: "Complete",
				metadata: {
					childRunPreview: marker,
					childRunStatus: "partial",
					childRunStopReason: "step_ceiling",
				},
			}),
		);
		expect(run).toMatchObject({
			status: "failed",
			metadata: {
				childRunPreview: marker,
				childRunStatus: "failed",
				childRunStopReason: "step_ceiling",
				childRunStopDetail:
					"Stopped after 10 steps: per-turn provider-call ceiling reached",
				delegationStatus: "failed",
			},
		});
		expect(run.progress).toEqual({
			current: 100,
			total: 100,
			label: "Failed",
			detail: "Stopped after 10 steps: per-turn provider-call ceiling reached",
		});
	});

	it("keeps a stop with a real text report as partial and says why in the progress detail", () => {
		const content =
			"Two of five checks passed.\n\n[Turn stopped early: per-turn provider-call ceiling reached (10/10 steps). Partial results above; remaining work was not attempted.]";
		const run = normalizeHomeRunRecord(
			makeRunRow({
				status: "completed",
				delegatedTediId: "tedi-cto",
				childRunId: "child-partial",
				preview: content,
				completedAt: "2026-07-01T01:00:00.000Z",
				metadata: {
					childRunPreview: content,
					childRunStatus: "partial",
					childRunStopReason: "step_ceiling",
				},
			}),
		);
		expect(run.status).toBe("failed");
		expect(run.metadata?.childRunStatus).toBe("partial");
		expect(run.metadata?.delegationStatus).toBe("partial");
		expect(run.progress).toEqual({
			current: 100,
			total: 100,
			label: "Partial",
			detail:
				"Partial result — Stopped after 10 steps: per-turn provider-call ceiling reached; continuation required",
		});
	});

	it("does not reclassify cached terminal history from ordinary limit prose", () => {
		const preview =
			"The documented provider limit was checked; work is complete.";
		const run = normalizeHomeRunRecord(
			makeRunRow({
				status: "completed",
				delegatedTediId: "tedi-cto",
				childRunId: "child-normal-completion",
				preview,
				metadata: { childRunPreview: preview },
			}),
		);
		expect(run.status).toBe("completed");
		expect(run.metadata?.childRunStatus).toBe("completed");
		expect(run.metadata?.childRunStopReason).toBeUndefined();
	});

	it("preserves a structured workflow inspection on normalized run metadata", () => {
		const childKey = childRunStatusKey("tedi-cto", "child-workflow");
		const kernelWorkflowInspect = {
			status: "completed",
			workflowRunId: "workflow-run-1",
			workflowSlug: "kernel-goal-loop",
			workflowTediId: "tedi-cto",
		};
		const run = normalizeHomeRunRecord(
			makeRunRow({
				delegatedTediId: "tedi-cto",
				childRunId: "child-workflow",
			}),
			new Map([
				[
					childKey,
					makeChildSummary({
						childRunStatus: "completed",
						kernelWorkflowInspect,
					}),
				],
			]),
		);
		expect(run.metadata?.kernelWorkflowInspect).toEqual(kernelWorkflowInspect);
	});

	it("keeps the explicit durable result preview over stale child chatter", () => {
		const childKey = childRunStatusKey("tedi-cto", "child-durable");
		const run = normalizeHomeRunRecord(
			makeRunRow({
				status: "completed",
				delegatedTediId: "tedi-cto",
				childRunId: "child-durable",
				preview:
					"Completed workspace.write_file in durable execution exec-durable.",
				metadata: {
					durableCodeResult: {
						executionId: "exec-durable",
						status: "completed",
					},
				},
			}),
			new Map([
				[
					childKey,
					makeChildSummary({
						childRunStatus: "completed",
						childRunPreview: "search_tools(work item comment)",
					}),
				],
			]),
		);
		expect(run.metadata?.childRunPreview).toBe(
			"Completed workspace.write_file in durable execution exec-durable.",
		);
	});
});

describe("reconcileHomePlanWithChildStatuses", () => {
	it("reports no change when no child statuses advance the plan", () => {
		const plan = makePlan({
			status: "dispatching",
			assignments: [
				makeAssignment({ status: "queued", childRunId: "child-1" }),
			],
		});
		const result = reconcileHomePlanWithChildStatuses(plan, new Map());
		expect(result.changed).toBe(false);
		expect(result.terminalAssignments).toHaveLength(0);
		expect(result.plan.assignments[0].status).toBe("queued");
	});

	it("advances an assignment to terminal and recomputes plan status", () => {
		const childKey = childRunStatusKey("tedi-cto", "child-1");
		const plan = makePlan({
			status: "dispatching",
			assignments: [
				makeAssignment({
					id: "a1",
					ownerTediId: "tedi-cto",
					childRunId: "child-1",
					status: "queued",
				}),
			],
		});
		const result = reconcileHomePlanWithChildStatuses(
			plan,
			new Map([
				[
					childKey,
					makeChildSummary({
						childRunStatus: "completed",
						childRunPreview: "all done",
						childRunLatestEventAt: "2026-07-01T02:00:00.000Z",
						childRunTerminalAt: "2026-07-01T02:00:00.000Z",
						childRunEventCount: 5,
					}),
				],
			]),
		);
		expect(result.changed).toBe(true);
		expect(result.plan.assignments[0].status).toBe("completed");
		// Single completed assignment → whole plan reads completed.
		expect(result.plan.status).toBe("completed");
		expect(result.eventCount).toBe(5);
		expect(result.preview).toBe("all done");
		expect(result.terminalAssignments).toHaveLength(1);
		expect(result.terminalAssignments[0].status).toBe("completed");
		expect(result.terminalAssignments[0].previousStatus).toBe("queued");
		expect(result.terminalAt).toBe("2026-07-01T02:00:00.000Z");
	});

	it("carries the child preview into a failed assignment's error", () => {
		const childKey = childRunStatusKey("tedi-cto", "child-1");
		const plan = makePlan({
			status: "dispatching",
			assignments: [
				makeAssignment({
					id: "a1",
					ownerTediId: "tedi-cto",
					childRunId: "child-1",
					status: "running",
				}),
			],
		});
		const result = reconcileHomePlanWithChildStatuses(
			plan,
			new Map([
				[
					childKey,
					makeChildSummary({
						childRunStatus: "failed",
						childRunPreview: "boom",
					}),
				],
			]),
		);
		expect(result.changed).toBe(true);
		expect(result.plan.assignments[0].status).toBe("failed");
		expect(result.plan.assignments[0].error).toBe("boom");
		expect(result.plan.status).toBe("failed");
	});
});

describe("homePlanFinalSynthesisContent", () => {
	it("produces one compact, deterministic result table without run ids", () => {
		const plan = makePlan({
			status: "completed",
			assignments: [
				makeAssignment({
					id: "assignment-cto",
					ownerTediId: "tedi-cto",
					ownerLabel: "CTO",
					childRunId: "child-run-very-long-cto",
					status: "completed",
				}),
				makeAssignment({
					id: "assignment-cpo",
					ownerTediId: "tedi-cpo",
					ownerLabel: "CPO",
					childRunId: "child-run-very-long-cpo",
					status: "completed",
				}),
			],
		});
		const statuses = new Map<string, Record<string, unknown>>([
			[
				childRunStatusKey("tedi-cto", "child-run-very-long-cto"),
				{
					childRunPreview:
						"Completed and reported to Home Work Item `5eed0004-0000-4000-8000-000000000004`. Latest commit validated.",
				},
			],
			[
				childRunStatusKey("tedi-cpo", "child-run-very-long-cpo"),
				{ childRunPreview: "Runtime is healthy." },
			],
		]);
		const content = homePlanFinalSynthesisContent(plan, statuses);
		expect(content).toContain("Coordinated work completed across 2 tedis.");
		expect(content).toContain(
			"| CTO | completed | Completed and reported to the delegated work item. Latest commit validated. |",
		);
		expect(content).toContain("| CPO | completed | Runtime is healthy. |");
		expect(content).not.toContain("child-run-very-long");
		expect(content).not.toContain("5eed0004-0000-4000-8000-000000000004");
	});
});

describe("durable home event/message id formats", () => {
	// These id strings are durable D1 keys and idempotency anchors. The
	// helper-produced ids MUST stay byte-identical to the historical inline
	// literal formats pinned below. Do not change either side independently.
	it("homeRuntimeEventId reproduces the inline literal shapes byte-for-byte", () => {
		// delegation completion (homeDelegationCompletionEventId)
		expect(
			homeRuntimeEventId({
				organizationId: "org-1",
				kind: "message.completed",
				conversationId: "home:main",
				runId: "run-1",
				suffix: "delegation-completion",
			}),
		).toBe(
			"home:org-1:event:message.completed:home:main:run-1:delegation-completion",
		);
		// plan-assignment completion (assignment id + tag carried in suffix)
		expect(
			homeRuntimeEventId({
				organizationId: "org-1",
				kind: "message.completed",
				conversationId: "home:main",
				runId: "run-1",
				suffix: "assignment-1:plan-assignment-completion",
			}),
		).toBe(
			"home:org-1:event:message.completed:home:main:run-1:assignment-1:plan-assignment-completion",
		);
		// delegated dispatch failure — run.failed event
		expect(
			homeRuntimeEventId({
				organizationId: "org-1",
				kind: "run.failed",
				conversationId: "home:main",
				runId: "run-1",
				suffix: "delegation-dispatch",
			}),
		).toBe("home:org-1:event:run.failed:home:main:run-1:delegation-dispatch");
		// delegated dispatch failure — completion message event
		expect(
			homeRuntimeEventId({
				organizationId: "org-1",
				kind: "message.completed",
				conversationId: "home:main",
				runId: "run-1",
				suffix: "delegation-dispatch-failed",
			}),
		).toBe(
			"home:org-1:event:message.completed:home:main:run-1:delegation-dispatch-failed",
		);
	});

	it("asyncCompletionAssistantMessageId reproduces the inline literal format", () => {
		expect(asyncCompletionAssistantMessageId("run-1")).toBe(
			"run-1:async-completion:assistant",
		);
	});
});

describe("homeDelegationCompletionContent — verdicts never enter the body", () => {
	// The body is exactly what the tedi wrote (or the synthesis). Proof and
	// output-contract verdicts ride as message metadata so the OS can render a
	// chip, never be concatenated into the body.
	it("relays the child's final message verbatim on completion", () => {
		expect(
			homeDelegationCompletionContent({
				preview: "some evidence",
				finalMessage: "All set.",
				status: "completed",
			}),
		).toBe("All set.");
	});

	it("uses the synthesis verbatim when present", () => {
		expect(
			homeDelegationCompletionContent({
				preview: "some evidence",
				synthesized: "Reviewed 3 invoices.",
				finalMessage: "raw child message, ignored when synthesized is set",
				status: "completed",
			}),
		).toBe("Reviewed 3 invoices.");
	});

	it("status-only template when there is neither a final message nor a synthesis", () => {
		expect(
			homeDelegationCompletionContent({
				preview: "some evidence",
				status: "completed",
			}),
		).toBe(
			"The delegated tedi finished the assignment. Latest evidence: some evidence",
		);
	});

	it("a marker-only stop says the tedi produced no output and why, not 'the assignment failed'", () => {
		const marker =
			"[Turn stopped early: per-turn cumulative input-token ceiling reached (750642/750000 input tokens over 17 steps). Partial results above; remaining work was not attempted.]";
		expect(
			homeDelegationCompletionContent({
				preview: marker,
				finalMessage: marker,
				status: "failed",
				stop: {
					outcome: "failed",
					detail:
						"Stopped after 17 steps: per-turn cumulative input-token ceiling reached",
				},
			}),
		).toBe(
			"The delegated tedi produced no output. Stopped after 17 steps: per-turn cumulative input-token ceiling reached; remaining work was not attempted.",
		);
	});

	it("a stop with a text report relays the report as a partial result", () => {
		const content =
			"Two of five checks passed.\n\n[Turn stopped early: per-turn provider-call ceiling reached (10/10 steps). Partial results above; remaining work was not attempted.]";
		expect(
			homeDelegationCompletionContent({
				preview: content,
				finalMessage: content,
				status: "failed",
				stop: {
					outcome: "partial",
					detail:
						"Stopped after 10 steps: per-turn provider-call ceiling reached",
				},
			}),
		).toBe(
			`The delegated tedi returned a partial result (Stopped after 10 steps: per-turn provider-call ceiling reached).\n\n${content}`,
		);
	});
});

describe("homeDelegationProofMetadata", () => {
	const base = {
		workItemDisposition: "accepted" as const,
		retryable: true,
		hasProof: false,
		evidenceState: "missing" as const,
	};

	it("completed_without_proof → unverified chip with the disclosure note", () => {
		expect(
			homeDelegationProofMetadata(
				{
					...base,
					outcome: "failed",
					failureReason: "completed_without_proof",
				},
				"completed",
			),
		).toEqual({
			verdict: "unverified",
			reason: "completed_without_proof",
			note: expect.stringContaining("No durable execution evidence"),
		});
	});

	it("unverified_execution_evidence → unverified chip", () => {
		expect(
			homeDelegationProofMetadata(
				{
					...base,
					outcome: "failed",
					failureReason: "unverified_execution_evidence",
				},
				"completed",
			),
		).toMatchObject({
			verdict: "unverified",
			reason: "unverified_execution_evidence",
			note: expect.stringContaining("could not be verified"),
		});
	});

	it("reported success never turns references into a verified chip", () => {
		expect(
			homeDelegationProofMetadata(
				{
					...base,
					outcome: "succeeded",
					workItemDisposition: "completed",
					failureReason: null,
					hasProof: true,
					evidenceState: "verified" as never,
				},
				"completed",
			),
		).toBeNull();
		expect(
			homeDelegationProofMetadata(
				{
					...base,
					outcome: "succeeded",
					workItemDisposition: "completed",
					failureReason: null,
				},
				"completed",
			),
		).toBeNull();
	});

	it("no chip for a failed/canceled child (the body already states the outcome) or a missing disposition", () => {
		expect(
			homeDelegationProofMetadata(
				{
					...base,
					outcome: "failed",
					failureReason: "completed_without_proof",
				},
				"failed",
			),
		).toBeNull();
		expect(homeDelegationProofMetadata(null, "completed")).toBeNull();
	});
});

describe("homeDelegationVerdictMetadata — output-contract task mode", () => {
	const schema = { type: "object", required: ["status"] };

	it("empty when there is nothing to disclose", () => {
		expect(
			homeDelegationVerdictMetadata({
				status: "completed",
				validatedContent: "All set.",
			}),
		).toEqual({});
	});

	it("silent on output-contract success (no affirmation key)", () => {
		expect(
			homeDelegationVerdictMetadata({
				status: "completed",
				outputSchema: schema,
				validatedContent: 'All set.\n```json\n{"status":"ok"}\n```',
			}),
		).toEqual({});
	});

	it("outputContract verdict on validation failure, body untouched", () => {
		const rawAnswer = "All set, though no structured output here.";
		const verdict = homeDelegationVerdictMetadata({
			status: "completed",
			outputSchema: schema,
			validatedContent: rawAnswer,
		});
		expect(verdict.outputContract).toMatchObject({ met: false });
		expect(verdict.outputContract?.errors.join("; ")).toContain(
			"no JSON object found in the final message matching the required output schema",
		);
		expect(
			homeDelegationCompletionContent({
				preview: null,
				finalMessage: rawAnswer,
				status: "completed",
			}),
		).toBe(rawAnswer);
	});

	it("does not validate a failed child's message", () => {
		expect(
			homeDelegationVerdictMetadata({
				status: "failed",
				outputSchema: schema,
				validatedContent: "It did not work.",
			}),
		).toEqual({});
	});

	it("composes proof + output-contract verdicts side by side", () => {
		const verdict = homeDelegationVerdictMetadata({
			status: "completed",
			outputSchema: schema,
			validatedContent: "Finished, no structured output.",
			disposition: {
				outcome: "failed",
				workItemDisposition: "accepted",
				failureReason: "completed_without_proof",
				retryable: true,
				hasProof: false,
				evidenceState: "missing",
			},
		});
		expect(verdict.delegationProof).toMatchObject({ verdict: "unverified" });
		expect(verdict.outputContract).toMatchObject({ met: false });
	});
});
