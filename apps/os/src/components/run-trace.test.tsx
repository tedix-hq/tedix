import type {
	SkillRun,
	SkillWorkflowStep,
	SkillWorkflowToolCall,
} from "@tedix/api-contract/contracts/cognitive";
import { dynamicSkillDefinitionId } from "@tedix/api-contract/constants/workflow-definition-keys";
import type { WorkflowDefinitionHealth } from "@tedix/api-contract/contracts/workflows";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import {
	engineStatusLabel,
	findSkillDefinitionHealth,
	partitionEventGates,
	reconciliationLabel,
	reconciliationTone,
	RunEventGateRow,
	RunReconciliationPanel,
	RunToolCallRow,
	summarizeEventEvidence,
	toolCallTarget,
} from "./run-trace";

const SKILL_ID = "22222222-2222-4222-8222-222222222222";

function makeStep(
	overrides: Partial<SkillWorkflowStep> = {},
): SkillWorkflowStep {
	return {
		path: "epochs/0/steps/fetch/1/attempts/1.json",
		name: "fetch",
		count: 1,
		executionEpoch: 0,
		kind: "attempt",
		outcome: "success",
		provenance: "step_artifact",
		mimeType: "application/json",
		sizeBytes: 128,
		...overrides,
	};
}

function makeToolCall(
	overrides: Partial<SkillWorkflowToolCall> = {},
): SkillWorkflowToolCall {
	return {
		...makeStep(),
		kind: "tool_call",
		path: "epochs/0/calls/gmail/send/1.json",
		...overrides,
	} as SkillWorkflowToolCall;
}

function makeRun(overrides: Partial<SkillRun> = {}): SkillRun {
	return {
		id: "run-1",
		organizationId: "org-1",
		skillId: SKILL_ID,
		tediId: "tedi-1",
		workflowInstanceId: "wf-abc123",
		runtimeEnvironment: "production",
		executionEpoch: 0,
		status: "completed",
		...overrides,
	};
}

describe("toolCallTarget", () => {
	it("prefers the governed namespace.method receipt identity", () => {
		expect(
			toolCallTarget(makeToolCall({ namespace: "gmail", method: "send" })),
		).toBe("gmail.send");
	});

	it("falls back to the step name when the receipt has no target", () => {
		expect(
			toolCallTarget(
				makeToolCall({ namespace: null, method: null, name: "notify" }),
			),
		).toBe("notify");
	});
});

describe("partitionEventGates", () => {
	it("splits waiting gates from resolved ones and ignores other steps", () => {
		const waiting = makeStep({ kind: "wait_for_event", status: "waiting" });
		const resolved = makeStep({ kind: "wait_for_event", status: "resolved" });
		const attempt = makeStep({ kind: "attempt" });
		const gates = partitionEventGates([attempt, waiting, resolved]);
		expect(gates.waiting).toEqual([waiting]);
		expect(gates.resolved).toEqual([resolved]);
	});

	it("treats a gate with no lifecycle status as resolved, not actionable", () => {
		const gate = makeStep({ kind: "wait_for_event", status: null });
		expect(partitionEventGates([gate]).waiting).toHaveLength(0);
		expect(partitionEventGates([gate]).resolved).toEqual([gate]);
	});
});

describe("summarizeEventEvidence", () => {
	it("projects the response payload the gate resolved with", () => {
		const step = makeStep({
			kind: "wait_for_event",
			data: {
				eventType: "approval",
				approvalId: "apr-1",
				payload: { ok: true },
			},
		});
		expect(summarizeEventEvidence(step)).toBe('{"ok":true}');
	});

	it("falls back to non-envelope fields when no payload was recorded", () => {
		const step = makeStep({
			kind: "wait_for_event",
			data: { eventType: "approval", approvalId: "apr-1", decidedBy: "ada" },
		});
		expect(summarizeEventEvidence(step)).toBe('{"decidedBy":"ada"}');
	});

	it("returns null when the evidence is only the envelope", () => {
		const step = makeStep({
			kind: "wait_for_event",
			data: { eventType: "approval", approvalId: "apr-1" },
		});
		expect(summarizeEventEvidence(step)).toBeNull();
		expect(summarizeEventEvidence(makeStep({ data: null }))).toBeNull();
	});

	it("truncates long evidence instead of flooding the row", () => {
		const step = makeStep({
			kind: "wait_for_event",
			data: { note: "x".repeat(400) },
		});
		expect(summarizeEventEvidence(step, 40)).toHaveLength(41);
		expect(summarizeEventEvidence(step, 40)?.endsWith("…")).toBe(true);
	});
});

