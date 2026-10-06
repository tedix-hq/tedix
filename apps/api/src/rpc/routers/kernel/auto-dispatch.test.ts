/**
 * Unit tests for the autonomous-delegation dispatch module: the `auto`-verdict
 * gate (`shouldAutoDispatch`) and the pure dispatcher factory
 * (`buildAutoDelegationDispatcher`) — idempotency key, work-order threading,
 * and result shaping over an injected child-enqueue.
 */

import { describe, expect, it, vi } from "vite-plus/test";
import {
	buildAutoDelegationDispatcher,
	shouldAutoDispatch,
} from "./auto-dispatch";
import {
	buildDelegationWorkOrder,
	type DelegationWorkOrder,
} from "./delegation-dispatch";
import type { HomeDelegationEvidence } from "./index";

const WORK_ORDER: DelegationWorkOrder = {
	kind: "tedi.delegate",
	objective: "Review the roadmap.",
	outputContract: "Top 3 priorities.",
	status: "draft",
	authorityMode: "shadow",
	toolGuidance: ['Use your "mcp:apps" scope group.'],
	boundaries: ["Do not exceed your assigned scopes."],
	executionRequirement: {
		surface: "native",
		requiredCapabilities: ["repository_read"],
		fallbackSurface: "workstation",
		prohibitedSurfaces: [],
		satisfiable: true,
		reason: "bounded review",
	},
	sourceContent: "Have CPO review the roadmap.",
	targetTediId: "tedi-cpo",
	targetTediLabel: "CPO",
};

function evidence(
	mode: "auto" | "needs_approval" | "blocked",
	canAutoDispatch: boolean,
): HomeDelegationEvidence {
	return {
		workOrder: WORK_ORDER,
		decision: { mode, canAutoDispatch, reason: "test" },
	};
}

describe("shouldAutoDispatch", () => {
	it("true only when mode auto AND canAutoDispatch", () => {
		expect(shouldAutoDispatch(evidence("auto", true))).toBe(true);
	});
	it("false for needs_approval / blocked / null / mode-flag mismatch", () => {
		expect(shouldAutoDispatch(evidence("needs_approval", false))).toBe(false);
		expect(shouldAutoDispatch(evidence("blocked", false))).toBe(false);
		expect(shouldAutoDispatch(null)).toBe(false);
		// Defensive: mode auto but canAutoDispatch false (should never happen, but
		// the gate requires both) → no dispatch.
		expect(shouldAutoDispatch(evidence("auto", false))).toBe(false);
	});
});

