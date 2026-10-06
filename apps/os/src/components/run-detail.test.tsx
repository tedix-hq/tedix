import type {
	SkillWorkflowArtifactSummary,
	SkillWorkflowStep,
} from "@tedix/api-contract/contracts/cognitive";
import type { RationaleRecord } from "@tedix/api-contract/schemas/rationale-records";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { formatDurationMs } from "@/lib/time";
import { RunStatusChip } from "./activity-runs";
import {
	extractApprovalId,
	ConnectionRecoveryNotice,
	extractWaitEventType,
	formatBytes,
	RunArtifactRow,
	RunDetailSectionHeader,
	RunEvidenceList,
	RunRationaleEmpty,
	RunRationaleRow,
	RunStepRow,
} from "./run-detail";

describe("connection recovery notice", () => {
	it("routes to the correct owner settings and exposes plain-English continuation", () => {
		const gate = {
			schemaVersion: 1 as const,
			status: "waiting" as const,
			eventType: "connection_recovery_" + "a".repeat(24),
			executionEpoch: 2,
			stepName: "book",
			logicalCount: 1,
			namespace: "calendar",
			method: "create_event",
			requestDigest: "b".repeat(64),
			recovery: {
				providerId: "calendar",
				connectionInstanceId: "11111111-1111-4111-8111-111111111111",
				scope: "user" as const,
				scopes: ["calendar"],
			},
		};
		const html = renderToStaticMarkup(
			<ConnectionRecoveryNotice
				gate={gate}
				checking={false}
				onContinue={() => {}}
			/>,
		);
		expect(html).toContain('href="/account/connections"');
		expect(html).toContain("This operation has not run");
		expect(html).toContain("Check connection and continue");
		expect(html).not.toContain(gate.recovery.connectionInstanceId);
		const tenant = renderToStaticMarkup(
			<ConnectionRecoveryNotice
				gate={{ ...gate, recovery: { ...gate.recovery, scope: "tenant" } }}
				checking={true}
				onContinue={() => {}}
			/>,
		);
		expect(tenant).toContain('href="/admin/connections"');
		expect(tenant).toContain("disabled");
	});
});

describe("RunDetailSectionHeader", () => {
	it("uses the canonical Kumo section hierarchy with an optional count", () => {
		const html = renderToStaticMarkup(
			<RunDetailSectionHeader
				title="Tool calls"
				description="Governed MCP invocations and their provider receipts."
				count={12}
			/>,
		);
		expect(html).toContain('data-slot="section-header"');
		expect(html).toContain('data-slot="section-title"');
		expect(html).toContain("Tool calls");
		expect(html).toContain("Governed MCP invocations");
		expect(html).toContain('data-slot="badge"');
		expect(html).toContain(">12<");
	});
});

describe("RunEvidenceList", () => {
	it("uses one Kumo collection boundary with semantic divided rows", () => {
		const html = renderToStaticMarkup(
			<RunEvidenceList label="Steps">
				<li>First</li>
				<li>Second</li>
			</RunEvidenceList>,
		);
		expect(html).toContain('data-slot="collection"');
		expect(html).not.toContain('data-slot="card"');
		expect(html).toContain('aria-label="Steps"');
		expect(html).toContain("divide-y");
		expect(html.match(/<li/g)).toHaveLength(2);
	});
});

