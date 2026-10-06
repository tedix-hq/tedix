import type { KernelRuntimeEvent } from "@tedix/api-contract/schemas/kernel-runtime";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../../orpc";
import {
	classifyDelegatedStop,
	delegationVerifyCommand,
} from "./delegated-stop";
import { renderDelegationWorkOrderMessage } from "./delegation-dispatch";
import { offsetIso } from "./runtime-shared";

/**
 * Focused unit tests for the pure/deterministic helpers extracted into the
 * workstation-attach leaf: the work-order builder, the approval-payload
 * parser/guard, the approval-request builder, and the kernel trace-bundle
 * shaper. DB-hitting helpers use minimal module mocks so the shaping logic —
 * not the queries — is under test (mirrors write-proposal.test.ts).
 */

const mocks = vi.hoisted(() => ({
	getApprovalRequestById: vi.fn(),
	createApprovalRequest: vi.fn(),
	ensureActiveKernelHarnessVersion: vi.fn(),
	recordHarnessSubjectTraceBundle: vi.fn(),
}));

vi.mock("@tedix/db/queries/approvals", () => ({
	getApprovalRequestById: mocks.getApprovalRequestById,
	createApprovalRequest: mocks.createApprovalRequest,
}));

vi.mock("@tedix/db/queries/harness-version/trace-bundles", () => ({
	recordHarnessSubjectTraceBundle: mocks.recordHarnessSubjectTraceBundle,
}));

vi.mock("../../../services/harness-persistence", () => ({
	ensureActiveKernelHarnessVersion: mocks.ensureActiveKernelHarnessVersion,
}));

import {
	ensureWorkstationAttachApprovalRequest,
	homeWorkstationAttachPayload,
	recordWorkstationAttachKernelTraceBundle,
	workstationAttachWorkOrder,
} from "./workstation-attach";

const DB = {} as const;
const context = { db: DB } as unknown as BaseContext;