describe("findSkillDefinitionHealth", () => {
	const health: WorkflowDefinitionHealth[] = [
		{
			definitionId: dynamicSkillDefinitionId(SKILL_ID),
			title: "Weekly digest",
			kind: "dynamic_skill",
			lifecycleState: "proven",
			currentRevision: 4,
			healthStatus: "attention",
			driftStatus: "revision_mismatch",
			executionSurface: {
				kind: "skill_runtime_service",
				binding: "SKILL_WORKFLOW",
				available: true,
				checkedAt: "2026-08-12T08:31:00.000Z",
			},
			latestRun: null,
			notes: ["Latest run executed revision 3"],
		},
	];

	it("keys dynamic skill definitions by skill id", () => {
		expect(findSkillDefinitionHealth(health, SKILL_ID)?.title).toBe(
			"Weekly digest",
		);
		expect(findSkillDefinitionHealth(health, "other")).toBeUndefined();
	});
});

describe("reconciliation state", () => {
	it("treats a retired instance as a permanent fence", () => {
		const run = makeRun({
			workflowRetiredAt: "2026-08-12T00:00:00.000Z",
			lastReconciledAt: "2026-08-12T00:00:00.000Z",
		});
		expect(reconciliationTone(run)).toBe("blocked");
		expect(reconciliationLabel(run)).toBe("Instance retired");
	});

	it("flags a row the reconciler has never verified", () => {
		const run = makeRun({ lastReconciledAt: null });
		expect(reconciliationTone(run)).toBe("warn");
		expect(reconciliationLabel(run)).toBe("Never reconciled");
	});

	it("separates in-flight rows from settled ones", () => {
		const at = "2026-08-12T08:31:00.000Z";
		expect(
			reconciliationTone(makeRun({ status: "running", lastReconciledAt: at })),
		).toBe("active");
		expect(
			reconciliationTone(
				makeRun({ status: "completed", lastReconciledAt: at }),
			),
		).toBe("done");
	});
});

describe("engineStatusLabel", () => {
	it("reads only the stable lifecycle status off the opaque snapshot", () => {
		expect(engineStatusLabel({ status: "waiting_for_event" })).toBe(
			"waiting for event",
		);
		expect(engineStatusLabel({ output: {} })).toBeNull();
		expect(engineStatusLabel(null)).toBeNull();
	});
});

describe("RunToolCallRow", () => {
	it("renders the call target, timing, and the MCP receipt evidence", () => {
		const html = renderToStaticMarkup(
			<RunToolCallRow
				call={makeToolCall({
					namespace: "gmail",
					method: "send",
					name: "notify-owner",
					durationMs: 940,
					status: "succeeded",
					phase: "execute",
					callId: "call-77",
					idempotencyKey: "idem-77",
					providerConfirmation: "gmail-ack-1",
				})}
			/>,
		);
		expect(html).toContain("gmail.send");
		expect(html).toContain("step notify-owner");
		expect(html).toContain("execute");
		expect(html).toContain("940ms");
		expect(html).toContain("call call-77");
		expect(html).toContain("idempotency idem-77");
		expect(html).toContain("provider gmail-ack-1");
		expect(html).toContain('data-slot="icon-frame"');
		expect(html).toContain('data-appearance="fill"');
		expect(html).toContain('data-size="md"');
	});

	it("says an idempotency key was requested but never returned", () => {
		const html = renderToStaticMarkup(
			<RunToolCallRow
				call={makeToolCall({
					namespace: "stripe",
					method: "create_refund",
					idempotencyKey: null,
					idempotencyRequested: true,
					outcome: "failure",
				})}
			/>,
		);
		expect(html).toContain("idempotency requested, no key returned");
		expect(html).toContain('data-outcome="failure"');
	});
});