function makeStep(overrides: Partial<SkillWorkflowStep>): SkillWorkflowStep {
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

describe("RunStatusChip (shared with Activity)", () => {
	it("renders the status as a data-status Kumo badge, sentence-cased", () => {
		const html = renderToStaticMarkup(<RunStatusChip status="failed" />);
		expect(html).toContain('data-status="failed"');
		expect(html).toContain("Failed");
		expect(html).toContain('data-slot="badge"');
	});
});

describe("RunStepRow", () => {
	it("renders name, kind, status, and duration", () => {
		const html = renderToStaticMarkup(
			<RunStepRow step={makeStep({ status: "succeeded", durationMs: 1500 })} />,
		);
		expect(html).toContain(">fetch</strong>");
		expect(html).toContain("attempt");
		expect(html).toContain("succeeded");
		expect(html).toContain("1.5s");
		expect(html).toContain('data-outcome="success"');
	});

	it("labels tool calls with namespace.method and later attempts", () => {
		const html = renderToStaticMarkup(
			<RunStepRow
				step={makeStep({
					kind: "tool_call",
					namespace: "gmail",
					method: "send",
					attempt: 2,
					outcome: "failure",
					status: "failed",
				})}
			/>,
		);
		expect(html).toContain("gmail.send");
		expect(html).toContain("attempt 2");
		expect(html).toContain('data-outcome="failure"');
	});

	it("falls back to the outcome when no lifecycle status exists", () => {
		const html = renderToStaticMarkup(
			<RunStepRow step={makeStep({ outcome: "pending", status: null })} />,
		);
		expect(html).toContain("pending");
	});
});

describe("RunArtifactRow", () => {
	const artifact: SkillWorkflowArtifactSummary = {
		path: "outputs/report.json",
		mimeType: "application/json",
		sizeBytes: 2048,
		outcome: "success",
		attempt: 1,
		storage: "r2",
		sha256: "abcdef0123456789",
	};

	it("renders the ref, size, storage, and integrity hash", () => {
		const html = renderToStaticMarkup(<RunArtifactRow artifact={artifact} />);
		expect(html).toContain("outputs/report.json");
		expect(html).toContain("2 KB");
		expect(html).toContain("stored in R2");
		expect(html).toContain("sha256 abcdef012345");
		expect(html).toContain('data-slot="icon-frame"');
		expect(html).toContain('data-appearance="fill"');
		expect(html).toContain('data-size="md"');
	});
});

describe("RunRationaleRow", () => {
	const record: RationaleRecord = {
		id: "rat-1",
		tediId: "tedi-1",
		orgId: "org-1",
		action: "Escalated the invoice",
		rationale: "Amount exceeded the autonomous budget.",
		category: "escalation",
		confidence: 0.85,
		evidence: {},
		outcome: null,
		outcomeStatus: "pending",
		approvalRequestId: null,
		objectiveId: null,
		runId: "run-1",
		workItemId: "wi-1",
		toolCallRefs: null,
		proofRef: null,
		createdAt: "2026-08-13T00:00:00.000Z",
		completedAt: null,
	};

	it("renders action, rationale, confidence, and links", () => {
		const html = renderToStaticMarkup(<RunRationaleRow record={record} />);
		expect(html).toContain("Escalated the invoice");
		expect(html).toContain("Amount exceeded the autonomous budget.");
		expect(html).toContain("confidence 85%");
		expect(html).toContain("work item wi-1");
		expect(html).toContain('data-slot="icon-frame"');
		expect(html).toContain('data-appearance="fill"');
	});
});

describe("RunRationaleEmpty", () => {
	it("uses the quiet Kumo empty treatment and retains execution context", () => {
		const html = renderToStaticMarkup(
			<RunRationaleEmpty runId="run-1" workItemId="work-1" />,
		);
		expect(html).toContain('data-appearance="quiet"');
		expect(html).toContain("No rationale records reference this run");
		expect(html).toContain("run run-1 (work item work-1)");
	});
});

describe("formatting helpers", () => {
	it("formats durations with the shared dialect", () => {
		expect(formatDurationMs(250)).toBe("250ms");
		expect(formatDurationMs(1500)).toBe("1.5s");
		expect(formatDurationMs(65_000)).toBe("1m 05s");
		expect(formatDurationMs(120_000)).toBe("2m");
		expect(formatDurationMs(null)).toBeNull();
	});

	it("formats byte sizes", () => {
		expect(formatBytes(512)).toBe("512 B");
		expect(formatBytes(2048)).toBe("2 KB");
		expect(formatBytes(3 * 1024 * 1024)).toBe("3 MB");
	});
});

describe("approval evidence extraction", () => {
	it("reads approvalId and eventType from wait_for_event step data", () => {
		const step = makeStep({
			kind: "wait_for_event",
			status: "waiting",
			data: { approvalId: "apr-1", eventType: "approval" },
		});
		expect(extractApprovalId(step)).toBe("apr-1");
		expect(extractWaitEventType(step)).toBe("approval");
	});

	it("returns null when the evidence carries no approval id", () => {
		expect(extractApprovalId(makeStep({ data: "raw text" }))).toBeNull();
		expect(extractApprovalId(makeStep({ data: null }))).toBeNull();
		expect(extractWaitEventType(makeStep({ data: {} }))).toBeNull();
	});
});