function makeEvent(id: string): KernelRuntimeEvent {
	return { id } as unknown as KernelRuntimeEvent;
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("workstationAttachWorkOrder", () => {
	it("preserves a canonical repository execution requirement", () => {
		const workOrder = workstationAttachWorkOrder({
			approvalRequestId: "appr-repo",
			content: "Implement the accepted repository task.",
			delegateToTediId: "tedi-cto",
			runId: "run-repo",
			workItemId: "wi-repo",
			executionRequirement: {
				surface: "workstation",
				requiredCapabilities: ["repository_edit", "tests", "process"],
				fallbackSurface: null,
				prohibitedSurfaces: ["native", "managed_job"],
				satisfiable: true,
				reason: "the canonical Work Item requires repository execution",
			},
		});

		expect(workOrder.executionRequirement).toMatchObject({
			surface: "workstation",
			requiredCapabilities: ["repository_edit", "tests", "process"],
			prohibitedSurfaces: ["native", "managed_job"],
		});
	});

	it("preserves the verification command through dispatch and stop classification", () => {
		const verifyCommand = "git ls-remote origin HEAD";
		const wo = workstationAttachWorkOrder({
			approvalRequestId: "appr-1",
			content: "Verify the remote repository is accessible.",
			delegateToTediId: "tedi-cto",
			runId: "run-9",
			workItemId: "wi-7",
			verifyCommand,
		});
		const message = renderDelegationWorkOrderMessage({
			workOrder: wo,
			fallbackContent: wo.sourceContent,
			fallbackWorkOrderId: wo.id,
			label: "WORKSTATION",
		});
		expect(wo.verifyCommand).toBe(verifyCommand);
		expect(message).toContain(
			`run this exact command in your own environment: ${verifyCommand}`,
		);
		expect(message).toContain("Outcome: succeeded");
		expect(message).toContain("Outcome: failed");
		expect(message).toContain("Outcome: needs_follow_up");
		expect(
			classifyDelegatedStop({
				assistantText: "Outcome: succeeded\nRepository is accessible.",
				structuredStopReason: null,
				verifyCommand: delegationVerifyCommand({ delegationWorkOrder: wo }),
			}),
		).toMatchObject({ outcome: "partial", stopReason: "verification_missing" });
	});

	it.each([undefined, "wi-7"])(
		"renders execution authority without inventing an approval deadline (workItemId=%s)",
		(workItemId) => {
			const wo = workstationAttachWorkOrder({
				approvalRequestId: "appr-1",
				content: "Implement and publish the assigned change.",
				delegateToTediId: "tedi-cto",
				runId: "run-9",
				workItemId,
			});
			const message = renderDelegationWorkOrderMessage({
				workOrder: wo,
				fallbackContent: wo.sourceContent,
				fallbackWorkOrderId: wo.id,
				label: "WORKSTATION",
			});
			expect(message).not.toContain("Deadline (soft):");
			expect(message).not.toContain("approval window");
			expect(message).toContain("Continue while execution authority is valid");
			expect(message).toContain(
				"honor cancellation, enforced runtime budgets, and any explicit task deadline",
			);
			if (workItemId) {
				expect(message).toContain(
					"the runtime renews the exact assigned Work Attempt",
				);
				expect(message).toContain(
					"stop if its authority expires or is revoked",
				);
			} else {
				expect(message).not.toContain(
					"the runtime renews the exact assigned Work Attempt",
				);
			}
			expect(wo.status).toBe("requires_approval");
			expect(message).toContain("Failure policy: fail_closed");
		},
	);

	it("builds a requires_approval workstation.attach work order for the target tedi", () => {
		const wo = workstationAttachWorkOrder({
			approvalRequestId: "appr-1",
			content: "  build the thing  ",
			delegateToTediId: "tedi-cto",
			runId: "run-9",
		});
		expect(wo.id).toBe("work-order:run-9");
		expect(wo.approvalRequestId).toBe("appr-1");
		expect(wo.kind).toBe("workstation.attach");
		expect(wo.status).toBe("requires_approval");
		expect(wo.targetTediId).toBe("tedi-cto");
		expect(wo.executionRequirement.surface).toBe("workstation");
		expect(wo.executionRequirement.requiredCapabilities).toEqual(["process"]);
		expect(wo.objective).toBe(
			"Fulfill the Home operator request in Source request.",
		);
		expect(wo.sourceContent).toBe("  build the thing  ");
		expect(wo.resultContract).toMatchObject({
			progressEvents: true,
			timeoutSemantics: "required-before-dispatch",
			commitAck: "required-before-dispatch",
			visibleHomeWorkCard: true,
		});
	});

	it.each([
		{ name: "short", content: "Inspect the logs; report the exact failure." },
		{
			name: "long",
			content:
				"Review only the assigned candidate.\n" +
				"Retain each command receipt and its original outcome.\n".repeat(
					1_000,
				) +
				"Final instruction: preserve the unpublished change; do not deploy.",
		},
	])("renders the full $name request exactly once", ({ content }) => {
		const wo = workstationAttachWorkOrder({
			approvalRequestId: "appr-1",
			content,
			delegateToTediId: "tedi-cto",
			runId: "run-9",
			workItemId: "wi-7",
		});
		const message = renderDelegationWorkOrderMessage({
			workOrder: wo,
			fallbackContent: "This fallback must not replace the operator request.",
			fallbackWorkOrderId: "unused-fallback",
			label: "WORKSTATION",
		});
		expect(message.split(content)).toHaveLength(2);
		expect(message).toContain(`Source request:\n${content}\n`);
		expect(message).toContain(`Objective: ${wo.objective}`);
		expect(wo.objective).toContain("Source request");
		expect(wo.sourceContent).toBe(content);
		expect(wo).toMatchObject({
			id: "work-order:run-9",
			approvalRequestId: "appr-1",
			targetTediId: "tedi-cto",
			workItemId: "wi-7",
			status: "requires_approval",
			authorityMode: "shadow",
			executionRequirement: {
				surface: "workstation",
				requiredCapabilities: ["process"],
				fallbackSurface: null,
				prohibitedSurfaces: [],
				satisfiable: true,
			},
		});
	});

	it("omits workItemId when absent and includes it when provided", () => {
		expect(
			"workItemId" in
				workstationAttachWorkOrder({
					approvalRequestId: "appr-1",
					content: "x",
					delegateToTediId: "tedi-cto",
					runId: "run-1",
				}),
		).toBe(false);
		expect(
			workstationAttachWorkOrder({
				approvalRequestId: "appr-1",
				content: "x",
				delegateToTediId: "tedi-cto",
				runId: "run-1",
				workItemId: "wi-7",
			}).workItemId,
		).toBe("wi-7");
	});

	it("truncates the requestPreview past the 180-char ceiling", () => {
		const long = "a".repeat(500);
		const wo = workstationAttachWorkOrder({
			approvalRequestId: "appr-1",
			content: long,
			delegateToTediId: "tedi-cto",
			runId: "run-1",
		});
		expect(wo.requestPreview).toHaveLength(180);
		expect(wo.requestPreview.endsWith("...")).toBe(true);
		// short content passes through unchanged.
		expect(
			workstationAttachWorkOrder({
				approvalRequestId: "appr-1",
				content: "short",
				delegateToTediId: "tedi-cto",
				runId: "run-1",
			}).requestPreview,
		).toBe("short");
	});
});

describe("homeWorkstationAttachPayload", () => {
	it("parses a well-formed workstation-attach approval payload", () => {
		expect(
			homeWorkstationAttachPayload({
				source: "home.workstation_attach",
				homeRunId: "run-9",
				homeConversationId: "home:main",
				delegateToTediId: "tedi-cto",
				workOrder: { id: "work-order:run-9" },
			}),
		).toEqual({
			homeRunId: "run-9",
			homeConversationId: "home:main",
			delegateToTediId: "tedi-cto",
			workOrder: { id: "work-order:run-9" },
		});
	});

	it("returns null for a non-object, wrong source, or missing required fields", () => {
		expect(homeWorkstationAttachPayload(null)).toBeNull();
		expect(homeWorkstationAttachPayload("nope")).toBeNull();
		expect(
			homeWorkstationAttachPayload({
				source: "home.delegation",
				homeRunId: "run-9",
				homeConversationId: "home:main",
				delegateToTediId: "tedi-cto",
			}),
		).toBeNull();
		expect(
			homeWorkstationAttachPayload({
				source: "home.workstation_attach",
				homeConversationId: "home:main",
				delegateToTediId: "tedi-cto",
			}),
		).toBeNull();
	});

	it("normalizes a missing/invalid workOrder to undefined", () => {
		expect(
			homeWorkstationAttachPayload({
				source: "home.workstation_attach",
				homeRunId: "run-9",
				homeConversationId: "home:main",
				delegateToTediId: "tedi-cto",
			})?.workOrder,
		).toBeUndefined();
	});
});

describe("ensureWorkstationAttachApprovalRequest", () => {
	const baseInput = {
		approvalRequestId: "run-9",
		content: "build the thing",
		conversationId: "home:main",
		createdAt: "2026-07-01T00:00:00.000Z",
		delegateToTediId: "tedi-cto",
		organizationId: "org-1",
		runId: "run-9",
		workOrder: { id: "work-order:run-9" },
	};

	it("returns the existing request without re-creating it (idempotent)", async () => {
		mocks.getApprovalRequestById.mockResolvedValue({ id: "run-9" });
		const result = await ensureWorkstationAttachApprovalRequest(
			context,
			baseInput,
		);
		expect(result).toEqual({ id: "run-9" });
		expect(mocks.createApprovalRequest).not.toHaveBeenCalled();
	});

	it("creates a workstation.attach request with the default 24h TTL and shaped payload", async () => {
		mocks.getApprovalRequestById.mockResolvedValue(null);
		mocks.createApprovalRequest.mockImplementation((_db, row) => row);
		const result = (await ensureWorkstationAttachApprovalRequest(
			context,
			baseInput,
		)) as Record<string, unknown>;
		expect(result.actionType).toBe("workstation.attach");
		expect(result.tediId).toBe("tedi-cto");
		expect(result.orgId).toBe("org-1");
		expect(result.expiresAt).toBe(
			offsetIso(baseInput.createdAt, 24 * 60 * 60 * 1000),
		);
		expect(result.payload).toMatchObject({
			source: "home.workstation_attach",
			homeRunId: "run-9",
			homeConversationId: "home:main",
			delegateToTediId: "tedi-cto",
			workOrder: { id: "work-order:run-9" },
		});
	});

	it("honors an explicit ttlHours override", async () => {
		mocks.getApprovalRequestById.mockResolvedValue(null);
		mocks.createApprovalRequest.mockImplementation((_db, row) => row);
		const result = (await ensureWorkstationAttachApprovalRequest(context, {
			...baseInput,
			ttlHours: 2,
		})) as Record<string, unknown>;
		expect(result.expiresAt).toBe(
			offsetIso(baseInput.createdAt, 2 * 60 * 60 * 1000),
		);
	});

	it("truncates the payload requestPreview past the 280-char ceiling", async () => {
		mocks.getApprovalRequestById.mockResolvedValue(null);
		mocks.createApprovalRequest.mockImplementation((_db, row) => row);
		const result = (await ensureWorkstationAttachApprovalRequest(context, {
			...baseInput,
			content: "z".repeat(500),
		})) as { payload: { requestPreview: string } };
		expect(result.payload.requestPreview).toHaveLength(280);
		expect(result.payload.requestPreview.endsWith("...")).toBe(true);
	});
});

describe("recordWorkstationAttachKernelTraceBundle", () => {
	const baseInput = {
		approvalRequestId: "appr-1",
		assistantContent: "   Delivered   the   result   ",
		assistantEvent: makeEvent("evt-assistant"),
		autoApprovedAttach: true,
		childRunId: "child-1",
		completedAt: "2026-07-01T00:00:02.000Z",
		conversationId: "home:main",
		delegatedTediId: "tedi-cto",
		dispatchPolicy: { mode: "auto" },
		organizationId: "org-1",
		runId: "run-9",
		startedAt: "2026-07-01T00:00:00.000Z",
		terminalEvent: makeEvent("evt-terminal"),
		workItemId: "wi-7",
		workstationDispatchNow: true,
	};

	beforeEach(() => {
		mocks.ensureActiveKernelHarnessVersion.mockResolvedValue({
			version: {
				id: "hv-1",
				subjectKind: "kernel",
				subjectId: "kernel:org-1",
			},
			bumped: false,
		});
	});

	it("records a success bundle with an excerpt summary and both event ids", async () => {
		let captured: Record<string, unknown> | undefined;
		mocks.recordHarnessSubjectTraceBundle.mockImplementation((_db, bundle) => {
			captured = bundle;
		});
		await recordWorkstationAttachKernelTraceBundle(context, baseInput);
		expect(mocks.recordHarnessSubjectTraceBundle).toHaveBeenCalledTimes(1);
		expect(captured?.id).toBe("run-9:bundle");
		expect(captured?.subjectKind).toBe("kernel");
		expect(captured?.subjectId).toBe("kernel:org-1");
		expect(captured?.harnessVersionId).toBe("hv-1");
		expect(captured?.outcome).toBe("success");
		// whitespace-collapsed excerpt.
		expect(captured?.summary).toBe("Delivered the result");
		expect(captured?.eventIds).toEqual(["evt-assistant", "evt-terminal"]);
		expect(captured?.metadata).toMatchObject({
			surface: "home.workstation_attach",
			childRunId: "child-1",
			delegatedTediId: "tedi-cto",
		});
	});

	it("marks the bundle escalated when the attach was not auto-approved", async () => {
		let captured: Record<string, unknown> | undefined;
		mocks.recordHarnessSubjectTraceBundle.mockImplementation((_db, bundle) => {
			captured = bundle;
		});
		await recordWorkstationAttachKernelTraceBundle(context, {
			...baseInput,
			autoApprovedAttach: false,
		});
		expect(captured?.outcome).toBe("escalated");
	});

	it("is fail-soft: swallows a harness-version read failure without recording", async () => {
		mocks.ensureActiveKernelHarnessVersion.mockRejectedValue(
			new Error("harness unavailable"),
		);
		await expect(
			recordWorkstationAttachKernelTraceBundle(context, baseInput),
		).resolves.toBeUndefined();
		expect(mocks.recordHarnessSubjectTraceBundle).not.toHaveBeenCalled();
	});
});