describe("RunEventGateRow", () => {
	it("renders a waiting gate with its event type and wait time", () => {
		const html = renderToStaticMarkup(
			<RunEventGateRow
				step={makeStep({
					kind: "wait_for_event",
					status: "waiting",
					outcome: "pending",
					name: "spend-approval",
					durationMs: 96_000,
					data: { eventType: "approval", approvalId: "apr-2" },
				})}
			/>,
		);
		expect(html).toContain('data-status="waiting"');
		expect(html).toContain("Waiting");
		expect(html).toContain("approval");
		expect(html).toContain("spend-approval");
		expect(html).toContain("waiting 1m 36s");
		expect(html).toContain('data-slot="icon-frame"');
		expect(html).toContain('data-appearance="fill"');
	});

	it("renders a resolved gate with the response payload it received", () => {
		const html = renderToStaticMarkup(
			<RunEventGateRow
				step={makeStep({
					kind: "wait_for_event",
					status: "resolved",
					name: "publish-approval",
					data: {
						eventType: "approval",
						payload: { decision: "approved" },
					},
				})}
			/>,
		);
		expect(html).toContain("Resolved");
		expect(html).toContain("&quot;decision&quot;:&quot;approved&quot;");
	});
});

describe("RunReconciliationPanel surface contract", () => {
	/**
	 * The reconciliation panel is a bounded region nested inside the run
	 * detail's evidence column, not a peer of a `Card`, so it takes the
	 * `Surface` well tier and keeps the 8px control radius.
	 */
	it("is a nested Surface well, not a hand-rolled bounded box", () => {
		const html = renderToStaticMarkup(
			<RunReconciliationPanel run={makeRun({})} />,
		);
		expect(html).toContain('data-slot="surface"');
		expect(html).toContain('data-tier="well"');
		expect(html).toContain("rounded-lg");
		expect(html).not.toContain("rounded-xl");
		expect(html).not.toContain("border-kumo-hairline px-4 py-3");
	});
});

describe("RunReconciliationPanel", () => {
	it("renders the binding namespace, reconciler stamp, and epoch", () => {
		const html = renderToStaticMarkup(
			<RunReconciliationPanel
				run={makeRun({
					runtimeEnvironment: "production",
					lastReconciledAt: "2026-08-12T08:31:00.000Z",
					executionEpoch: 2,
					restartRequestedAt: "2026-08-12T08:30:00.000Z",
					engine: { status: "running" },
				})}
			/>,
		);
		expect(html).toContain("production binding");
		expect(html).toContain("wf-abc123");
		expect(html).toContain("Execution epoch");
		expect(html).toContain(">2</strong>");
		expect(html).toContain("Restart requested");
		expect(html).toContain("Engine snapshot");
	});

	it("renders the canonical production binding discriminator", () => {
		const html = renderToStaticMarkup(
			<RunReconciliationPanel
				run={makeRun({
					runtimeEnvironment: "production",
					lastReconciledAt: null,
				})}
			/>,
		);
		expect(html).toContain("production binding");
		expect(html).toContain("Never reconciled");
		expect(html).toContain(">never</strong>");
	});

	it("warns that a retired instance can never be re-entered", () => {
		const html = renderToStaticMarkup(
			<RunReconciliationPanel
				run={makeRun({ workflowRetiredAt: "2026-08-12T00:00:00.000Z" })}
			/>,
		);
		expect(html).toContain("permanently retired");
		expect(html).toContain('data-tone="blocked"');
	});

	it("surfaces definition drift and execution-surface availability", () => {
		const html = renderToStaticMarkup(
			<RunReconciliationPanel
				run={makeRun()}
				definitionHealth={{
					definitionId: dynamicSkillDefinitionId(SKILL_ID),
					title: "Weekly digest",
					kind: "dynamic_skill",
					lifecycleState: "proven",
					currentRevision: 4,
					healthStatus: "attention",
					driftStatus: "revision_mismatch",
					executionSurface: {
						kind: "skill_runtime_service",
						binding: "SKILL_WORKFLOW",
						available: false,
						checkedAt: "2026-08-12T08:31:00.000Z",
					},
					latestRun: null,
					notes: ["Latest run executed revision 3"],
				}}
			/>,
		);
		expect(html).toContain("revision mismatch");
		expect(html).toContain("SKILL_WORKFLOW");
		expect(html).toContain("unavailable");
		expect(html).toContain("Latest run executed revision 3");
	});
});