describe("buildAutoDelegationDispatcher", () => {
	const input = {
		homeRunId: "run-1",
		homeConversationId: "home:main",
		userMessageId: "run-1:input",
		content: "Have CPO review the roadmap.",
		delegatedTediId: "tedi-cpo",
		organizationId: "org-1",
		workOrder: WORK_ORDER,
	};

	it("forwards the entire built source to the actual child enqueue", async () => {
		const content = `Original task
${"Detailed requirements. ".repeat(200)}
Acceptance: do not alter the grading oracle; preserve both merge parents.`;
		const workOrder = buildDelegationWorkOrder({
			card: null,
			userContent: content,
			executionRequirement: WORK_ORDER.executionRequirement,
			route: {
				routeKind: "delegate_tedi",
				rationale: "Requested review",
				risk: "low",
				confidence: 1,
				effortClass: "multi_hop_read",
				answer: null,
				targetTediId: input.delegatedTediId,
				targetTediLabel: "CPO",
				targetActivityId: null,
				plannedToolIds: [],
				toolIntent: null,
				workflowHint: null,
				clarifyingQuestion: null,
				evidenceExpectation: null,
			},
		});
		const enqueueChild = vi.fn(async () => ({
			runId: "child",
			status: "queued",
		}));
		await buildAutoDelegationDispatcher({
			enqueueChild,
			predictChildRunId: () => "child",
		})({ ...input, content, workOrder });
		expect(enqueueChild).toHaveBeenCalledWith(
			expect.objectContaining({
				content: expect.stringContaining(`Source request:
${content}
[END HOME DELEGATION WORK ORDER]`),
				metadata: expect.objectContaining({
					delegationWorkOrder: expect.objectContaining({
						sourceContent: content,
					}),
				}),
			}),
		);
	});

	it("enqueues the child idempotency-keyed by the client request id, threading the work order", async () => {
		const enqueueChild = vi.fn(async () => ({
			runId: "tedi-cpo:mcp:run-1_auto_tedi-cpo",
			conversationId: "agent:main:main",
			status: "queued",
		}));
		const predictChildRunId = vi.fn(() => "tedi-cpo:mcp:run-1_auto_tedi-cpo");
		const dispatch = buildAutoDelegationDispatcher({
			enqueueChild,
			predictChildRunId,
		});

		const result = await dispatch(input);

		// Idempotency follows the forced delegateToTediId path: pass the stable
		// client request id to cognitive-runtime and let the runtime return the
		// canonical child run id.
		const call = enqueueChild.mock.calls[0][0];
		expect(call.idempotencyKey).toBe("run-1:auto:tedi-cpo");
		expect(call.tediId).toBe("tedi-cpo");
		const attachments = [
			{
				type: "image" as const,
				fileName: "screen.png",
				mimeType: "image/png",
				content: "tedix-attachment:test",
			},
		];
		await dispatch({ ...input, attachments });
		expect(enqueueChild.mock.calls[1]?.[0].attachments).toEqual(attachments);
		// Org threaded through so the internal service-binding enqueue resolves
		// organization context (else "Organization context required").
		expect(call.organizationId).toBe("org-1");
		expect(call.metadata.delegationWorkOrder).toEqual(WORK_ORDER);
		expect(call.metadata.source).toBe("kernelRuntime.autoDispatch");
		expect(call.metadata.homeRunId).toBe("run-1");
		// Rich handoffs: the child's CONTENT is the rendered work order, not the
		// operator's bare ask. The full spec must survive the hop.
		expect(call.content).toContain("Objective:");
		expect(call.content).toContain("Output contract:");
		expect(call.content).toContain("Review the roadmap.");
		// The verbatim ask is still preserved (as the work order's sourceContent).
		expect(call.content).toContain("Have CPO review the roadmap.");
		// It is NOT the bare ask string.
		expect(call.content).not.toBe("Have CPO review the roadmap.");
		// predictChildRunId keyed by the deterministic clientRequestId.
		expect(predictChildRunId.mock.calls[0][0]).toEqual({
			clientRequestId: "run-1:auto:tedi-cpo",
			tediId: "tedi-cpo",
		});
		expect(result).toEqual({
			childRunId: "tedi-cpo:mcp:run-1_auto_tedi-cpo",
			childConversationId: "agent:main:main",
			status: "queued",
			error: undefined,
		});
	});

	it("falls back to the predicted id when the runtime returns none", async () => {
		const dispatch = buildAutoDelegationDispatcher({
			enqueueChild: async () => ({ status: "queued" }),
			predictChildRunId: () => "predicted-id",
		});
		const result = await dispatch(input);
		expect(result.childRunId).toBe("predicted-id");
		expect(result.status).toBe("queued");
	});

	it("threads a pre-created Work Item into child content and metadata", async () => {
		const enqueueChild = vi.fn(async () => ({ status: "queued" }));
		const dispatch = buildAutoDelegationDispatcher({
			enqueueChild,
			predictChildRunId: () => "predicted-id",
		});

		await dispatch({ ...input, workItemId: "work-item-1" });

		const call = enqueueChild.mock.calls[0][0];
		expect(call.content).toContain("Work Item: work-item-1");
		expect(call.metadata.workItemId).toBe("work-item-1");
		expect(call.metadata.delegationWorkOrder).toMatchObject({
			workItemId: "work-item-1",
		});
	});

	it("surfaces a failed enqueue as status failed + error", async () => {
		const dispatch = buildAutoDelegationDispatcher({
			enqueueChild: async () => ({ status: "failed", error: "tedi asleep" }),
			predictChildRunId: () => "predicted-id",
		});
		const result = await dispatch(input);
		expect(result.status).toBe("failed");
		expect(result.error).toBe("tedi asleep");
	});

	// --- budget threading ---------------------------------------------------

	it("threads workOrder.budget into child dispatch metadata as delegationBudget", async () => {
		const budgetedWorkOrder: DelegationWorkOrder = {
			...WORK_ORDER,
			budget: {
				maxToolCalls: 10,
				maxTokens: 4000,
				maxUsd: 0.5,
				deadlineMs: 30000,
			},
		};
		const enqueueChild = vi.fn(async () => ({ status: "queued" }));
		const dispatch = buildAutoDelegationDispatcher({
			enqueueChild,
			predictChildRunId: () => "predicted",
		});
		await dispatch({ ...input, workOrder: budgetedWorkOrder });

		const call = enqueueChild.mock.calls[0][0];
		expect(call.metadata.delegationBudget).toEqual({
			maxToolCalls: 10,
			maxTokens: 4000,
			maxUsd: 0.5,
			deadlineMs: 30000,
		});
		// deadlineMs also surfaced as top-level key for cheap child-runtime reads.
		expect(call.metadata.delegationDeadlineMs).toBe(30000);
	});

	it("threads the enforced earned-authority envelope as independent async metadata", async () => {
		const authorityEnvelope = {
			version: "earned-delegation.v1" as const,
			grantId: "grant-1",
			grantRevision: 4,
			decisionId: "decision-1",
			activityId: "invoice-read",
			activityVersion: 2,
			taskFamily: "globex.invoices.list",
			riskLevel: "low" as const,
			environment: "production",
			allowedToolIds: ["globex_tedix.list_invoices"],
			expiresAt: null,
		};
		const enqueueChild = vi.fn(async () => ({ status: "queued" }));
		const dispatch = buildAutoDelegationDispatcher({
			enqueueChild,
			predictChildRunId: () => "predicted",
		});
		await dispatch({
			...input,
			workOrder: {
				...WORK_ORDER,
				authorityMode: "enforce",
				authorityEnvelope,
			},
		});
		const call = enqueueChild.mock.calls[0][0];
		expect(call.metadata.delegationAuthorityMode).toBe("enforce");
		expect(call.metadata.delegationAuthority).toEqual(authorityEnvelope);
	});

	it("omits delegationBudget from metadata when the work order carries no budget", async () => {
		// WORK_ORDER has no budget field — nothing should appear in metadata.
		const enqueueChild = vi.fn(async () => ({ status: "queued" }));
		const dispatch = buildAutoDelegationDispatcher({
			enqueueChild,
			predictChildRunId: () => "predicted",
		});
		await dispatch(input);

		const call = enqueueChild.mock.calls[0][0];
		expect(call.metadata.delegationBudget).toBeUndefined();
		expect(call.metadata.delegationDeadlineMs).toBeUndefined();
	});

	it("threads budget without deadlineMs (partial budget) — no delegationDeadlineMs emitted", async () => {
		const partialBudget: DelegationWorkOrder = {
			...WORK_ORDER,
			budget: { maxToolCalls: 5 },
		};
		const enqueueChild = vi.fn(async () => ({ status: "queued" }));
		const dispatch = buildAutoDelegationDispatcher({
			enqueueChild,
			predictChildRunId: () => "predicted",
		});
		await dispatch({ ...input, workOrder: partialBudget });

		const call = enqueueChild.mock.calls[0][0];
		expect(call.metadata.delegationBudget).toEqual({ maxToolCalls: 5 });
		expect(call.metadata.delegationDeadlineMs).toBeUndefined();
	});

	// --- Rich handoffs: rendered content + trace excerpts ---

	it("renders trace excerpts carried on the work order into the child content", async () => {
		const workOrderWithExcerpts = {
			...WORK_ORDER,
			traceExcerpts: ["operator: have CPO review the roadmap"],
		} as DelegationWorkOrder;
		const enqueueChild = vi.fn(async () => ({ status: "queued" }));
		const dispatch = buildAutoDelegationDispatcher({
			enqueueChild,
			predictChildRunId: () => "predicted",
		});
		await dispatch({ ...input, workOrder: workOrderWithExcerpts });

		const call = enqueueChild.mock.calls[0][0];
		expect(call.content).toContain("Recent context:");
		expect(call.content).toContain("- operator: have CPO review the roadmap");
	});

	it("FAIL-SOFT: a work order missing objective/contract falls back to the raw ask content", async () => {
		// A malformed work order (no objective/outputContract) must degrade to
		// exactly today's behavior: the child sees the bare operator ask. The render
		// supplies generic objective/contract scaffolding but always embeds the
		// fallback content as the source request, so nothing is lost.
		const bareWorkOrder = {
			// Intentionally only the type-required minimum, no rich fields.
			kind: "tedi.delegate",
			status: "draft",
			targetTediId: "tedi-cpo",
			sourceContent: "",
			objective: "",
			outputContract: "",
			toolGuidance: [],
			boundaries: [],
			executionRequirement: WORK_ORDER.executionRequirement,
		} as unknown as DelegationWorkOrder;
		const enqueueChild = vi.fn(async () => ({ status: "queued" }));
		const dispatch = buildAutoDelegationDispatcher({
			enqueueChild,
			predictChildRunId: () => "predicted",
		});
		await dispatch({ ...input, workOrder: bareWorkOrder });

		const call = enqueueChild.mock.calls[0][0];
		// The raw ask survives as the rendered source request even with empty fields.
		expect(call.content).toContain("Have CPO review the roadmap.");
	});

	// --- Delegation-depth propagation ---------------------------------------
	// Regression: the dispatcher must thread this run's chain depth into the child's dispatch
	// metadata. The injected child runner (kernelDelegateRunner) reads
	// metadata.delegationDepth and stamps the child at parent+1, so without the
	// thread every self-propagating auto-delegated child was re-stamped 0+1=1 and
	// MAX_DELEGATION_DEPTH never bounded the runaway. These tests exercise the
	// metadata build path the +3 gate tests never touched.

	it("threads the parent run's delegationDepth verbatim into child dispatch metadata", async () => {
		const enqueueChild = vi.fn(async () => ({ status: "queued" }));
		const dispatch = buildAutoDelegationDispatcher({
			enqueueChild,
			predictChildRunId: () => "predicted",
		});
		await dispatch({ ...input, delegationDepth: 5 });

		const call = enqueueChild.mock.calls[0][0];
		// Parent depth threaded raw; the child runner (not the dispatcher) adds +1.
		expect(call.metadata.delegationDepth).toBe(5);
	});

	it("defaults delegationDepth to 0 for a top-level (undepth) dispatch", async () => {
		const enqueueChild = vi.fn(async () => ({ status: "queued" }));
		const dispatch = buildAutoDelegationDispatcher({
			enqueueChild,
			predictChildRunId: () => "predicted",
		});
		await dispatch(input); // no delegationDepth field

		const call = enqueueChild.mock.calls[0][0];
		// Absent ⇒ 0, so the child runner stamps the top-level child at 0+1=1.
		expect(call.metadata.delegationDepth).toBe(0);
	});

	it("END-TO-END: a self-propagating auto-delegation chain accumulates depth and hits the cap", async () => {
		// Simulate the real wiring: enqueueChild routes through the child runner,
		// which reads metadata.delegationDepth and stamps the child at parent+1
		// (defaultKernelDelegateRunner in kernel-runtime.ts). We then feed the
		// child's stamped depth back in as the next hop's parent depth — the
		// autonomous runaway path. Before the fix every hop's child was stamped 1,
		// so the chain never terminated; after the fix it strictly increments.
		const stampedChildDepths: number[] = [];
		const runnerIncrement: typeof input & { delegationDepth?: number } = {
			...input,
		};
		const enqueueChild = vi.fn(
			async (args: { metadata: { delegationDepth?: number } }) => {
				const parent = args.metadata.delegationDepth ?? 0;
				const childDepth = parent + 1; // mirrors kernelDelegateRunner's +1
				stampedChildDepths.push(childDepth);
				return { status: "queued" as const };
			},
		);
		const dispatch = buildAutoDelegationDispatcher({
			enqueueChild,
			predictChildRunId: () => "predicted",
		});

		let parentDepth = 0;
		for (let hop = 0; hop < 12; hop++) {
			await dispatch({ ...runnerIncrement, delegationDepth: parentDepth });
			// The child that was just spawned becomes the next hop's parent.
			parentDepth = stampedChildDepths[stampedChildDepths.length - 1];
		}

		// Strictly increasing 1,2,3,...,12 — NOT a flat run of 1s (the pre-fix bug).
		expect(stampedChildDepths).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
		// The chain crosses MAX_DELEGATION_DEPTH (10), so decideDelegationDispatch
		// would refuse the hop whose parent depth is >= 10 — the runaway is bounded.
		expect(stampedChildDepths.some((d) => d >= 10)).toBe(true);
	});
});
