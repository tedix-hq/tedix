/**
 * Pins the ADVISORY PROGRESS SEAM of `runKernelTurnWork` ONLY (stage sequence +
 * fail-soft guarantee). The turn body's full behavior (persist patterns, event
 * payloads, approval parking, fallbacks) stays pinned by kernel-runtime.test.ts
 * through the router — this harness deliberately stubs every dep to the
 * minimum that lets the body run, so it cannot drift into a second source of
 * truth for turn semantics.
 *
 * The db stub is a chainable thenable proxy: every property access / call
 * returns the proxy, `await` resolves to `[{}]` (one anonymous row). That
 * satisfies the body's own `db.update(...).set(...).where(...)` patch AND the
 * directly-imported approval queries: `getApprovalRequestById` → `[{}][0]` =
 * truthy → the body takes its idempotent "approval row already exists" path
 * (which still sets `writeApprovalRequestId`), so `createApprovalRequest`
 * (which throws when the insert returns no row) is never reached.
 */

import type { BodyExecutionResult } from "@tedix/api-contract/schemas/body-certification";
import type { HarnessSubjectTraceBundle } from "@tedix/api-contract/schemas/harness-version";
import type { KernelRuntimeEvent } from "@tedix/api-contract/schemas/kernel-runtime";
import type { DbClient } from "@tedix/db/client";
import { describe, expect, it, vi } from "vite-plus/test";
import {
	createKernelTurnStageTimings,
	KERNEL_TURN_SERIAL_STAGE_ORDER,
	type KernelTurnStageTimingsSnapshot,
} from "../../../kernel/turn-stage-timings";
import type { KernelRouteDecision } from "./route-schema";

// Stub the dynamically-imported `ai` module so the synthesis path can run the
// `if (model)` branch WITHOUT a network call. `generateText` is captured into a
// module-level spy that each test resets/configures. Hoisted by vitest above all
// imports; `mockGenerateText` is read lazily so per-test reassignment is honored.
const mockGenerateText = vi.fn();
// The kernel's inference goes through the traced AI SDK namespace
// (`src/lib/traced-ai.ts`), so that is the module to intercept — mocking "ai"
// would leave the wrapper calling the real SDK.
vi.mock("../../../lib/traced-ai", () => ({
	tracedAi: {
		generateText: (...args: unknown[]) => mockGenerateText(...args),
	},
}));
vi.mock(
	"../../../kernel/runtime-submission-bridge",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../../kernel/runtime-submission-bridge")
		>()),
		claimKernelExecutionPolicy: vi.fn(async () => ({})),
	}),
);

import {
	type HomeTurnRuntimeEventInput,
	type KernelTurnWorkDeps,
	type KernelTurnWorkInput,
	readDelegationDepth,
	runKernelTurnWork,
} from "./turn-work";

function chainDbProxy(rows: unknown[] = [{}]): DbClient {
	const proxy: unknown = new Proxy(function noop() {}, {
		get(_target, prop) {
			if (prop === "then") {
				return (resolve: (value: unknown[]) => void) => resolve(rows);
			}
			return proxy;
		},
		apply() {
			return proxy;
		},
	});
	return proxy as DbClient;
}

/**
 * Like {@link chainDbProxy} but records the `metadata` patch passed to each
 * `db.update(...).set({ metadata })`. Lets a test assert what landed on the
 * run row without a real DB.
 */
function capturingDbProxy(sink: Array<Record<string, unknown>>): DbClient {
	const proxy: unknown = new Proxy(function noop() {}, {
		get(_target, prop) {
			if (prop === "then") {
				return (resolve: (value: unknown[]) => void) => resolve([{}]);
			}
			if (prop === "set") {
				return (patch: Record<string, unknown>) => {
					// Only run-row metadata patches are of interest here. Sets without a
					// `metadata` key (e.g. the submission-ledger status patch added by
					// settleKernelSubmission) are not run-metadata writes — and neither
					// is the crash-safe settle's reserve-latch step, which patches the
					// submission row's metadata with `reservedOutcome`.
					const md = patch.metadata as Record<string, unknown> | undefined;
					if ("metadata" in patch && !(md && "reservedOutcome" in md)) {
						sink.push(patch.metadata as Record<string, unknown>);
					}
					return proxy;
				};
			}
			return proxy;
		},
		apply() {
			return proxy;
		},
	});
	return proxy as DbClient;
}

/** insertKernelRuntimeEvent stub that also records each event's runtimeMetadata. */
function capturingEventInsert(
	sink: Array<Record<string, unknown> | undefined>,
): KernelTurnWorkDeps["insertKernelRuntimeEvent"] {
	return async (input) => {
		sink.push(input.runtimeMetadata);
		return {
			id: `event:${input.kind}`,
			organizationId: input.organizationId,
			kind: input.kind,
			conversationId: input.conversationId,
			runId: input.runId,
			messageId: input.messageId,
			payload: input.payload,
			runtime: { backend: "custom" },
			createdAt: input.createdAt ?? "2026-06-11T00:00:01.000Z",
		} as KernelRuntimeEvent;
	};
}

function route(overrides: Partial<KernelRouteDecision>): KernelRouteDecision {
	return {
		routeKind: "answer_in_home",
		rationale: "test",
		risk: "low",
		confidence: 0.9,
		effortClass: null,
		answer: null,
		targetTediId: null,
		targetTediLabel: null,
		toolIntent: null,
		workflowHint: null,
		clarifyingQuestion: null,
		evidenceExpectation: null,
		...overrides,
	};
}

function turnInput(): KernelTurnWorkInput {
	return {
		organizationId: "org-1",
		conversationId: "home:main",
		runId: "run-1",
		userMessageId: "msg-user-1",
		assistantMessageId: "msg-assistant-1",
		content: "what changed today?",
		descopeUserId: "user-1",
		createdAt: "2026-06-11T00:00:00.000Z",
		assistantAt: "2026-06-11T00:00:01.000Z",
		completedAt: "2026-06-11T00:00:02.000Z",
		approvalRequestId: null,
		delegationWorkOrder: null,
		homePlan: null,
		runRowMetadata: {},
		runtimeMetadata: {},
	};
}

/** Minimal stub deps; `kernel`/`writeProposalPlanner`/`onProgress` per test. */
function stubDeps(overrides: Partial<KernelTurnWorkDeps>): KernelTurnWorkDeps {
	const insertKernelRuntimeEvent: KernelTurnWorkDeps["insertKernelRuntimeEvent"] =
		async (input) =>
			({
				id: `event:${input.kind}`,
				organizationId: input.organizationId,
				kind: input.kind,
				conversationId: input.conversationId,
				runId: input.runId,
				messageId: input.messageId,
				payload: input.payload,
				runtime: { backend: "custom" },
				createdAt: input.createdAt ?? "2026-06-11T00:00:01.000Z",
			}) as KernelRuntimeEvent;
	return {
		db: chainDbProxy(),
		env: {} as CloudflareEnv,
		kernel: async () => null,
		writeProposalPlanner: async () => null,
		insertKernelRuntimeEvent,
		resolveKernelWriteAnchorTediId: async () => "tedi-anchor-1",
		homeToolWriteApprovalRequestId: async (runId) => `approval:${runId}`,
		homeRunProgress: ({ status }) => ({
			current: 1,
			detail: "",
			label: status ?? "completed",
			total: 1,
		}),
		kernelWriteCardContent: ({ approvalRequestId }) =>
			`card:${approvalRequestId}`,
		createDelegationWorkItem: async () => "work-item-default",
		predictAutoDelegationChildRunId: () => "tedi-cto:mcp:run-1_auto_tedi-cto",
		errorMessage: (value) =>
			value instanceof Error ? value.message : String(value),
		offsetIso: (baseIso) => baseIso,
		// Real wall-clock settle ~12.5s after the turn's createdAt placeholder
		// (00:00:00) — body-execution telemetry stamps endedAt/durationMs from
		// this, NOT the +2ms persist-first completedAt placeholder.
		nowIso: () => "2026-06-11T00:00:12.500Z",
		...overrides,
	};
}

function progressRecorder() {
	const stages: string[] = [];
	const details: Array<string | undefined> = [];
	return {
		stages,
		details,
		onProgress: (progress: { stage: string; detail?: string }) => {
			stages.push(progress.stage);
			details.push(progress.detail);
		},
	};
}

describe("runKernelTurnWork progress seam", () => {
	it("passes the ingress-authorized document, not a caller metadata projection, to the planner", async () => {
		const kernel = vi.fn(async () => null);
		const input = turnInput();
		input.selectedWorkspaceDocument = "server-authorized revision";
		input.runtimeMetadata.selectedWorkspaceDocument =
			"caller-forged projection";
		await runKernelTurnWork(stubDeps({ kernel }), input);
		expect(kernel).toHaveBeenCalledWith(
			expect.objectContaining({
				selectedWorkspaceDocument: "server-authorized revision",
			}),
		);
		delete input.selectedWorkspaceDocument;
		await runKernelTurnWork(stubDeps({ kernel }), input);
		expect(kernel).toHaveBeenLastCalledWith(
			expect.objectContaining({ selectedWorkspaceDocument: undefined }),
		);
	});
	it("stamps the machine-readable phase on Planning route and Finalizing", async () => {
		const events: Array<{ stage: string; phase?: string }> = [];
		const deps = stubDeps({
			kernel: async () => ({
				route: route({ routeKind: "answer_in_home", answer: "All quiet." }),
				assistantContent: "All quiet.",
				evidence: null,
			}),
			onProgress: (progress) => events.push(progress),
		});
		const result = await runKernelTurnWork(deps, turnInput());
		expect(result.run.completedAt).toBe("2026-06-11T00:00:12.500Z");
		expect(result.run.updatedAt).toBe("2026-06-11T00:00:12.500Z");
		expect(events).toEqual([
			{ stage: "Planning route", phase: "planning" },
			{ stage: "Finalizing", phase: "finalizing" },
		]);
	});

	it("flushes the streamed delta batch after the planner pass and BEFORE the settle clock and message.completed", async () => {
		// One timeline for every seam the ordering depends on: streamed deltas
		// (planner → onProgress), the end-of-stream flush hook, the settle wall
		// clock read, and the terminal row insert. The flush must sit after the
		// last delta and before both the clock read and the insert — that is
		// what puts the trailing delta row ahead of `message.completed` in the
		// (createdAt, id) stream.
		const timeline: string[] = [];
		const base = stubDeps({});
		const deps = stubDeps({
			kernel: async (args) => {
				args.onProgress?.({ stage: "Writing", answerDelta: "All " });
				args.onProgress?.({ stage: "Writing", answerDelta: "quiet." });
				return {
					route: route({ routeKind: "answer_in_home", answer: "All quiet." }),
					assistantContent: "All quiet.",
					evidence: null,
				};
			},
			onProgress: (progress) => {
				if (progress.answerDelta)
					timeline.push(`delta:${progress.answerDelta}`);
			},
			flushStreamedProgress: () => timeline.push("flush"),
			nowIso: () => {
				timeline.push("nowIso");
				return base.nowIso();
			},
			insertKernelRuntimeEvent: async (input) => {
				timeline.push(`insert:${input.kind}`);
				return base.insertKernelRuntimeEvent(input);
			},
		});
		await runKernelTurnWork(deps, turnInput());
		const flushAt = timeline.indexOf("flush");
		const lastDeltaAt = timeline.lastIndexOf("delta:quiet.");
		const clockAt = timeline.indexOf("nowIso");
		const completedAt = timeline.indexOf("insert:message.completed");
		expect(timeline.filter((entry) => entry === "flush")).toHaveLength(1);
		expect(lastDeltaAt).toBeGreaterThanOrEqual(0);
		expect(flushAt).toBeGreaterThan(lastDeltaAt);
		expect(clockAt).toBeGreaterThan(flushAt);
		expect(completedAt).toBeGreaterThan(flushAt);
	});

	it("a throwing flush hook never affects the turn", async () => {
		const deps = stubDeps({
			kernel: async () => ({
				route: route({ routeKind: "answer_in_home", answer: "All quiet." }),
				assistantContent: "All quiet.",
				evidence: null,
			}),
			flushStreamedProgress: () => {
				throw new Error("sink broke");
			},
		});
		const result = await runKernelTurnWork(deps, turnInput());
		expect(result.assistantMessage.content).toBe("All quiet.");
	});

	it("answer_in_home turn emits Planning route → Finalizing", async () => {
		const recorder = progressRecorder();
		const deps = stubDeps({
			kernel: async () => ({
				route: route({ routeKind: "answer_in_home", answer: "All quiet." }),
				assistantContent: "All quiet.",
				evidence: null,
			}),
			onProgress: recorder.onProgress,
		});
		const result = await runKernelTurnWork(deps, turnInput());
		expect(recorder.stages).toEqual(["Planning route", "Finalizing"]);
		expect(result.status).toBe("needs_delegation");
		expect(result.assistantMessage.content).toBe("All quiet.");
	});

	it("threads immutable paid-inference correlation into the kernel", async () => {
		let received:
			| {
					runId?: string;
					workItemId?: string;
					inferenceSource?: string;
					conversationId?: string;
			  }
			| undefined;
		const deps = stubDeps({
			kernel: async (args) => {
				received = args;
				return {
					route: route({ routeKind: "answer_in_home", answer: "Done." }),
					assistantContent: "Done.",
					evidence: null,
				};
			},
		});

		await runKernelTurnWork(deps, {
			...turnInput(),
			runtimeMetadata: {
				source: "kernelRuntime.enqueueMessage",
				workItemId: "work-item-1",
			},
		});

		expect(received).toMatchObject({
			runId: "run-1",
			workItemId: "work-item-1",
			inferenceSource: "kernel:kernelRuntime.enqueueMessage",
			conversationId: "home:main",
		});
	});

	it("threads kernel progress between Planning and Finalizing", async () => {
		const recorder = progressRecorder();
		const deps = stubDeps({
			kernel: async (args) => {
				args.onProgress?.({ stage: "Routing request" });
				args.onProgress?.({ stage: "Selecting owner", detail: "tedi-cpo" });
				return {
					route: route({
						routeKind: "delegate_tedi",
						targetTediId: "tedi-cpo",
						targetActivityId: "activity-report",
					}),
					assistantContent: "The request is routed.",
				};
			},
			onProgress: recorder.onProgress,
		});
		const result = await runKernelTurnWork(deps, turnInput());
		expect(recorder.stages).toEqual([
			"Planning route",
			"Routing request",
			"Selecting owner",
			"Finalizing",
		]);
		expect(recorder.details).toEqual([
			undefined,
			undefined,
			"tedi-cpo",
			undefined,
		]);
		expect(result.status).toBe("needs_delegation");
	});

	it("parks a needs_approval delegation as an actionable approval run", async () => {
		const events: Array<{ kind: string; payload?: Record<string, unknown> }> =
			[];
		const recorder = progressRecorder();
		const deps = stubDeps({
			kernel: async () =>
				({
					route: route({
						routeKind: "delegate_tedi",
						targetTediId: "tedi-cpo",
						targetTediLabel: "CPO",
					}),
					assistantContent:
						"I prepared a delegation to CPO. It is not dispatched yet; approve this Home run to dispatch the work order.",
					delegation: {
						workOrder: {
							kind: "tedi.delegate",
							objective: "Review the roadmap.",
							outputContract: "Return a short summary.",
							status: "draft",
							toolGuidance: [],
							boundaries: [],
							sourceContent: "Have CPO review the roadmap.",
							targetTediId: "tedi-cpo",
							targetTediLabel: "CPO",
						},
						decision: {
							mode: "needs_approval",
							canAutoDispatch: false,
							reason: "target not active",
						},
					},
				}) as unknown as Awaited<ReturnType<KernelTurnWorkDeps["kernel"]>>,
			insertKernelRuntimeEvent: async (input) => {
				events.push({
					kind: input.kind,
					payload: input.payload as Record<string, unknown>,
				});
				return {
					id: `event:${input.kind}`,
					organizationId: input.organizationId,
					kind: input.kind,
					conversationId: input.conversationId,
					runId: input.runId,
					messageId: input.messageId,
					payload: input.payload,
					runtime: { backend: "custom" },
					createdAt: input.createdAt ?? "2026-06-11T00:00:01.000Z",
				} as KernelRuntimeEvent;
			},
			onProgress: recorder.onProgress,
		});

		const result = await runKernelTurnWork(deps, turnInput());

		expect(result.status).toBe("requires_approval");
		expect(result.run.status).toBe("requires_approval");
		expect(result.run.completedAt).toBeNull();
		expect(recorder.stages).toContain("Awaiting approval");
		expect(events.map((event) => event.kind)).toContain("approval.requested");
		expect(events.map((event) => event.kind)).not.toContain("run.completed");
		expect(
			events.find((event) => event.kind === "approval.requested")?.payload,
		).toMatchObject({ status: "requires_approval" });
	});

	it("forwards answer token deltas from the kernel through the onProgress seam (streaming-answer variant)", async () => {
		const deltas: Array<string | undefined> = [];
		const deps = stubDeps({
			// The kernel stub plays streamHomeAnswer's role: runKernel forwards
			// onProgress and streamHomeAnswer emits one push per token delta. This
			// pins that turn-work's emitProgress wrapper carries `answerDelta`
			// through to the sink (not just stage/detail/tool).
			kernel: async (args) => {
				args.onProgress?.({ stage: "Answering", answerDelta: "All " });
				args.onProgress?.({ stage: "Answering", answerDelta: "quiet." });
				return {
					route: route({ routeKind: "answer_in_home", answer: "All quiet." }),
					assistantContent: "All quiet.",
					evidence: null,
				};
			},
			onProgress: (progress: { answerDelta?: string }) => {
				deltas.push(progress.answerDelta);
			},
		});
		await runKernelTurnWork(deps, turnInput());
		// "Planning route" / "Finalizing" milestones carry no delta; the two
		// streaming pushes carry the token deltas in order.
		expect(deltas.filter((d) => d !== undefined)).toEqual(["All ", "quiet."]);
	});

	it("observe-only suppresses streamed success prose and every write-proposal effect", async () => {
		const deltas: string[] = [];
		const writeProposalPlanner = vi.fn(async () => ({
			appSlug: "gmail",
			toolName: "send_email",
			args: { to: "customer@example.com" },
			reasoning: "requested",
			riskTier: "high" as const,
		}));
		const deps = stubDeps({
			kernel: async (args) => {
				args.onProgress?.({ stage: "Answering", answerDelta: "Email sent." });
				return {
					route: route({
						routeKind: "propose_tool_write",
						toolIntent: {
							appSlug: "gmail",
							capability: "gmail.send",
							connectionStatus: "connected",
						},
					}),
					assistantContent: "Email sent.",
					evidence: null,
				};
			},
			writeProposalPlanner,
			onProgress: (progress) => {
				if (progress.answerDelta) deltas.push(progress.answerDelta);
			},
		});
		const result = await runKernelTurnWork(deps, {
			...turnInput(),
			executionPolicy: "observe_only",
		});

		expect(deltas).toEqual([]);
		expect(writeProposalPlanner).not.toHaveBeenCalled();
		expect(result.run.status).toBe("completed");
		expect(result.run.metadata).toMatchObject({
			kernelRoute: null,
			kernelObservation: {
				selectedRoute: { routeKind: "propose_tool_write" },
				outcome: "effects_suppressed",
			},
		});
		expect(result.assistantMessage.content).not.toContain("Email sent");
	});

	it("propose_tool_write turn emits Planning route → Drafting write proposal → Awaiting approval → Finalizing", async () => {
		const recorder = progressRecorder();
		const deps = stubDeps({
			kernel: async () => ({
				route: route({
					routeKind: "propose_tool_write",
					risk: "medium",
					toolIntent: {
						appSlug: "globex",
						capability: "globex.invoices.create",
						connectionStatus: "connected",
					},
				}),
				assistantContent: "This would be a write.",
				evidence: null,
			}),
			writeProposalPlanner: async () => ({
				appSlug: "globex-tedix",
				toolName: "create_invoice",
				args: { amount: 100 },
				reasoning: "operator asked",
				riskTier: "low",
			}),
			onProgress: recorder.onProgress,
		});
		const result = await runKernelTurnWork(deps, turnInput());
		expect(recorder.stages).toEqual([
			"Planning route",
			"Drafting write proposal",
			"Awaiting approval",
			"Finalizing",
		]);
		expect(result.status).toBe("requires_approval");
		expect(result.assistantMessage.content).toBe("card:approval:run-1");
	});

	it("a declined write proposal skips Awaiting approval (no approval row → no parked run)", async () => {
		const recorder = progressRecorder();
		const deps = stubDeps({
			kernel: async () => ({
				route: route({
					routeKind: "propose_tool_write",
					toolIntent: {
						appSlug: "globex",
						capability: "globex.invoices.create",
						connectionStatus: "connected",
					},
				}),
				assistantContent: "This would be a write.",
				evidence: null,
			}),
			writeProposalPlanner: async (args) => {
				args.onDecline?.({ stage: "planner_declined" });
				return null;
			},
			onProgress: recorder.onProgress,
		});
		const result = await runKernelTurnWork(deps, turnInput());
		expect(recorder.stages).toEqual([
			"Planning route",
			"Drafting write proposal",
			"Finalizing",
		]);
		expect(result.status).toBe("needs_delegation");
	});

	it("a throwing onProgress sink never affects the turn (fail-soft emission)", async () => {
		let attempts = 0;
		const deps = stubDeps({
			kernel: async (args) => {
				args.onProgress?.({ stage: "Reading tavily" });
				return {
					route: route({ routeKind: "answer_in_home", answer: "ok" }),
					assistantContent: "ok",
					evidence: null,
				};
			},
			onProgress: () => {
				attempts += 1;
				throw new Error("sink exploded");
			},
		});
		const result = await runKernelTurnWork(deps, turnInput());
		expect(attempts).toBeGreaterThanOrEqual(2); // it kept emitting, swallowed each throw
		expect(result.status).toBe("needs_delegation");
		expect(result.assistantMessage.content).toBe("ok");
	});

	it("stamps the route's routerVersion onto the run metadata top-level AND the completion event runtimeMetadata", async () => {
		// The planner stamps routerVersion post-parse (StampedKernelRouteDecision);
		// the static KernelRouteDecision type does not surface it, so the kernel
		// stub spreads it on as the runtime shape does.
		const capturedRunMetadata: Array<Record<string, unknown>> = [];
		const capturedEventRuntimeMetadata: Array<
			Record<string, unknown> | undefined
		> = [];
		const capturedTraceBundles: HarnessSubjectTraceBundle[] = [];
		const capturedRawTraceInputs: Array<{ runId: string }> = [];
		const ensured: Array<{
			organizationId: string;
			routerVersion: string;
			createdAt: string;
		}> = [];
		const deps = stubDeps({
			kernel: async () => ({
				route: {
					...route({ routeKind: "answer_in_home", answer: "stamped." }),
					routerVersion: "abc123def456",
				} as KernelRouteDecision,
				assistantContent: "stamped.",
				evidence: null,
				traceInput: {
					provider: "azure.chat",
					model: "gpt-5.6-luna",
					systemPrompt: "kernel system prompt",
					userPrompt: "assembled user prompt",
					requestShape: "prompt",
					truncated: false,
					mediaOmitted: false,
					messages: [{ role: "user", content: "assembled user prompt" }],
				},
			}),
			db: capturingDbProxy(capturedRunMetadata),
			insertKernelRuntimeEvent: capturingEventInsert(
				capturedEventRuntimeMetadata,
			),
			recordKernelTraceBundle: async (bundle) => {
				capturedTraceBundles.push(bundle);
			},
			writeKernelTraceBundle: async (evidence) => {
				capturedRawTraceInputs.push({ runId: evidence.runId });
				return "r2://tedix-tedi-production/kernel/org-1/harness/runs/run-1/";
			},
			ensureKernelHarnessVersion: async (input) => {
				ensured.push(input);
				return {
					bumped: true,
					version: {
						id: "khv_1",
						subjectKind: "kernel",
						subjectId: "kernel:org-1",
						tediId: null,
						orgId: "org-1",
						version: "1",
						runtimeKind: "kernel",
						components: { attention_router: input.routerVersion },
						parentVersionId: null,
						reason: "kernel router version observed",
						promotionStatus: "active",
						createdAt: input.createdAt,
					},
				};
			},
		});
		await runKernelTurnWork(deps, turnInput());
		expect(ensured).toEqual([
			{
				organizationId: "org-1",
				routerVersion: "abc123def456",
				createdAt: "2026-06-11T00:00:00.000Z",
			},
		]);
		// Run-row patch metadata carries the top-level key (alongside kernelRoute).
		expect(capturedRunMetadata).toHaveLength(1);
		expect(capturedRunMetadata[0]?.routerVersion).toBe("abc123def456");
		expect(capturedRunMetadata[0]?.harnessVersionId).toBe("khv_1");
		expect(capturedRunMetadata[0]?.harnessSubjectKind).toBe("kernel");
		expect(capturedRunMetadata[0]?.harnessSubjectId).toBe("kernel:org-1");
		expect(
			(capturedRunMetadata[0]?.kernelRoute as { routerVersion?: string })
				?.routerVersion,
		).toBe("abc123def456");
		const bodyExecutionResult = capturedRunMetadata[0]
			?.bodyExecutionResult as BodyExecutionResult;
		expect(bodyExecutionResult).toMatchObject({
			id: "run-1:body-execution-result",
			bodyKind: "kernel",
			status: "completed",
			runId: "run-1",
			tediId: null,
			orgId: "org-1",
			conversationId: "home:main",
			sessionKey: "home:main",
			harnessVersionId: "khv_1",
			traceBundleId: "run-1:bundle",
			// True end-to-end latency from createdAt (00:00:00) to the injected
			// wall-clock settle (00:00:12.500) — NOT the 2ms gap between the
			// persist-first createdAt/completedAt placeholders.
			startedAt: "2026-06-11T00:00:00.000Z",
			endedAt: "2026-06-11T00:00:12.500Z",
			durationMs: 12_500,
			summary: "stamped.",
			structuredResult: {
				homeStatus: "completed",
				routeKind: "answer_in_home",
				routerVersion: "abc123def456",
				harnessSubjectKind: "kernel",
				harnessSubjectId: "kernel:org-1",
				writeProposalActive: false,
				autoDispatchStatus: null,
			},
			session: {
				afterRef: "kernel_runtime_runs:run-1",
				adapterSessionRef: null,
				clearSession: false,
			},
			runtimeServices: ["kernel-runtime", "home", "mcp"],
		});
		// Both transcript events (message.completed + run.completed) carry it.
		expect(capturedEventRuntimeMetadata).toHaveLength(2);
		for (const meta of capturedEventRuntimeMetadata) {
			expect(meta?.routerVersion).toBe("abc123def456");
			expect(meta?.harnessVersionId).toBe("khv_1");
			expect(meta?.harnessSubjectKind).toBe("kernel");
			expect(meta?.harnessSubjectId).toBe("kernel:org-1");
		}
		expect(capturedTraceBundles).toEqual([
			expect.objectContaining({
				id: "run-1:bundle",
				subjectKind: "kernel",
				subjectId: "kernel:org-1",
				tediId: null,
				orgId: "org-1",
				conversationId: "home:main",
				runId: "run-1",
				harnessVersionId: "khv_1",
				eventIds: ["event:message.completed", "event:run.completed"],
				rationaleRecordIds: [],
				artifactIds: [],
				bundleUri:
					"r2://tedix-tedi-production/kernel/org-1/harness/runs/run-1/",
				summary: "stamped.",
				outcome: "success",
				metadata: expect.objectContaining({
					routerVersion: "abc123def456",
					bodyExecutionResult: expect.objectContaining({
						id: "run-1:body-execution-result",
						traceBundleId: "run-1:bundle",
					}),
				}),
				createdAt: "2026-06-11T00:00:02.000Z",
			}),
		]);
		expect(capturedRawTraceInputs).toEqual([{ runId: "run-1" }]);
	});

	it("a route-less turn (kernel null) settles failed (model unavailable) with no routerVersion — no heuristic answer", async () => {
		const capturedRunMetadata: Array<Record<string, unknown>> = [];
		const capturedEventRuntimeMetadata: Array<
			Record<string, unknown> | undefined
		> = [];
		const deps = stubDeps({
			kernel: async () => null,
			db: capturingDbProxy(capturedRunMetadata),
			insertKernelRuntimeEvent: capturingEventInsert(
				capturedEventRuntimeMetadata,
			),
		});
		const result = await runKernelTurnWork(deps, turnInput());
		// LLM-only kernel: no model decision → hard failure, not a fabricated answer.
		expect(result.status).toBe("failed");
		expect(result.run.status).toBe("failed");
		expect(result.assistantMessage.content).toContain(
			"configured model did not produce a valid route decision",
		);
		expect(capturedRunMetadata[0]).not.toHaveProperty("routerVersion");
		for (const meta of capturedEventRuntimeMetadata) {
			expect(meta).not.toHaveProperty("routerVersion");
		}
	});

	it("a billing-policy denial settles failed with the honest billing notice — never the provider-outage message", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const capturedEvents: Array<{
			kind: string;
			payload: Record<string, unknown> | undefined;
		}> = [];
		const deps = stubDeps({
			kernel: async () => {
				// The canonical deterministic-denial marker reserveKernelBilling
				// throws (rethrown by the route planner instead of folded into null).
				throw new Error(
					"Inference blocked by billing policy: entitlement_inactive",
				);
			},
			insertKernelRuntimeEvent: capturingPayloadInsert(capturedEvents),
		});
		try {
			const result = await runKernelTurnWork(deps, turnInput());
			// The turn still settles failed — but as a policy denial, not an outage.
			expect(result.status).toBe("failed");
			expect(result.run.status).toBe("failed");
			expect(result.assistantMessage.content).toContain(
				"billing/entitlement state (entitlement_inactive)",
			);
			expect(result.assistantMessage.content).toContain(
				"Runtime entitlement card",
			);
			// It must never impersonate a provider outage.
			expect(result.assistantMessage.content).not.toContain(
				"configured model did not produce a valid route decision",
			);
			expect(result.assistantMessage.content).not.toContain(
				"providers both failed",
			);
			const terminal = capturedEvents.find((e) => e.kind === "run.failed");
			expect(terminal?.payload?.error).toBe(
				"Billing policy denied inference (entitlement_inactive)",
			);
			expect(warnSpy).toHaveBeenCalledWith({
				component: "kernel.turn_work",
				event: "billing_policy_denied",
				code: "entitlement_inactive",
			});
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("a NON-billing kernel throw still settles with the provider-outage message (fail-soft unchanged)", async () => {
		const privateText = "private-provider-request-7919";
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const deps = stubDeps({
			kernel: async () => {
				throw new Error(`Azure 500 for ${privateText}`);
			},
		});
		try {
			const result = await runKernelTurnWork(deps, {
				...turnInput(),
				conversationId: privateText,
				content: privateText,
			});
			expect(result.status).toBe("failed");
			expect(result.assistantMessage.content).toContain(
				"configured model did not produce a valid route decision",
			);
			expect(result.assistantMessage.content).not.toContain("billing");
			expect(warnSpy).toHaveBeenCalledWith({
				component: "kernel.turn_work",
				event: "kernel_planner_failed",
				error: { type: "Error" },
			});
			expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(privateText);
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("runs identically with no onProgress wired (the seam is optional)", async () => {
		const deps = stubDeps({
			kernel: async () => ({
				route: route({ routeKind: "answer_in_home", answer: "fine" }),
				assistantContent: "fine",
				evidence: null,
			}),
		});
		const result = await runKernelTurnWork(deps, turnInput());
		expect(result.status).toBe("needs_delegation");
	});
});

/** insertKernelRuntimeEvent stub that records each event's full payload. */
function capturingPayloadInsert(
	sink: Array<{ kind: string; payload: Record<string, unknown> | undefined }>,
): KernelTurnWorkDeps["insertKernelRuntimeEvent"] {
	return async (input) => {
		sink.push({ kind: input.kind, payload: input.payload });
		return {
			id: `event:${input.kind}`,
			organizationId: input.organizationId,
			kind: input.kind,
			conversationId: input.conversationId,
			runId: input.runId,
			messageId: input.messageId,
			payload: input.payload,
			runtime: { backend: "custom" },
			createdAt: input.createdAt ?? "2026-06-11T00:00:01.000Z",
		} as KernelRuntimeEvent;
	};
}

describe("runKernelTurnWork usage invariant", () => {
	it("appends completion frames after streamed deltas instead of backdating them behind the live cursor", async () => {
		const capturedEvents: Array<{ kind: string; createdAt?: string }> = [];
		const deps = stubDeps({
			kernel: async () => ({
				route: route({ routeKind: "answer_in_home", answer: "Done." }),
				assistantContent: "Done.",
				evidence: null,
			}),
			offsetIso: (baseIso, offsetMs) =>
				new Date(Date.parse(baseIso) + offsetMs).toISOString(),
			insertKernelRuntimeEvent: async (input) => {
				capturedEvents.push({ kind: input.kind, createdAt: input.createdAt });
				return {
					id: `event:${input.kind}`,
					organizationId: input.organizationId,
					kind: input.kind,
					conversationId: input.conversationId,
					runId: input.runId,
					messageId: input.messageId,
					payload: input.payload,
					runtime: { backend: "custom" },
					createdAt: input.createdAt ?? "",
				} as KernelRuntimeEvent;
			},
		});

		await runKernelTurnWork(deps, turnInput());

		const message = capturedEvents.find(
			(event) => event.kind === "message.completed",
		);
		const terminal = capturedEvents.find(
			(event) => event.kind === "run.completed",
		);
		expect(message?.createdAt).toBe("2026-06-11T00:00:12.500Z");
		expect(terminal?.createdAt).toBe("2026-06-11T00:00:12.501Z");
		expect(Date.parse(message!.createdAt!)).toBeGreaterThan(
			Date.parse(turnInput().completedAt),
		);
	});

	it("populates tokensUsed on message.completed and run.completed when route planner returns usage", async () => {
		const capturedEvents: Array<{
			kind: string;
			payload: Record<string, unknown> | undefined;
		}> = [];
		const deps = stubDeps({
			kernel: async () => ({
				// Simulate a kernel result that carries routeUsage — the planner's
				// single generateObject pass returned 1200 input + 300 output tokens.
				route: route({ routeKind: "answer_in_home", answer: "Token test." }),
				assistantContent: "Token test.",
				evidence: null,
				routeUsage: {
					provider: "azure",
					model: "gpt-4o",
					inputTokens: 1200,
					outputTokens: 300,
					cacheReadTokens: null,
					cacheWriteTokens: null,
				},
			}),
			insertKernelRuntimeEvent: capturingPayloadInsert(capturedEvents),
		});
		await runKernelTurnWork(deps, turnInput());

		const completedEvent = capturedEvents.find(
			(e) => e.kind === "message.completed",
		);
		const terminalEvent = capturedEvents.find(
			(e) => e.kind === "run.completed",
		);

		// Usage invariant: both events carry tokensUsed = 1200 + 300 = 1500.
		expect(completedEvent).toBeDefined();
		expect(completedEvent?.payload?.tokensUsed).toBe(1500);
		expect(terminalEvent).toBeDefined();
		expect(terminalEvent?.payload?.tokensUsed).toBe(1500);
	});

	it("omits tokensUsed when the kernel planner falls back (null result)", async () => {
		const capturedEvents: Array<{
			kind: string;
			payload: Record<string, unknown> | undefined;
		}> = [];
		const deps = stubDeps({
			kernel: async () => null,
			insertKernelRuntimeEvent: capturingPayloadInsert(capturedEvents),
		});
		await runKernelTurnWork(deps, turnInput());

		// No LLM call => no token counts => tokensUsed must be absent (not 0).
		for (const event of capturedEvents) {
			expect(event.payload).not.toHaveProperty("tokensUsed");
		}
	});

	it("omits tokensUsed when routeUsage tokens are both null (provider did not return counts)", async () => {
		const capturedEvents: Array<{
			kind: string;
			payload: Record<string, unknown> | undefined;
		}> = [];
		const deps = stubDeps({
			kernel: async () => ({
				route: route({ routeKind: "answer_in_home", answer: "no counts." }),
				assistantContent: "no counts.",
				evidence: null,
				routeUsage: {
					provider: "azure",
					model: "gpt-4o",
					inputTokens: null,
					outputTokens: null,
					cacheReadTokens: null,
					cacheWriteTokens: null,
				},
			}),
			insertKernelRuntimeEvent: capturingPayloadInsert(capturedEvents),
		});
		await runKernelTurnWork(deps, turnInput());

		// All-null usage => no tokensUsed field (don't fabricate a zero).
		for (const event of capturedEvents) {
			expect(event.payload).not.toHaveProperty("tokensUsed");
		}
	});
});

describe("runKernelTurnWork route-decision trace (run.completed payload)", () => {
	it("answer_in_home: run.completed carries the compact route object (homePlan stays null)", async () => {
		const capturedEvents: Array<{
			kind: string;
			payload: Record<string, unknown> | undefined;
		}> = [];
		const deps = stubDeps({
			kernel: async () => ({
				route: route({
					routeKind: "answer_in_home",
					answer: "All quiet.",
					confidence: 0.87,
					effortClass: "single_read",
					rationale: "Direct question answerable from assembled context.",
				}),
				assistantContent: "All quiet.",
				evidence: null,
			}),
			insertKernelRuntimeEvent: capturingPayloadInsert(capturedEvents),
		});
		await runKernelTurnWork(deps, turnInput());

		const terminalEvent = capturedEvents.find(
			(e) => e.kind === "run.completed",
		);
		expect(terminalEvent).toBeDefined();
		// Compact decision snapshot: no answer text, no tool args. Optional keys
		// (targetTediId/workflowHint) are omitted on an answer_in_home route.
		expect(terminalEvent?.payload?.route).toEqual({
			routeKind: "answer_in_home",
			confidence: 0.87,
			effortClass: "single_read",
			rationale: "Direct question answerable from assembled context.",
		});
		// homePlan is the always-null legacy field on the kernel path — the
		// decision half of the trace now rides `route` instead.
		expect(terminalEvent?.payload?.homePlan).toBeNull();
	});

	it("delegate_tedi: run.completed carries targetTediId and truncates the rationale to ~300 chars", async () => {
		const capturedEvents: Array<{
			kind: string;
			payload: Record<string, unknown> | undefined;
		}> = [];
		const longRationale = "r".repeat(400);
		const deps = stubDeps({
			kernel: async () => ({
				route: route({
					routeKind: "delegate_tedi",
					targetTediId: "tedi-cto",
					targetTediLabel: "CTO",
					confidence: 0.72,
					effortClass: "fan_out",
					rationale: longRationale,
				}),
				assistantContent: "Handing this to the CTO tedi.",
				evidence: null,
			}),
			insertKernelRuntimeEvent: capturingPayloadInsert(capturedEvents),
		});
		await runKernelTurnWork(deps, turnInput());

		const terminalEvent = capturedEvents.find(
			(e) => e.kind === "run.completed",
		);
		expect(terminalEvent).toBeDefined();
		const routePayload = terminalEvent?.payload?.route as Record<
			string,
			unknown
		>;
		expect(routePayload).toMatchObject({
			routeKind: "delegate_tedi",
			targetTediId: "tedi-cto",
			confidence: 0.72,
			effortClass: "fan_out",
		});
		// Rationale is capped for the compact ledger payload: 297 chars + "...".
		expect(routePayload.rationale).toBe(`${"r".repeat(297)}...`);
		// Inapplicable optional keys are omitted, not null.
		expect(routePayload).not.toHaveProperty("workflowHint");
	});

	it("route is null on a planner-less turn (model unavailable → run.failed)", async () => {
		const capturedEvents: Array<{
			kind: string;
			payload: Record<string, unknown> | undefined;
		}> = [];
		const deps = stubDeps({
			kernel: async () => null,
			insertKernelRuntimeEvent: capturingPayloadInsert(capturedEvents),
		});
		await runKernelTurnWork(deps, turnInput());

		// No route decision existed — the terminal event records that honestly.
		const terminalEvent = capturedEvents.find((e) => e.kind === "run.failed");
		expect(terminalEvent).toBeDefined();
		expect(terminalEvent?.payload?.route).toBeNull();
	});
});

describe("runKernelTurnWork trusted-write tier (auto-resolve wiring)", () => {
	type AutoResolveCall = Parameters<
		NonNullable<KernelTurnWorkDeps["autoResolveKernelWrite"]>
	>[0];

	/**
	 * Drives a `propose_tool_write` turn with a recording `autoResolveKernelWrite`
	 * sink, so each test asserts ONLY the gating decision turn-work makes (whether
	 * it routed the write to the auto-resolve sink) — the resolve+audit+execute
	 * behavior is pinned separately in kernel-runtime.test.ts.
	 */
	async function driveWrite(opts: {
		riskTier: "low" | "high";
		governancePolicy?: KernelTurnWorkInput["governancePolicy"];
		sessionWriteAllowlist?: string[];
	}) {
		const calls: AutoResolveCall[] = [];
		const deps = stubDeps({
			kernel: async () => ({
				route: route({
					routeKind: "propose_tool_write",
					toolIntent: {
						appSlug: "globex",
						capability: "globex.invoices.create",
						connectionStatus: "connected",
					},
				}),
				assistantContent: "This would be a write.",
				evidence: null,
			}),
			writeProposalPlanner: async () => ({
				appSlug: "globex-tedix",
				toolName: "create_invoice",
				args: { amount: 100 },
				reasoning: "operator asked",
				riskTier: opts.riskTier,
			}),
			autoResolveKernelWrite: async (input) => {
				calls.push(input);
				return { executed: true, finalStatus: "completed" };
			},
		});
		const result = await runKernelTurnWork(deps, {
			...turnInput(),
			governancePolicy: opts.governancePolicy ?? null,
			sessionWriteAllowlist: opts.sessionWriteAllowlist ?? null,
		});
		return { calls, result };
	}

	const TRUSTED = {
		writeTier: { trustedTools: ["globex-tedix:create_invoice"] },
	} as const;

	it("(a) routes a low-risk policy-trusted write to the auto-resolve sink (source=policy)", async () => {
		const { calls, result } = await driveWrite({
			riskTier: "low",
			governancePolicy: TRUSTED,
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			approvalRequestId: "approval:run-1",
			runId: "run-1",
			decision: { autoResolve: true, source: "policy" },
		});
		expect(result.run.metadata).toMatchObject({
			kernelWriteApproval: {
				autoResolve: true,
				source: "policy",
				willAutoResolve: true,
			},
		});
		expect(result.assistantMessage.content).toBe(
			"Authorized by tenant policy: executing `create_invoice` on globex-tedix.",
		);
		expect(result.assistantMessage.content).not.toContain("approval");
	});

	it("(b) keeps a HIGH-risk write human-gated even on a trusted tool (sink NOT called)", async () => {
		const { calls, result } = await driveWrite({
			riskTier: "high",
			governancePolicy: TRUSTED,
		});
		expect(calls).toHaveLength(0);
		expect(result.status).toBe("requires_approval");
		expect(result.run.metadata).toMatchObject({
			kernelWriteApproval: { autoResolve: false },
		});
	});

	it("(b) keeps a non-trusted write human-gated (sink NOT called)", async () => {
		const { calls } = await driveWrite({
			riskTier: "low",
			governancePolicy: { writeTier: { trustedTools: ["other:thing"] } },
		});
		expect(calls).toHaveLength(0);
	});

	it("(c) routes a session pre-authorized write to the sink (source=session)", async () => {
		const { calls, result } = await driveWrite({
			riskTier: "low",
			sessionWriteAllowlist: ["globex-tedix:create_invoice"],
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]?.decision).toMatchObject({ source: "session" });
		expect(result.assistantMessage.content).toBe(
			"Authorized for this conversation: executing `create_invoice` on globex-tedix.",
		);
	});

	it("(c) does NOT route a non-allowlisted write via session (sink NOT called)", async () => {
		const { calls } = await driveWrite({
			riskTier: "low",
			sessionWriteAllowlist: ["globex-tedix:other_tool"],
		});
		expect(calls).toHaveLength(0);
	});

	it("(d) fail-closed: no policy + no session => human gate (sink NOT called)", async () => {
		const { calls, result } = await driveWrite({ riskTier: "low" });
		expect(calls).toHaveLength(0);
		expect(result.status).toBe("requires_approval");
	});
});

// ─── Workflow confirm → dispatch intercept ───────────────────────────────────

/**
 * Like {@link chainDbProxy} but the SELECT terminal await resolves to `rows`
 * (the prior-run read), while every other await also resolves to `rows`. The
 * intercept only reads from the select and ignores update return values, so a
 * single fixed resolution is enough to drive both the pending read and the
 * run-row patch.
 */
function dbWithPriorRuns(rows: unknown[]): DbClient {
	const proxy: unknown = new Proxy(function noop() {}, {
		get(_t, prop) {
			if (prop === "then") {
				return (resolve: (v: unknown[]) => void) => resolve(rows);
			}
			return proxy;
		},
		apply() {
			return proxy;
		},
	});
	return proxy as DbClient;
}

const PENDING_PRIOR_RUNS = [
	{ id: "run-1", status: "running", metadata: {} }, // current run (excluded)
	{
		id: "run-prev",
		status: "completed",
		metadata: {
			kernelRoute: {
				routeKind: "run_workflow",
				workflowHint: "customer-onboarding",
			},
		},
	},
];

function affirmativeInput(): KernelTurnWorkInput {
	return { ...turnInput(), content: "yes go ahead" };
}

describe("runKernelTurnWork workflow confirm → dispatch intercept", () => {
	it("observe-only never confirms a prior workflow and records no actionable route", async () => {
		const dispatchWorkflowConfirm = vi.fn();
		const kernel = vi.fn(async () => ({
			route: route({
				routeKind: "run_workflow",
				workflowHint: "customer-onboarding",
			}),
			assistantContent: "Workflow started.",
			evidence: null,
		}));
		const result = await runKernelTurnWork(
			stubDeps({
				db: dbWithPriorRuns(PENDING_PRIOR_RUNS),
				kernel,
				dispatchWorkflowConfirm,
			}),
			{ ...affirmativeInput(), executionPolicy: "observe_only" },
		);

		expect(dispatchWorkflowConfirm).not.toHaveBeenCalled();
		expect(kernel).toHaveBeenCalledTimes(1);
		expect(result.run.metadata).toMatchObject({
			kernelRoute: null,
			kernelObservation: {
				selectedRoute: { routeKind: "run_workflow" },
			},
		});
	});
	it("affirmative + pending run_workflow hint → dispatches and skips the LLM (kernel never called)", async () => {
		let kernelCalled = false;
		const dispatched: Array<{ workflowSlug: string }> = [];
		const recorder = progressRecorder();
		const deps = stubDeps({
			db: dbWithPriorRuns(PENDING_PRIOR_RUNS),
			kernel: async () => {
				kernelCalled = true;
				return null;
			},
			dispatchWorkflowConfirm: async (input) => {
				dispatched.push({ workflowSlug: input.workflowSlug });
				return {
					workflowRunId: "wf-run-9",
					workflowTediId: "tedi-acme",
					status: "dispatched",
				};
			},
			onProgress: recorder.onProgress,
		});

		const result = await runKernelTurnWork(deps, affirmativeInput());

		expect(kernelCalled).toBe(false);
		expect(dispatched).toEqual([{ workflowSlug: "customer-onboarding" }]);
		expect(recorder.stages[0]).toBe("Starting customer-onboarding workflow");
		// Dispatch-snapshot status (run row is authoritative "completed").
		expect(result.status).toBe("needs_delegation");
		expect(result.run.status).toBe("completed");
		expect(result.assistantMessage.content).toContain("wf-run-9");
		expect(result.assistantMessage.content).toContain("customer-onboarding");
		expect(result.run.metadata).toMatchObject({
			kernelWorkflowConfirm: {
				workflowRunId: "wf-run-9",
				workflowTediId: "tedi-acme",
			},
		});
	});

	it("dispatch failure → fail-soft error reply (no crash), run row failed", async () => {
		const deps = stubDeps({
			db: dbWithPriorRuns(PENDING_PRIOR_RUNS),
			kernel: async () => {
				throw new Error("kernel should not run");
			},
			dispatchWorkflowConfirm: async () => ({
				workflowRunId: "",
				status: "failed",
				error: "skill not found",
			}),
		});

		const result = await runKernelTurnWork(deps, affirmativeInput());

		expect(result.status).toBe("failed");
		expect(result.run.status).toBe("failed");
		expect(result.assistantMessage.content).toContain("Couldn't start");
		expect(result.assistantMessage.content).toContain("skill not found");
	});

	it("dispatcher throwing → caught, surfaced as a failed reply (never bubbles)", async () => {
		const privateText = "private-workflow-provider-7919";
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const deps = stubDeps({
			db: dbWithPriorRuns(PENDING_PRIOR_RUNS),
			dispatchWorkflowConfirm: async () => {
				throw new Error(`binding blew up for ${privateText}`);
			},
		});
		try {
			const result = await runKernelTurnWork(deps, affirmativeInput());
			expect(result.status).toBe("failed");
			expect(result.assistantMessage.content).toContain("binding blew up");
			expect(warnSpy).toHaveBeenCalledWith({
				component: "kernel.turn_work",
				event: "workflow_confirm_dispatch_failed",
				error: { type: "Error" },
			});
			expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(privateText);
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("non-affirmative reply → no dispatch, normal kernel planning runs", async () => {
		let kernelCalled = false;
		let dispatchCalled = false;
		const deps = stubDeps({
			db: dbWithPriorRuns(PENDING_PRIOR_RUNS),
			kernel: async () => {
				kernelCalled = true;
				return {
					route: route({ routeKind: "answer_in_home", answer: "ok" }),
					assistantContent: "ok",
					evidence: null,
				};
			},
			dispatchWorkflowConfirm: async () => {
				dispatchCalled = true;
				return { workflowRunId: "x", status: "dispatched" };
			},
		});

		// "not yet" is not in the affirmative set → falls through to the LLM.
		const result = await runKernelTurnWork(deps, {
			...turnInput(),
			content: "not yet",
		});

		expect(dispatchCalled).toBe(false);
		expect(kernelCalled).toBe(true);
		expect(result.assistantMessage.content).toBe("ok");
	});

	it("affirmative but NO pending hint → no dispatch, normal kernel planning runs", async () => {
		let kernelCalled = false;
		let dispatchCalled = false;
		const deps = stubDeps({
			// Only the current run exists → no prior pending hint.
			db: dbWithPriorRuns([{ id: "run-1", status: "running", metadata: {} }]),
			kernel: async () => {
				kernelCalled = true;
				return {
					route: route({ routeKind: "answer_in_home", answer: "sure" }),
					assistantContent: "sure",
					evidence: null,
				};
			},
			dispatchWorkflowConfirm: async () => {
				dispatchCalled = true;
				return { workflowRunId: "x", status: "dispatched" };
			},
		});

		const result = await runKernelTurnWork(deps, affirmativeInput());

		expect(dispatchCalled).toBe(false);
		expect(kernelCalled).toBe(true);
		expect(result.assistantMessage.content).toBe("sure");
	});

	it("no dispatcher dep wired → affirmative is a normal turn (fall-through)", async () => {
		let kernelCalled = false;
		const deps = stubDeps({
			db: dbWithPriorRuns(PENDING_PRIOR_RUNS),
			// dispatchWorkflowConfirm omitted.
			kernel: async () => {
				kernelCalled = true;
				return {
					route: route({ routeKind: "answer_in_home", answer: "hi" }),
					assistantContent: "hi",
					evidence: null,
				};
			},
		});

		const result = await runKernelTurnWork(deps, affirmativeInput());
		expect(kernelCalled).toBe(true);
		expect(result.assistantMessage.content).toBe("hi");
	});
});

/**
 * Inbox-wake reconciliation intercept tests.
 *
 * Fix 1 (ID namespace): the dep receives `childRunIds` (not `runIds`) — the
 * field name proves the intercept passes child IDs, not parent IDs. The dep
 * implementation in kernel-runtime.ts queries by childRunId column; that DB
 * behavior is not testable here (createKernelRuntimeDb fake doesn't support
 * childRunId-column queries) so we test at the observable dep boundary.
 *
 * Wake turns always use the intercept when the reconciler dep is present.
 */
describe("runKernelTurnWork inbox-wake reconciliation", () => {
	function wakeMetadata(childRunIds: string[]): Record<string, unknown> {
		return {
			source: "kernel.inboxWakeAlarm",
			kernelInboxRunIds: childRunIds,
			subject: "home",
			delegation: "none",
			childRunId: null,
		};
	}

	function wakeInput(childRunIds: string[]): KernelTurnWorkInput {
		return {
			...turnInput(),
			content: "[System: 2 delegated tasks completed — results in inbox]",
			runtimeMetadata: wakeMetadata(childRunIds),
		};
	}

	it("observe-only skips inbox reconciliation and routes only the observation", async () => {
		const reconcileInboxWake = vi.fn();
		const kernel = vi.fn(async () => ({
			route: route({ routeKind: "answer_in_home", answer: "Would reconcile." }),
			assistantContent: "Reconciled.",
			evidence: null,
		}));
		const result = await runKernelTurnWork(
			stubDeps({ kernel, reconcileInboxWake }),
			{ ...wakeInput(["child-1"]), executionPolicy: "observe_only" },
		);
		expect(reconcileInboxWake).not.toHaveBeenCalled();
		expect(kernel).toHaveBeenCalledTimes(1);
		expect(result.assistantMessage.content).not.toContain("Reconciled.");
	});

	it("intercept fires: reconciler called with childRunIds and LLM skipped", async () => {
		let kernelCalled = false;
		let capturedInput:
			| { organizationId: string; childRunIds: string[] }
			| undefined;

		const deps = stubDeps({
			reconcileInboxWakeRuns: async (input) => {
				capturedInput = input;
				return { runs: [], freshlySettledChildRunIds: new Set() };
			},
			kernel: async () => {
				kernelCalled = true;
				return {
					route: route({}),
					assistantContent: "should not reach",
					evidence: null,
				};
			},
		});

		await runKernelTurnWork(deps, wakeInput(["child-run-a", "child-run-b"]));

		// Fix 1: dep receives childRunIds, not runIds.
		expect(capturedInput?.childRunIds).toEqual(["child-run-a", "child-run-b"]);
		// Wake turns with a reconciler skip the LLM planner.
		expect(kernelCalled).toBe(false);
	});

	it("intercept assembles assistant content from freshly-settled run statuses", async () => {
		// Runs must have childRunId set so the dedup filter can match them against
		// freshlySettledChildRunIds.
		const makeRun = (
			id: string,
			childRunId: string,
			status: "completed" | "failed",
		) =>
			({
				id,
				organizationId: "org-1",
				conversationId: "home:main",
				status,
				inputMessageId: `${id}:input`,
				outputMessageId: `${id}:out`,
				delegatedTediId: "cto",
				childRunId,
				runtime: { backend: "custom" as const, externalId: id, metadata: {} },
				startedAt: "2026-06-18T00:00:00.000Z",
				completedAt: "2026-06-18T00:00:10.000Z",
				createdAt: "2026-06-18T00:00:00.000Z",
				updatedAt: "2026-06-18T00:00:10.000Z",
				metadata: {},
				progress: { current: 1, detail: "", label: status, total: 1 },
			}) as import("@tedix/api-contract/schemas/kernel-runtime").HomeRun;

		const deps = stubDeps({
			reconcileInboxWakeRuns: async () => ({
				runs: [
					makeRun("p1", "c1", "completed"),
					makeRun("p2", "c2", "completed"),
					makeRun("p3", "c3", "failed"),
				],
				// All three are freshly settled — not previously delivered.
				freshlySettledChildRunIds: new Set(["c1", "c2", "c3"]),
			}),
		});

		const result = await runKernelTurnWork(deps, wakeInput(["c1", "c2", "c3"]));

		expect(result.run.status).toBe("completed");
		// Deterministic wake notice = the factual count of settled delegated work.
		expect(result.assistantMessage.content).toBe(
			"Update from delegated work: 2 tasks completed, 1 failed.",
		);
	});

	it("intercept does not require an inbox-wake env flag", async () => {
		let reconcileCalled = false;
		let kernelCalled = false;

		const deps = stubDeps({
			env: {} as CloudflareEnv,
			reconcileInboxWakeRuns: async () => {
				reconcileCalled = true;
				return { runs: [], freshlySettledChildRunIds: new Set() };
			},
			kernel: async () => {
				kernelCalled = true;
				return {
					route: route({ routeKind: "answer_in_home", answer: "fallthrough" }),
					assistantContent: "fallthrough",
					evidence: null,
				};
			},
		});

		const result = await runKernelTurnWork(deps, wakeInput(["child-run-x"]));

		expect(reconcileCalled).toBe(true);
		expect(kernelCalled).toBe(false);
		expect(result.assistantMessage.content).not.toBe("fallthrough");
	});

	it("intercept is inert when dep is absent even with matching metadata", async () => {
		let kernelCalled = false;

		const deps = stubDeps({
			// reconcileInboxWakeRuns NOT wired
			kernel: async () => {
				kernelCalled = true;
				return {
					route: route({ routeKind: "answer_in_home", answer: "fallthrough" }),
					assistantContent: "fallthrough",
					evidence: null,
				};
			},
		});

		await runKernelTurnWork(deps, wakeInput(["child-run-1"]));
		expect(kernelCalled).toBe(true);
	});

	it("wake turn with empty kernelInboxRunIds → quiet no-op (reconciles, no planner, no canned greeting)", async () => {
		let reconcileCalled = false;
		let kernelCalled = false;

		const deps = stubDeps({
			reconcileInboxWakeRuns: async () => {
				reconcileCalled = true;
				return { runs: [], freshlySettledChildRunIds: new Set() };
			},
			kernel: async () => {
				kernelCalled = true;
				return {
					route: route({ routeKind: "answer_in_home", answer: "fallthrough" }),
					assistantContent: "fallthrough",
					evidence: null,
				};
			},
		});

		// A wake turn (source kernel.inboxWakeAlarm) with empty/absent ids is a
		// stale or already-consumed wake — it must be a QUIET no-op (reconcile [],
		// no fresh delivery, no planner, no canned "This is Home:" greeting), never
		// fall through to normal routing.
		await runKernelTurnWork(deps, wakeInput([]));
		expect(reconcileCalled).toBe(true);
		expect(kernelCalled).toBe(false);
	});

	it("intercept is inert when source field does not match", async () => {
		let reconcileCalled = false;
		let kernelCalled = false;

		const deps = stubDeps({
			reconcileInboxWakeRuns: async () => {
				reconcileCalled = true;
				return { runs: [], freshlySettledChildRunIds: new Set() };
			},
			kernel: async () => {
				kernelCalled = true;
				return {
					route: route({ routeKind: "answer_in_home", answer: "normal" }),
					assistantContent: "normal",
					evidence: null,
				};
			},
		});

		const wrongSource: KernelTurnWorkInput = {
			...turnInput(),
			runtimeMetadata: {
				source: "some.other.source",
				kernelInboxRunIds: ["child-run-1"],
			},
		};
		await runKernelTurnWork(deps, wrongSource);
		expect(reconcileCalled).toBe(false);
		expect(kernelCalled).toBe(true);
	});

	it("PRIMARY FIX: quiet no-op when all children already delivered (freshlySettledChildRunIds empty)", async () => {
		// Simulates the race where the parent-waits on-read path already delivered the
		// child's result, so reconcileInboxWakeRuns finds the parent row already in
		// terminal status → freshlySettledChildRunIds is empty.
		let kernelCalled = false;
		let messageCompletedInserted = false;

		const deps = stubDeps({
			reconcileInboxWakeRuns: async () => ({
				runs: [
					{
						id: "p1",
						organizationId: "org-1",
						conversationId: "home:main",
						status: "completed" as const,
						inputMessageId: "p1:input",
						outputMessageId: "p1:out",
						delegatedTediId: "cto",
						childRunId: "child-run-1",
						runtime: {
							backend: "custom" as const,
							externalId: "p1",
							metadata: {},
						},
						startedAt: "2026-06-22T00:00:00.000Z",
						completedAt: "2026-06-22T00:00:10.000Z",
						createdAt: "2026-06-22T00:00:00.000Z",
						updatedAt: "2026-06-22T00:00:10.000Z",
						metadata: {},
						progress: { current: 1, detail: "", label: "completed", total: 1 },
					} as import("@tedix/api-contract/schemas/kernel-runtime").HomeRun,
				],
				// Empty: child-run-1 was already delivered by the parent-waits path.
				freshlySettledChildRunIds: new Set<string>(),
			}),
			// Override insertKernelRuntimeEvent to track whether a message.completed was written.
			insertKernelRuntimeEvent: async (input) => {
				if (input.kind === "message.completed") messageCompletedInserted = true;
				return {
					runtime: { backend: "custom" as const, metadata: {} },
					createdAt: new Date().toISOString(),
				};
			},
			kernel: async () => {
				kernelCalled = true;
				return {
					route: route({}),
					assistantContent: "should not reach",
					evidence: null,
				};
			},
		});

		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const result = await runKernelTurnWork(deps, wakeInput(["child-run-1"]));

			// No assistant message inserted into the conversation.
			expect(messageCompletedInserted).toBe(false);
			// LLM planner must NOT run.
			expect(kernelCalled).toBe(false);
			// Run still completes (run.completed event is written, run settled).
			expect(result.run.status).toBe("completed");
			// Sentinel content — not surfaced to the operator.
			expect(result.assistantMessage.content).toBe("");
			expect(warnSpy).toHaveBeenCalledWith({
				component: "kernel.turn_work",
				event: "inbox_wake_no_new_delivery",
				inboxChildCount: 1,
				reconciledCount: 1,
			});
			expect(JSON.stringify(warnSpy.mock.calls)).not.toContain("child-run-1");
			expect(JSON.stringify(warnSpy.mock.calls)).not.toContain("home:main");
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("EXACTLY ONCE: a canonical direct-completion event suppresses the synthetic wake answer", async () => {
		// Production reconciliation writes the direct child's deterministic parent
		// `:async-completion:assistant` event before returning to this wake turn.
		// The child is still "fresh" for reconciliation/audit purposes, but the
		// durable event already owns operator delivery. The wake must therefore be
		// a quiet no-op instead of persisting the same text under a new run id.
		let messageCompletedInserted = false;
		const directRun = {
			id: "parent-run-1",
			organizationId: "org-1",
			conversationId: "home:main",
			status: "completed" as const,
			inputMessageId: "parent-run-1:input",
			outputMessageId: "parent-run-1:async-completion:assistant",
			delegatedTediId: "ceo",
			childRunId: "child-run-1",
			runtime: {
				backend: "custom" as const,
				externalId: "parent-run-1",
				metadata: {},
			},
			startedAt: "2026-07-16T20:01:57.179Z",
			completedAt: "2026-07-16T20:02:43.683Z",
			createdAt: "2026-07-16T20:01:57.179Z",
			updatedAt: "2026-07-16T20:02:43.683Z",
			metadata: {},
			progress: {
				current: 100,
				detail: "Complete",
				label: "Complete",
				total: 100,
			},
		} as import("@tedix/api-contract/schemas/kernel-runtime").HomeRun;

		const deps = stubDeps({
			reconcileInboxWakeRuns: async () => ({
				runs: [directRun],
				freshlySettledChildRunIds: new Set(["child-run-1"]),
				canonicalDirectCompletionChildRunIds: new Set(["child-run-1"]),
			}),
			insertKernelRuntimeEvent: async (input) => {
				if (input.kind === "message.completed") messageCompletedInserted = true;
				return {
					id: input.id ?? "event-1",
					organizationId: input.organizationId,
					kind: input.kind,
					conversationId: input.conversationId,
					runId: input.runId,
					messageId: input.messageId,
					payload: input.payload,
					runtime: { backend: "custom" as const, metadata: {} },
					createdAt: input.createdAt ?? new Date().toISOString(),
				};
			},
		});

		const result = await runKernelTurnWork(deps, wakeInput(["child-run-1"]));

		expect(messageCompletedInserted).toBe(false);
		expect(result.assistantMessage.content).toBe("");
		expect(result.run.metadata?.kernelInboxWake).toMatchObject({
			canonicalDirectCompletionChildRunIds: ["child-run-1"],
			completedCount: 0,
			failedCount: 0,
		});
	});

	it("DEDUP: only freshly-settled children produce a wake message; already-delivered children are skipped", async () => {
		// child-run-1 was already delivered by parent-waits; child-run-2 is new.
		const makeRun = (
			id: string,
			childRunId: string,
			status: "completed" | "failed",
		) =>
			({
				id,
				organizationId: "org-1",
				conversationId: "home:main",
				status,
				inputMessageId: `${id}:input`,
				outputMessageId: `${id}:out`,
				delegatedTediId: "cto",
				childRunId,
				runtime: { backend: "custom" as const, externalId: id, metadata: {} },
				startedAt: "2026-06-22T00:00:00.000Z",
				completedAt: "2026-06-22T00:00:10.000Z",
				createdAt: "2026-06-22T00:00:00.000Z",
				updatedAt: "2026-06-22T00:00:10.000Z",
				metadata: {},
				progress: { current: 1, detail: "", label: status, total: 1 },
			}) as import("@tedix/api-contract/schemas/kernel-runtime").HomeRun;

		const deps = stubDeps({
			reconcileInboxWakeRuns: async () => ({
				runs: [
					makeRun("p1", "child-run-1", "completed"), // already delivered
					makeRun("p2", "child-run-2", "completed"), // freshly settled
				],
				// Only child-run-2 is fresh; child-run-1 was already delivered.
				freshlySettledChildRunIds: new Set(["child-run-2"]),
			}),
		});

		const result = await runKernelTurnWork(
			deps,
			wakeInput(["child-run-1", "child-run-2"]),
		);

		// Message is written for the ONE fresh child (not for the already-delivered one).
		expect(result.assistantMessage.content).toBe(
			"Update from delegated work: 1 task completed.",
		);
		expect(result.run.status).toBe("completed");
	});
});

// ─── Delegation synthesis ─────────────────────────────────────────────────────

describe("runKernelTurnWork inbox-wake synthesis", () => {
	function wakeMetadata(childRunIds: string[]): Record<string, unknown> {
		return {
			source: "kernel.inboxWakeAlarm",
			kernelInboxRunIds: childRunIds,
			subject: "home",
			delegation: "none",
			childRunId: null,
		};
	}

	function wakeInput(childRunIds: string[]): KernelTurnWorkInput {
		return {
			...turnInput(),
			content: "[System: delegated tasks completed]",
			runtimeMetadata: wakeMetadata(childRunIds),
		};
	}

	// Env with the three vars kernelModel() requires for a non-null model
	// (authenticated AI Gateway + Azure resource + deployment). The
	// model object is built but never hits the network — `generateText` is mocked.
	function synthEnabledEnvWithModel(): CloudflareEnv {
		return {
			AZURE_OPENAI_BASE_URL: "https://test.openai.azure.com",
			AZURE_CHAT_DEPLOYMENT: "gpt-test",
			AI_GATEWAY_ACCOUNT_ID: "account",
			AI_GATEWAY_LLM_ID: "gateway",
			CF_AI_GATEWAY_TOKEN: "token",
		} as unknown as CloudflareEnv;
	}

	function makeCompletedRun(
		id: string,
		delegatedTediId: string,
		childRunId: string,
	): import("@tedix/api-contract/schemas/kernel-runtime").HomeRun {
		return {
			id,
			organizationId: "org-1",
			conversationId: "home:main",
			status: "completed" as const,
			inputMessageId: `${id}:input`,
			outputMessageId: `${id}:out`,
			delegatedTediId,
			childRunId,
			runtime: { backend: "custom" as const, externalId: id, metadata: {} },
			startedAt: "2026-06-22T00:00:00.000Z",
			completedAt: "2026-06-22T00:00:10.000Z",
			createdAt: "2026-06-22T00:00:00.000Z",
			updatedAt: "2026-06-22T00:00:10.000Z",
			metadata: {},
			progress: { current: 1, detail: "", label: "completed", total: 1 },
		};
	}

	function makeFailedRun(
		id: string,
		delegatedTediId: string,
		childRunId: string,
	): import("@tedix/api-contract/schemas/kernel-runtime").HomeRun {
		return {
			...makeCompletedRun(id, delegatedTediId, childRunId),
			status: "failed" as const,
			completedAt: "2026-06-22T00:00:10.000Z",
		};
	}

	it("reads child evidence even when kernelModel is null", async () => {
		const called: Array<{ tediId: string; runId: string }> = [];
		const deps = stubDeps({
			reconcileInboxWakeRuns: async () => ({
				runs: [makeCompletedRun("p1", "cto", "child-run-1")],
				freshlySettledChildRunIds: new Set(["child-run-1"]),
			}),
			readChildRunFullResult: async (input) => {
				called.push({ tediId: input.tediId, runId: input.runId });
				return null;
			},
		});

		const result = await runKernelTurnWork(deps, wakeInput(["child-run-1"]));

		// The evidence read is model-independent so fallback content can stay
		// evidence-bearing when no model is configured.
		expect(called).toHaveLength(1);
		// Falls back to count
		expect(result.assistantMessage.content).toBe(
			"Update from delegated work: 1 task completed.",
		);
	});

	it("falls back to count when dep is absent", async () => {
		const deps = stubDeps({
			reconcileInboxWakeRuns: async () => ({
				runs: [makeCompletedRun("p1", "cto", "child-run-1")],
				freshlySettledChildRunIds: new Set(["child-run-1"]),
			}),
			// readChildRunFullResult NOT wired
		});

		const result = await runKernelTurnWork(deps, wakeInput(["child-run-1"]));

		// No dep → falls back to count
		expect(result.assistantMessage.content).toBe(
			"Update from delegated work: 1 task completed.",
		);
	});

	it("freshlyCompletedRuns filter excludes failed children — only completed count drives synthesis path", async () => {
		// With no Azure creds (kernelModel null), dep isn't called regardless.
		// This test pins that freshlyCompletedRuns only includes completed children:
		// with 1 completed + 1 failed both freshly settled, completedCount=1 (not 2).
		const deps = stubDeps({
			reconcileInboxWakeRuns: async () => ({
				runs: [
					makeCompletedRun("p1", "cto", "child-run-1"),
					makeFailedRun("p2", "cfo", "child-run-2"),
				],
				freshlySettledChildRunIds: new Set(["child-run-1", "child-run-2"]),
			}),
			readChildRunFullResult: async () => null,
		});

		const result = await runKernelTurnWork(
			deps,
			wakeInput(["child-run-1", "child-run-2"]),
		);

		// 1 completed + 1 failed → "1 task completed, 1 failed"
		expect(result.assistantMessage.content).toBe(
			"Update from delegated work: 1 task completed, 1 failed.",
		);
		expect(result.run.status).toBe("completed");
	});

	it("persists one parent-scoped convergence message over all plan branches", async () => {
		const events: HomeTurnRuntimeEventInput[] = [];
		const deps = stubDeps({
			reconcileInboxWakeRuns: async () => ({
				runs: [
					{
						...makeCompletedRun("parent-plan", "", ""),
						delegatedTediId: null,
						childRunId: null,
					},
				],
				freshlySettledChildRunIds: new Set(["child-cto", "child-security"]),
				synthesisBranches: [
					{
						childRunId: "child-cto",
						delegatedTediId: "cto",
						parentRunId: "parent-plan",
						required: true,
						status: "completed",
					},
					{
						childRunId: "child-security",
						delegatedTediId: "security",
						parentRunId: "parent-plan",
						required: false,
						status: "completed",
					},
				],
			}),
			insertKernelRuntimeEvent: async (input) => {
				events.push(input);
				return {
					id: input.id ?? `event:${input.kind}`,
					organizationId: input.organizationId,
					kind: input.kind,
					conversationId: input.conversationId,
					runId: input.runId,
					messageId: input.messageId,
					payload: input.payload,
					runtime: { backend: "custom" },
					createdAt: input.createdAt ?? "2026-06-11T00:00:01.000Z",
				} as KernelRuntimeEvent;
			},
		});

		const result = await runKernelTurnWork(deps, wakeInput(["child-security"]));

		expect(result.assistantMessage.content).toBe(
			"Update from delegated work: 2 tasks completed.",
		);
		const convergence = events.find(
			(event) => event.payload?.metadata?.homePlanConvergence === true,
		);
		expect(convergence?.runId).toBe("parent-plan");
		expect(convergence?.messageId).toBe(
			"parent-plan:plan-convergence:assistant",
		);
		expect(convergence?.id).toContain("parent-plan:plan-convergence");
	});

	it("falls back to bounded child evidence when model is null", async () => {
		const deps = stubDeps({
			reconcileInboxWakeRuns: async () => ({
				runs: [makeCompletedRun("p1", "cto", "child-run-1")],
				freshlySettledChildRunIds: new Set(["child-run-1"]),
			}),
			readChildRunFullResult: async () => "full transcript here",
		});

		const result = await runKernelTurnWork(deps, wakeInput(["child-run-1"]));

		expect(result.assistantMessage.content).toContain(
			"Update from delegated work: 1 task completed.",
		);
		expect(result.assistantMessage.content).toContain(
			"Evidence from delegated branches:",
		);
		expect(result.assistantMessage.content).toContain("full transcript here");
		expect(result.run.status).toBe("completed");
	});

	it("falls back to count when readChildRunFullResult throws (fail-soft)", async () => {
		const deps = stubDeps({
			reconcileInboxWakeRuns: async () => ({
				runs: [makeCompletedRun("p1", "cto", "child-run-1")],
				freshlySettledChildRunIds: new Set(["child-run-1"]),
			}),
			readChildRunFullResult: async () => {
				throw new Error("db exploded");
			},
		});

		// Must NOT throw — fail-soft fallback
		const result = await runKernelTurnWork(deps, wakeInput(["child-run-1"]));
		expect(result.run.status).toBe("completed");
		expect(result.assistantMessage.content).toBe(
			"Update from delegated work: 1 task completed.",
		);
	});

	it("SECONDARY FIX: synthesis FIRES (model present) for a genuinely-new completed child and delivers the interpreted text", async () => {
		// Drives the `if (model)` branch with a non-null model and a mocked
		// generateText. Proves the synthesis path is actually entered (not just
		// gated out) and that its interpreted output is delivered to the operator.
		mockGenerateText.mockReset();
		mockGenerateText.mockResolvedValue({
			text: "CEO checked your gmail: 3 unread, top is from Ada re: pilot. Next: reply to Ada.",
		});
		const called: Array<{ tediId: string; runId: string }> = [];
		const deps = stubDeps({
			env: synthEnabledEnvWithModel(),
			reconcileInboxWakeRuns: async () => ({
				runs: [makeCompletedRun("p1", "ceo", "child-run-fresh")],
				freshlySettledChildRunIds: new Set(["child-run-fresh"]),
			}),
			readChildRunFullResult: async (input) => {
				called.push({ tediId: input.tediId, runId: input.runId });
				return "gmail: 3 unread messages, full transcript here";
			},
		});

		const result = await runKernelTurnWork(
			deps,
			wakeInput(["child-run-fresh"]),
		);

		// Synthesis path entered: the full-result dep WAS read for the fresh child.
		expect(called).toEqual([{ tediId: "ceo", runId: "child-run-fresh" }]);
		// generateText was actually invoked (synthesis ran, not the count fallback).
		expect(mockGenerateText).toHaveBeenCalledTimes(1);
		// The interpreted synthesis text is what reaches the operator — NOT the count.
		expect(result.assistantMessage.content).toBe(
			"CEO checked your gmail: 3 unread, top is from Ada re: pilot. Next: reply to Ada.",
		);
		expect(result.run.status).toBe("completed");
	});

	it("SECONDARY FIX: synthesis is scoped to FRESH children only — an already-delivered sibling is NOT re-read or re-synthesized", async () => {
		// Two completed runs reconcile but only one is freshly settled. With the
		// model present, the synthesis must read ONLY the fresh child's transcript;
		// the already-delivered child must never be re-read (no double-delivery).
		mockGenerateText.mockReset();
		mockGenerateText.mockResolvedValue({
			text: "interpreted fresh-only answer",
		});
		const called: Array<{ tediId: string; runId: string }> = [];
		const deps = stubDeps({
			env: synthEnabledEnvWithModel(),
			reconcileInboxWakeRuns: async () => ({
				runs: [
					makeCompletedRun("p1", "cto", "child-run-already"), // already delivered
					makeCompletedRun("p2", "cfo", "child-run-fresh"), // freshly settled
				],
				// Only child-run-fresh is new; child-run-already was pre-delivered.
				freshlySettledChildRunIds: new Set(["child-run-fresh"]),
			}),
			readChildRunFullResult: async (input) => {
				called.push({ tediId: input.tediId, runId: input.runId });
				return "fresh transcript";
			},
		});

		const result = await runKernelTurnWork(
			deps,
			wakeInput(["child-run-already", "child-run-fresh"]),
		);

		// ONLY the fresh child's transcript was read — the already-delivered one was skipped.
		expect(called).toEqual([{ tediId: "cfo", runId: "child-run-fresh" }]);
		expect(mockGenerateText).toHaveBeenCalledTimes(1);
		expect(result.assistantMessage.content).toBe(
			"interpreted fresh-only answer",
		);
	});

	it("synthesis timeout falls back to bounded child evidence", async () => {
		// A synthesis that errors (or aborts on the 15s timeout) must not crash the
		// wake; it falls back to the already-loaded, bounded child evidence.
		mockGenerateText.mockReset();
		mockGenerateText.mockRejectedValue(new Error("synthesis aborted"));
		const deps = stubDeps({
			env: synthEnabledEnvWithModel(),
			reconcileInboxWakeRuns: async () => ({
				runs: [makeCompletedRun("p1", "ceo", "child-run-fresh")],
				freshlySettledChildRunIds: new Set(["child-run-fresh"]),
			}),
			readChildRunFullResult: async () => "gmail transcript",
		});

		const result = await runKernelTurnWork(
			deps,
			wakeInput(["child-run-fresh"]),
		);

		// generateText threw → caught → evidence-bearing fallback, never a crash.
		expect(mockGenerateText).toHaveBeenCalledTimes(1);
		expect(result.assistantMessage.content).toContain(
			"Update from delegated work: 1 task completed.",
		);
		expect(result.assistantMessage.content).toContain("gmail transcript");
		expect(result.run.status).toBe("completed");
	});

	it("RELAY-FIRST: a single fresh child's final assistant message is delivered verbatim — no synthesis pass", async () => {
		// Harness contract: the child's final message IS the return value. With
		// exactly one freshly-completed child and a final message available, the
		// wake must relay it verbatim and never invoke transcript synthesis.
		mockGenerateText.mockReset();
		const fullResultCalled: string[] = [];
		const deps = stubDeps({
			env: synthEnabledEnvWithModel(),
			reconcileInboxWakeRuns: async () => ({
				runs: [makeCompletedRun("p1", "cto", "child-run-1")],
				freshlySettledChildRunIds: new Set(["child-run-1"]),
			}),
			readChildRunFinalAssistantMessage: async () =>
				"I’m responsive and ready.",
			readChildRunFullResult: async (input) => {
				fullResultCalled.push(input.runId);
				return "full transcript";
			},
		});

		const result = await runKernelTurnWork(deps, wakeInput(["child-run-1"]));

		expect(result.assistantMessage.content).toBe("I’m responsive and ready.");
		// Relay short-circuits synthesis entirely.
		expect(mockGenerateText).not.toHaveBeenCalled();
		expect(fullResultCalled).toHaveLength(0);
		expect(result.run.status).toBe("completed");
	});

	it("RELAY-FIRST: null final message falls through to synthesis (child ended without operator-facing text)", async () => {
		mockGenerateText.mockReset();
		mockGenerateText.mockResolvedValue({ text: "interpreted from transcript" });
		const deps = stubDeps({
			env: synthEnabledEnvWithModel(),
			reconcileInboxWakeRuns: async () => ({
				runs: [makeCompletedRun("p1", "cto", "child-run-1")],
				freshlySettledChildRunIds: new Set(["child-run-1"]),
			}),
			readChildRunFinalAssistantMessage: async () => null,
			readChildRunFullResult: async () => "tool-only transcript",
		});

		const result = await runKernelTurnWork(deps, wakeInput(["child-run-1"]));

		expect(mockGenerateText).toHaveBeenCalledTimes(1);
		expect(result.assistantMessage.content).toBe("interpreted from transcript");
	});

	it("RELAY-FIRST: multi-child deliveries skip the relay and use cross-child synthesis", async () => {
		mockGenerateText.mockReset();
		mockGenerateText.mockResolvedValue({ text: "cross-child interpretation" });
		const relayCalled: string[] = [];
		const deps = stubDeps({
			db: chainDbProxy([
				{
					metadata: {
						redriveInput: {
							content: "Reply in one concise sentence.",
						},
					},
				},
			]),
			env: synthEnabledEnvWithModel(),
			reconcileInboxWakeRuns: async () => ({
				runs: [
					makeCompletedRun("p1", "cto", "child-run-1"),
					makeCompletedRun("p2", "cfo", "child-run-2"),
				],
				freshlySettledChildRunIds: new Set(["child-run-1", "child-run-2"]),
				synthesisBranches: [
					{
						childRunId: "child-run-1",
						delegatedTediId: "cto",
						parentRunId: "parent-plan",
						required: true,
						status: "completed",
					},
					{
						childRunId: "child-run-2",
						delegatedTediId: "cfo",
						parentRunId: "parent-plan",
						required: true,
						status: "completed",
					},
				],
			}),
			readChildRunFinalAssistantMessage: async (input) => {
				relayCalled.push(input.runId);
				return "should not be used";
			},
			readChildRunFullResult: async () => "transcript",
		});

		const result = await runKernelTurnWork(
			deps,
			wakeInput(["child-run-1", "child-run-2"]),
		);

		// Two fresh children → relay branch must not even be consulted.
		expect(relayCalled).toHaveLength(0);
		expect(result.assistantMessage.content).toBe("cross-child interpretation");
		const synthesisCall = mockGenerateText.mock.calls[0]?.[0] as
			| { messages?: Array<{ content?: string }> }
			| undefined;
		expect(synthesisCall?.messages?.[0]?.content).toContain(
			"=== Original operator request ===\nReply in one concise sentence.",
		);
	});

	it("reads independent multi-child transcripts concurrently before synthesis", async () => {
		mockGenerateText.mockReset();
		mockGenerateText.mockResolvedValue({ text: "parallel synthesis" });
		let activeReads = 0;
		let maxActiveReads = 0;
		const deps = stubDeps({
			db: chainDbProxy([{ metadata: {} }]),
			env: synthEnabledEnvWithModel(),
			reconcileInboxWakeRuns: async () => ({
				runs: [
					makeCompletedRun("p1", "cto", "child-run-1"),
					makeCompletedRun("p2", "cfo", "child-run-2"),
				],
				freshlySettledChildRunIds: new Set(["child-run-1", "child-run-2"]),
				synthesisBranches: [
					{
						childRunId: "child-run-1",
						delegatedTediId: "cto",
						parentRunId: "parent-plan",
						required: true,
						status: "completed",
					},
					{
						childRunId: "child-run-2",
						delegatedTediId: "cfo",
						parentRunId: "parent-plan",
						required: true,
						status: "completed",
					},
				],
			}),
			readChildRunFullResult: async (input) => {
				activeReads += 1;
				maxActiveReads = Math.max(maxActiveReads, activeReads);
				await new Promise((resolve) => setTimeout(resolve, 10));
				activeReads -= 1;
				return `${input.runId} transcript`;
			},
		});

		const result = await runKernelTurnWork(
			deps,
			wakeInput(["child-run-1", "child-run-2"]),
		);

		expect(maxActiveReads).toBe(2);
		expect(result.assistantMessage.content).toBe("parallel synthesis");
	});

	it("RELAY-FIRST: a throwing final-message reader fails soft into synthesis", async () => {
		mockGenerateText.mockReset();
		mockGenerateText.mockResolvedValue({ text: "synthesized fallback" });
		const deps = stubDeps({
			env: synthEnabledEnvWithModel(),
			reconcileInboxWakeRuns: async () => ({
				runs: [makeCompletedRun("p1", "cto", "child-run-1")],
				freshlySettledChildRunIds: new Set(["child-run-1"]),
			}),
			readChildRunFinalAssistantMessage: async () => {
				throw new Error("read exploded");
			},
			readChildRunFullResult: async () => "transcript",
		});

		const result = await runKernelTurnWork(deps, wakeInput(["child-run-1"]));

		expect(result.run.status).toBe("completed");
		expect(result.assistantMessage.content).toBe("synthesized fallback");
	});
});

describe("runKernelTurnWork conversation auto-title dispatch", () => {
	it("invokes generateConversationTitle exactly once with the settled exchange", async () => {
		const calls: Array<Record<string, unknown>> = [];
		const deps = stubDeps({
			kernel: async () => ({
				route: route({ routeKind: "answer_in_home", answer: "All quiet." }),
				assistantContent: "All quiet.",
				evidence: null,
			}),
			generateConversationTitle: (input) => {
				calls.push({ ...input });
			},
		});
		const result = await runKernelTurnWork(deps, turnInput());
		expect(result.status).toBe("needs_delegation");
		expect(calls).toEqual([
			{
				organizationId: "org-1",
				conversationId: "home:main",
				runId: "run-1",
				userContent: "what changed today?",
				assistantContent: "All quiet.",
			},
		]);
	});

	it("model-unavailable turn (no route) never invokes title generation", async () => {
		const titleSpy = vi.fn();
		const deps = stubDeps({
			kernel: async () => null,
			generateConversationTitle: titleSpy,
		});
		const result = await runKernelTurnWork(deps, turnInput());
		expect(result.status).toBe("failed");
		expect(titleSpy).not.toHaveBeenCalled();
	});

	it("a throwing title sink is swallowed — the settled turn is unaffected (non-blocking contract)", async () => {
		const privateText = "private-title-content-7919";
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const deps = stubDeps({
			kernel: async () => ({
				route: route({ routeKind: "answer_in_home", answer: "All quiet." }),
				assistantContent: "All quiet.",
				evidence: null,
			}),
			generateConversationTitle: () => {
				throw new Error(`title sink exploded for ${privateText}`);
			},
		});
		try {
			const result = await runKernelTurnWork(deps, {
				...turnInput(),
				content: privateText,
			});
			expect(result.status).toBe("needs_delegation");
			expect(result.assistantMessage.content).toBe("All quiet.");
			expect(warnSpy).toHaveBeenCalledWith({
				component: "kernel.turn_work",
				event: "conversation_title_dispatch_failed",
				error: { type: "Error" },
			});
			expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(privateText);
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("dep absent → no dispatch attempt, turn settles normally", async () => {
		const deps = stubDeps({
			kernel: async () => ({
				route: route({ routeKind: "answer_in_home", answer: "All quiet." }),
				assistantContent: "All quiet.",
				evidence: null,
			}),
		});
		const result = await runKernelTurnWork(deps, turnInput());
		expect(result.status).toBe("needs_delegation");
	});

	it("dep returns a promise (waitUntil-less context) → the turn work AWAITS it before resolving", async () => {
		// The KernelDO drop class: the DO's synthetic turn context has no
		// waitUntil, so the dep returns the title promise and the turn body must
		// hold it — otherwise the detached promise is silently dropped when the
		// DO is aborted/idled. Proof: the returned promise completes across a real
		// macrotask boundary and the flag MUST be set by the time the turn resolves.
		let titleCompleted = false;
		const deps = stubDeps({
			kernel: async () => ({
				route: route({ routeKind: "answer_in_home", answer: "All quiet." }),
				assistantContent: "All quiet.",
				evidence: null,
			}),
			generateConversationTitle: () =>
				new Promise<void>((resolve) => {
					setTimeout(() => {
						titleCompleted = true;
						resolve();
					}, 10);
				}),
		});
		const result = await runKernelTurnWork(deps, turnInput());
		expect(result.status).toBe("needs_delegation");
		expect(titleCompleted).toBe(true);
	});

	it("dep returns void while its background work is still pending (waitUntil path) → the settle does NOT wait on title completion", async () => {
		// Inline HTTP contract: when the dep parked the work on a real waitUntil
		// it returns void, and the settle must not gain title latency — even if
		// the background title work never finishes.
		let backgroundStarted = false;
		const deps = stubDeps({
			kernel: async () => ({
				route: route({ routeKind: "answer_in_home", answer: "All quiet." }),
				assistantContent: "All quiet.",
				evidence: null,
			}),
			generateConversationTitle: () => {
				backgroundStarted = true;
				// Never-settling background promise, deliberately NOT returned —
				// simulates waitUntil-registered work still in flight.
				void new Promise<void>(() => {});
			},
		});
		const result = await runKernelTurnWork(deps, turnInput());
		expect(backgroundStarted).toBe(true);
		expect(result.status).toBe("needs_delegation");
		expect(result.assistantMessage.content).toBe("All quiet.");
	});

	it("a REJECTING returned title promise is swallowed — the settled turn is unaffected", async () => {
		// Belt-and-braces: the real dep never rejects (it .catch()es internally),
		// but the await site's try/catch must still shield the settle if one does.
		const deps = stubDeps({
			kernel: async () => ({
				route: route({ routeKind: "answer_in_home", answer: "All quiet." }),
				assistantContent: "All quiet.",
				evidence: null,
			}),
			generateConversationTitle: () =>
				Promise.reject(new Error("title promise exploded")),
		});
		const result = await runKernelTurnWork(deps, turnInput());
		expect(result.status).toBe("needs_delegation");
		expect(result.assistantMessage.content).toBe("All quiet.");
	});
});

describe("runKernelTurnWork operator-cancel gates (P0)", () => {
	/**
	 * Chainable db proxy whose SELECT chains resolve a queued sequence of run
	 * rows (repeating the last entry once exhausted), while every other chain
	 * (updates, inserts) resolves `[{}]` like {@link chainDbProxy}. `updateSets`
	 * records each `.set(...)` payload so a test can assert the canceled-turn
	 * child-link persist without a real DB.
	 */
	function sequencedSelectDbProxy(
		selectRows: Array<Record<string, unknown>>,
		updateSets?: Array<Record<string, unknown>>,
	): DbClient {
		let selectIndex = 0;
		function chain(kind: "select" | "other"): unknown {
			const proxy: unknown = new Proxy(function noop() {}, {
				get(_target, prop) {
					if (prop === "then") {
						if (kind === "select") {
							const row =
								selectRows[Math.min(selectIndex, selectRows.length - 1)];
							selectIndex += 1;
							return (resolve: (value: unknown[]) => void) =>
								resolve(row === undefined ? [] : [row]);
						}
						return (resolve: (value: unknown[]) => void) => resolve([{}]);
					}
					if (prop === "select") {
						return () => chain("select");
					}
					if (prop === "set" && updateSets) {
						return (patch: Record<string, unknown>) => {
							updateSets.push(patch);
							return proxy;
						};
					}
					return proxy;
				},
				apply() {
					return proxy;
				},
			});
			return proxy;
		}
		return chain("other") as DbClient;
	}

	const AUTO_WORK_ORDER = {
		kind: "tedi.delegate",
		objective: "Review the roadmap.",
		outputContract: "Top 3 priorities.",
		status: "draft",
		toolGuidance: [],
		boundaries: [],
		sourceContent: "Delegate to CTO: review the roadmap.",
		targetTediId: "tedi-cto",
		targetTediLabel: "CTO",
	};

	function autoDelegateKernel(
		options: { explicitDelegationIntent?: boolean } = {},
	): KernelTurnWorkDeps["kernel"] {
		return async () =>
			({
				route: route({
					routeKind: "delegate_tedi",
					targetTediId: "tedi-cto",
					targetTediLabel: "CTO",
					// Work-Item minting is gated on the operator's explicit ask; the
					// dispatch-path tests below model an explicit "delegate to CTO".
					explicitDelegationIntent: options.explicitDelegationIntent ?? true,
				}),
				assistantContent:
					"On it — delegating to CTO now. I'll bring CTO's result back here when it's done.",
				evidence: null,
				delegation: {
					workOrder: AUTO_WORK_ORDER,
					decision: { mode: "auto", canAutoDispatch: true, reason: "test" },
				},
			}) as unknown as Awaited<ReturnType<KernelTurnWorkDeps["kernel"]>>;
	}

	it("pre-dispatch gate: a run row already canceled skips the child dispatch entirely and settles with the canceled marker", async () => {
		const capturedEvents: Array<{
			kind: string;
			payload: Record<string, unknown> | undefined;
		}> = [];
		const dispatch = vi.fn(async () => ({
			childRunId: "tedi-cto:mcp:run-1_auto_tedi-cto",
			status: "queued" as const,
		}));
		const deps = stubDeps({
			db: sequencedSelectDbProxy([{ status: "canceled", metadata: {} }]),
			kernel: autoDelegateKernel(),
			dispatchAutoDelegation: dispatch,
			insertKernelRuntimeEvent: capturingPayloadInsert(capturedEvents),
		});
		const result = await runKernelTurnWork(deps, turnInput());

		expect(dispatch).not.toHaveBeenCalled();
		expect(result.run.status).toBe("canceled");
		expect(result.assistantMessage.content).toBe(
			"Turn canceled — no work was dispatched.",
		);
		// The truthful terminal marker IS the turn's completion content…
		const marker = capturedEvents.find((e) => e.kind === "message.completed");
		expect(marker?.payload?.content).toBe(
			"Turn canceled — no work was dispatched.",
		);
		// …and NO completion/failure event shadows the cancel core's run.canceled.
		expect(
			capturedEvents.some(
				(e) => e.kind === "run.completed" || e.kind === "run.failed",
			),
		).toBe(false);
	});

	it("pre-materialize gate: a cancel landing mid-turn replaces the routed ack with the canceled marker (no dangling promise)", async () => {
		const capturedEvents: Array<{
			kind: string;
			payload: Record<string, unknown> | undefined;
		}> = [];
		const deps = stubDeps({
			db: sequencedSelectDbProxy([{ status: "canceled", metadata: {} }]),
			kernel: async () => ({
				route: route({
					routeKind: "answer_in_home",
					answer: "On it — delegating to CTO now.",
				}),
				assistantContent: "On it — delegating to CTO now.",
				evidence: null,
			}),
			insertKernelRuntimeEvent: capturingPayloadInsert(capturedEvents),
		});
		const result = await runKernelTurnWork(deps, turnInput());

		expect(result.run.status).toBe("canceled");
		expect(result.assistantMessage.content).toBe(
			"Turn canceled — no work was dispatched.",
		);
		const messageEvents = capturedEvents.filter(
			(e) => e.kind === "message.completed",
		);
		expect(messageEvents).toHaveLength(1);
		expect(messageEvents[0]?.payload?.content).toBe(
			"Turn canceled — no work was dispatched.",
		);
		expect(
			capturedEvents.some(
				(e) => e.kind === "run.completed" || e.kind === "run.failed",
			),
		).toBe(false);
	});

	it("dispatch proceeds unchanged when the run row is still running at the gate", async () => {
		const dispatch = vi.fn(async () => ({
			childRunId: "tedi-cto:mcp:run-1_auto_tedi-cto",
			status: "queued" as const,
		}));
		const deps = stubDeps({
			db: sequencedSelectDbProxy([{ status: "running", metadata: {} }]),
			kernel: autoDelegateKernel(),
			dispatchAutoDelegation: dispatch,
		});
		const result = await runKernelTurnWork(deps, turnInput());

		expect(dispatch).toHaveBeenCalledTimes(1);
		expect(result.status).toBe("queued");
		expect(result.run.childRunId).toBe("tedi-cto:mcp:run-1_auto_tedi-cto");
	});

	it("creates and threads the auto-delegation Work Item before child dispatch", async () => {
		const createDelegationWorkItem = vi.fn(async () => "work-item-1");
		const predictAutoDelegationChildRunId = vi.fn(
			() => "tedi-cto:mcp:run-1_auto_tedi-cto",
		);
		const dispatch = vi.fn(async () => ({
			childRunId: "tedi-cto:mcp:run-1_auto_tedi-cto",
			status: "queued" as const,
		}));
		const deps = stubDeps({
			db: sequencedSelectDbProxy([{ status: "running", metadata: {} }]),
			kernel: autoDelegateKernel(),
			createDelegationWorkItem,
			predictAutoDelegationChildRunId,
			dispatchAutoDelegation: dispatch,
		});

		const content = `Delegate to CTO: review the request.\n${"Relevant detail. ".repeat(200)}\nAcceptance: retain the independent oracle.`;
		const result = await runKernelTurnWork(deps, { ...turnInput(), content });

		expect(predictAutoDelegationChildRunId).toHaveBeenCalledWith({
			homeRunId: "run-1",
			delegatedTediId: "tedi-cto",
		});
		expect(createDelegationWorkItem).toHaveBeenCalledWith(
			expect.objectContaining({
				childRunId: "tedi-cto:mcp:run-1_auto_tedi-cto",
				content,
			}),
		);
		expect(dispatch).toHaveBeenCalledWith(
			expect.objectContaining({ workItemId: "work-item-1", content }),
		);
		expect(createDelegationWorkItem.mock.invocationCallOrder[0]).toBeLessThan(
			dispatch.mock.invocationCallOrder[0],
		);
		expect(result.run.metadata).toMatchObject({ workItemId: "work-item-1" });
	});

	it("router-decided delegation WITHOUT explicit intent still mints and threads the supervised Work Item", async () => {
		const createDelegationWorkItem = vi.fn(async () => "work-item-1");
		const predictAutoDelegationChildRunId = vi.fn(
			() => "tedi-cto:mcp:run-1_auto_tedi-cto",
		);
		const dispatch = vi.fn(async () => ({
			childRunId: "tedi-cto:mcp:run-1_auto_tedi-cto",
			status: "queued" as const,
		}));
		const deps = stubDeps({
			db: sequencedSelectDbProxy([{ status: "running", metadata: {} }]),
			kernel: autoDelegateKernel({ explicitDelegationIntent: false }),
			createDelegationWorkItem,
			predictAutoDelegationChildRunId,
			dispatchAutoDelegation: dispatch,
		});

		const result = await runKernelTurnWork(deps, turnInput());

		expect(createDelegationWorkItem).toHaveBeenCalledTimes(1);
		expect(dispatch).toHaveBeenCalledTimes(1);
		expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
			workItemId: "work-item-1",
		});
		expect(result.status).toBe("queued");
		expect(result.run.metadata).toMatchObject({ workItemId: "work-item-1" });
	});

	it("fails closed instead of dispatching an unauthorizable supervised child", async () => {
		const dispatch = vi.fn();
		const deps = stubDeps({
			db: sequencedSelectDbProxy([{ status: "running", metadata: {} }]),
			kernel: autoDelegateKernel({ explicitDelegationIntent: false }),
			createDelegationWorkItem: undefined,
			predictAutoDelegationChildRunId: undefined,
			dispatchAutoDelegation: dispatch,
		});

		const result = await runKernelTurnWork(deps, turnInput());

		expect(dispatch).not.toHaveBeenCalled();
		expect(result.run.status).toBe("failed");
		expect(result.run.metadata).toMatchObject({
			homeAutoDispatch: {
				status: "failed",
				error:
					"supervised delegation requires Work Item minting and a deterministic child run id",
			},
		});
	});

	it("does not auto-dispatch when Work admission fails", async () => {
		const dispatch = vi.fn();
		const deps = stubDeps({
			db: sequencedSelectDbProxy([{ status: "running", metadata: {} }]),
			kernel: autoDelegateKernel(),
			createDelegationWorkItem: vi.fn(async () => {
				throw new Error("admission rejected");
			}),
			predictAutoDelegationChildRunId: () => "tedi-cto:mcp:run-1_auto_tedi-cto",
			dispatchAutoDelegation: dispatch,
		});

		const result = await runKernelTurnWork(deps, turnInput());

		expect(dispatch).not.toHaveBeenCalled();
		expect(result.run.status).toBe("failed");
	});

	it("a cancel that lands AFTER a successful dispatch settles with the stopping marker and persists the child link for reconcile", async () => {
		const updateSets: Array<Record<string, unknown>> = [];
		const capturedEvents: Array<{
			kind: string;
			payload: Record<string, unknown> | undefined;
		}> = [];
		const dispatch = vi.fn(async () => ({
			childRunId: "tedi-cto:mcp:run-1_auto_tedi-cto",
			childConversationId: "agent:main:delegation-x",
			status: "queued" as const,
		}));
		const stopCanceledAutoDelegation = vi.fn(async () => ({
			attempted: true,
			outcome: "succeeded" as const,
		}));
		const deps = stubDeps({
			// Gate 1 (pre-dispatch) sees `running`; gate 2 (pre-materialize) sees
			// `canceled` — the exact race where the spawn slipped through.
			db: sequencedSelectDbProxy(
				[
					{ status: "running", metadata: {} },
					{ status: "canceled", metadata: {} },
				],
				updateSets,
			),
			kernel: autoDelegateKernel(),
			dispatchAutoDelegation: dispatch,
			stopCanceledAutoDelegation,
			insertKernelRuntimeEvent: capturingPayloadInsert(capturedEvents),
		});
		const result = await runKernelTurnWork(deps, turnInput());

		expect(dispatch).toHaveBeenCalledTimes(1);
		expect(result.run.status).toBe("canceled");
		expect(result.assistantMessage.content).toBe(
			"Turn canceled — stopping the delegated run.",
		);
		// The parent↔child link is persisted onto the canceled row so the
		// run-set reconcile can stop the child on the next read.
		const linkSet = updateSets.find(
			(set) => set.childRunId === "tedi-cto:mcp:run-1_auto_tedi-cto",
		);
		expect(linkSet).toBeDefined();
		expect(linkSet?.delegatedTediId).toBe("tedi-cto");
		expect(
			(linkSet?.metadata as Record<string, unknown> | undefined)
				?.homeAutoDispatch,
		).toMatchObject({
			childRunId: "tedi-cto:mcp:run-1_auto_tedi-cto",
			canceledAfterDispatch: true,
		});
		expect(stopCanceledAutoDelegation).toHaveBeenCalledTimes(1);
		expect(stopCanceledAutoDelegation).toHaveBeenCalledWith({
			organizationId: "org-1",
			delegatedTediId: "tedi-cto",
			childRunId: "tedi-cto:mcp:run-1_auto_tedi-cto",
			childConversationId: "agent:main:delegation-x",
			reason: "Parent Home run canceled by operator",
		});
		const marker = capturedEvents.find((e) => e.kind === "message.completed");
		expect(marker?.payload?.content).toBe(
			"Turn canceled — stopping the delegated run.",
		);
	});

	it("cancel mid-plan (KernelDO.cancelTurn aborts the LLM pass): no dispatch, canceled marker, no provider-failure record", async () => {
		// Simulates KernelDO.cancelTurn firing while the route-planner LLM pass is
		// in flight: `deps.kernel` (runKernel → planKernelRoute) rejects with the
		// operator-abort classification (see route-planner.ts), exactly like the
		// real abortSignal-combined generateObject/streamObject call would. The
		// run row is ALREADY canceled by the time the turn body re-reads it —
		// cancelKernelRunCore durably marks the run canceled BEFORE it calls the
		// DO's cancelTurn RPC — so this exercises the EXACT production race.
		const capturedEvents: Array<{
			kind: string;
			payload: Record<string, unknown> | undefined;
		}> = [];
		const dispatch = vi.fn(async () => ({
			childRunId: "tedi-cto:mcp:run-1_auto_tedi-cto",
			status: "queued" as const,
		}));
		const deps = stubDeps({
			db: sequencedSelectDbProxy([{ status: "canceled", metadata: {} }]),
			kernel: async () => {
				throw new DOMException(
					"kernel turn run-1 canceled by operator",
					"AbortError",
				);
			},
			dispatchAutoDelegation: dispatch,
			insertKernelRuntimeEvent: capturingPayloadInsert(capturedEvents),
		});
		const result = await runKernelTurnWork(deps, turnInput());

		// No dispatch — the aborted planner never produced a delegation route.
		expect(dispatch).not.toHaveBeenCalled();
		// Settles as a clean cancel via the pre-materialize gate…
		expect(result.run.status).toBe("canceled");
		expect(result.assistantMessage.content).toBe(
			"Turn canceled — no work was dispatched.",
		);
		const marker = capturedEvents.find((e) => e.kind === "message.completed");
		expect(marker?.payload?.content).toBe(
			"Turn canceled — no work was dispatched.",
		);
		// …NEVER as a model-unavailable provider failure: no run.failed event, no
		// "Model unavailable" content, and the terminal `run.completed`/`run.failed`
		// pair the normal (non-canceled) settle path would emit is entirely absent
		// — the cancel core's own `run.canceled` event owns the terminal record.
		expect(
			capturedEvents.some(
				(e) => e.kind === "run.completed" || e.kind === "run.failed",
			),
		).toBe(false);
		expect(marker?.payload?.content).not.toContain("model");
		expect(marker?.payload?.content).not.toContain("unavailable");
	});
});

// ─── Per-stage first-token latency instrumentation ───────────────────────────

describe("runKernelTurnWork stage timings (metadata.kernelTurnTimings)", () => {
	/** Pull the timings snapshot off the captured terminal metadata patch. */
	function timingsOf(
		capturedRunMetadata: Array<Record<string, unknown>>,
	): KernelTurnStageTimingsSnapshot {
		expect(capturedRunMetadata).toHaveLength(1);
		const snap = capturedRunMetadata[0]
			?.kernelTurnTimings as KernelTurnStageTimingsSnapshot;
		expect(snap).toBeDefined();
		return snap;
	}

	/** Each present serial stage starts ≥ its present predecessors (offsets
	 * from workStarted, which is the 0 baseline by construction). */
	function expectSerialOrder(snap: KernelTurnStageTimingsSnapshot): void {
		let previous = 0;
		for (const stage of KERNEL_TURN_SERIAL_STAGE_ORDER) {
			if (stage === "workStarted") continue;
			const offset = snap.stages[stage];
			if (typeof offset !== "number") continue;
			expect(offset).toBeGreaterThanOrEqual(previous);
			previous = offset;
		}
	}

	/** Deterministic advancing clock so ordering assertions are strict, not
	 * same-millisecond ties. */
	function steppingTimings() {
		let t = 1_750_000_000_000;
		return createKernelTurnStageTimings({
			now: () => {
				t += 10;
				return t;
			},
		});
	}

	it("PROOF: a completed answer turn persists present, ordered stage timings with turn-type and isolate-age tags", async () => {
		const capturedRunMetadata: Array<Record<string, unknown>> = [];
		const deps = stubDeps({
			stageTimings: steppingTimings(),
			kernel: async (args) => {
				// The kernel's real emission order: post-context-assembly "thinking",
				// then streamed answer tokens.
				args.onProgress?.({ stage: "thinking" });
				args.onProgress?.({ stage: "Answering", answerDelta: "All " });
				args.onProgress?.({ stage: "Answering", answerDelta: "quiet." });
				return {
					route: route({ routeKind: "answer_in_home", answer: "All quiet." }),
					assistantContent: "All quiet.",
					evidence: null,
				};
			},
			db: capturingDbProxy(capturedRunMetadata),
		});
		await runKernelTurnWork(deps, turnInput());

		const snap = timingsOf(capturedRunMetadata);
		// Tags: turn type + isolate age.
		expect(snap.v).toBe(1);
		expect(snap.turnType).toBe("answer");
		expect(["cold", "warm"]).toContain(snap.isolate.tag);
		expect(snap.isolate.ageMs).toBeGreaterThanOrEqual(0);
		expect(snap.isolate.turnSequence).toBeGreaterThanOrEqual(1);
		// Present: the serial route-plan window plus the streaming marks.
		expect(snap.stages.routePlanStarted).toBeDefined();
		expect(snap.stages.plannerFirstProgress).toBeDefined();
		expect(snap.stages.firstAnswerDelta).toBeDefined();
		expect(snap.stages.routePlanEnded).toBeDefined();
		expect(snap.stages.writeProposalPlanStarted).toBeDefined();
		expect(snap.stages.writeProposalPlanEnded).toBeDefined();
		// Ordered: serial chain monotonic; streaming marks ordered within the
		// route-plan window.
		expectSerialOrder(snap);
		const {
			routePlanStarted,
			plannerFirstProgress,
			firstAnswerDelta,
			routePlanEnded,
		} = snap.stages;
		expect(plannerFirstProgress).toBeGreaterThanOrEqual(routePlanStarted ?? 0);
		expect(firstAnswerDelta).toBeGreaterThanOrEqual(plannerFirstProgress ?? 0);
		expect(routePlanEnded).toBeGreaterThanOrEqual(firstAnswerDelta ?? 0);
		// Tedix OS-side join anchors: the persist-first enqueue clock and the body's
		// wall-clock zero point.
		expect(snap.enqueuedAt).toBe("2026-06-11T00:00:00.000Z");
		expect(typeof snap.workStartedAt).toBe("string");
		expect(snap.enqueueToWorkMs).toBeGreaterThanOrEqual(0);
	});

	it("write-proposal turn: turnType=write_proposal and the proposal-plan window follows routePlanEnded", async () => {
		const capturedRunMetadata: Array<Record<string, unknown>> = [];
		const deps = stubDeps({
			stageTimings: steppingTimings(),
			kernel: async () => ({
				route: route({
					routeKind: "propose_tool_write",
					toolIntent: {
						appSlug: "globex",
						capability: "globex.invoices.create",
						connectionStatus: "connected",
					},
				}),
				assistantContent: "This would be a write.",
				evidence: null,
			}),
			writeProposalPlanner: async () => ({
				appSlug: "globex-tedix",
				toolName: "create_invoice",
				args: { amount: 100 },
				reasoning: "operator asked",
				riskTier: "low",
			}),
			db: capturingDbProxy(capturedRunMetadata),
		});
		await runKernelTurnWork(deps, turnInput());

		const snap = timingsOf(capturedRunMetadata);
		expect(snap.turnType).toBe("write_proposal");
		expectSerialOrder(snap);
		expect(snap.stages.writeProposalPlanStarted).toBeGreaterThanOrEqual(
			snap.stages.routePlanEnded ?? 0,
		);
		expect(snap.stages.writeProposalPlanEnded).toBeGreaterThanOrEqual(
			snap.stages.writeProposalPlanStarted ?? 0,
		);
	});

	it("delegated turn with auto-dispatch: turnType=delegated and the dispatch window is marked and ordered", async () => {
		const capturedRunMetadata: Array<Record<string, unknown>> = [];
		const deps = stubDeps({
			stageTimings: steppingTimings(),
			kernel: async () =>
				({
					route: route({
						routeKind: "delegate_tedi",
						targetTediId: "tedi-cto",
						targetTediLabel: "CTO",
					}),
					assistantContent: "On it — delegating to CTO now.",
					evidence: null,
					delegation: {
						workOrder: {
							kind: "tedi.delegate",
							objective: "Review the roadmap.",
							outputContract: "Top 3 priorities.",
							status: "draft",
							toolGuidance: [],
							boundaries: [],
							sourceContent: "Delegate to CTO: review the roadmap.",
							targetTediId: "tedi-cto",
							targetTediLabel: "CTO",
						},
						decision: { mode: "auto", canAutoDispatch: true, reason: "test" },
					},
				}) as unknown as Awaited<ReturnType<KernelTurnWorkDeps["kernel"]>>,
			dispatchAutoDelegation: async () => ({
				childRunId: "tedi-cto:mcp:run-1_auto_tedi-cto",
				status: "queued" as const,
			}),
			db: capturingDbProxy(capturedRunMetadata),
		});
		await runKernelTurnWork(deps, turnInput());

		const snap = timingsOf(capturedRunMetadata);
		expect(snap.turnType).toBe("delegated");
		expectSerialOrder(snap);
		expect(snap.stages.dispatchStarted).toBeGreaterThanOrEqual(
			snap.stages.writeProposalPlanEnded ?? 0,
		);
		expect(snap.stages.dispatchEnded).toBeGreaterThanOrEqual(
			snap.stages.dispatchStarted ?? 0,
		);
	});

	it("default collector: the seam is optional — a turn without an injected stageTimings dep still persists a snapshot", async () => {
		const capturedRunMetadata: Array<Record<string, unknown>> = [];
		const deps = stubDeps({
			kernel: async () => ({
				route: route({ routeKind: "answer_in_home", answer: "fine" }),
				assistantContent: "fine",
				evidence: null,
			}),
			db: capturingDbProxy(capturedRunMetadata),
		});
		await runKernelTurnWork(deps, turnInput());

		const snap = timingsOf(capturedRunMetadata);
		expect(snap.turnType).toBe("answer");
		expect(["cold", "warm"]).toContain(snap.isolate.tag);
		expectSerialOrder(snap);
	});

	it("model-unavailable turn still records the route-plan window (turnType falls back to answer)", async () => {
		const capturedRunMetadata: Array<Record<string, unknown>> = [];
		const deps = stubDeps({
			stageTimings: steppingTimings(),
			kernel: async () => null,
			db: capturingDbProxy(capturedRunMetadata),
		});
		await runKernelTurnWork(deps, turnInput());

		const snap = timingsOf(capturedRunMetadata);
		expect(snap.turnType).toBe("answer");
		expect(snap.stages.routePlanStarted).toBeDefined();
		expect(snap.stages.routePlanEnded).toBeDefined();
		expect(snap.stages.firstAnswerDelta).toBeUndefined();
	});
});

describe("readDelegationDepth (read side)", () => {
	it("reads a numeric delegationDepth from the first source", () => {
		expect(readDelegationDepth({ delegationDepth: 4 }, null)).toBe(4);
	});
	it("falls through to a later source when the first lacks it", () => {
		expect(readDelegationDepth({ foo: 1 }, { delegationDepth: 7 })).toBe(7);
	});
	it("returns 0 for absent/non-numeric/null (top-level Home turn)", () => {
		expect(readDelegationDepth(null, undefined)).toBe(0);
		expect(readDelegationDepth({ delegationDepth: "9" })).toBe(0);
		expect(readDelegationDepth({})).toBe(0);
	});
});

vi.mock("@tedix/db/queries/billing/provider-model-rates", () => ({
	findProviderModelRates: async () => [
		{
			id: "rate",
			inputMicrousdPerMillion: 1_000_000,
			outputMicrousdPerMillion: 1_000_000,
			cacheReadMicrousdPerMillion: 0,
			cacheWriteMicrousdPerMillion: 0,
		},
	],
}));
describe("turn cost persists failed operation observations", () => {
	it("retains a priced failed-parse subtotal when every route ultimately fails", async () => {
		const metadata: Record<string, unknown>[] = [];
		const identity = {
			provider: "workers-ai",
			requestModel: "@cf/test",
			gatewayAccountId: "account",
			gatewayId: "gateway",
			transportKind: "workers-ai-binding",
			apiKind: "workers-ai-chat",
			providerResource: null,
			providerOrigin: null,
			deployment: null,
		} as const;
		await runKernelTurnWork(
			stubDeps({
				db: capturingDbProxy(metadata),
				env: {
					TEDIX_FLEET_AUTHORITY_MODE: "co-located",
					DB: {},
				} as CloudflareEnv,
				kernel: async (args) => {
					args.onExecutionAttempts?.([
						{
							identity,
							executionId: "failed-parse",
							occurredAt: "2026-06-11T00:00:02.000Z",
							usage: {
								inputTokens: 100,
								outputTokens: 20,
								cacheReadTokens: 0,
								cacheWriteTokens: 0,
							},
						},
						{
							identity,
							executionId: "failed-network",
							occurredAt: "2026-06-11T00:00:03.000Z",
						},
					]);
					return null;
				},
			}),
			turnInput(),
		);
		const body = metadata.find((row) => row.bodyExecutionResult)
			?.bodyExecutionResult as BodyExecutionResult;
		expect(body.cost).toMatchObject({
			modelCostUsd: null,
			totalCostUsd: null,
			pricing: {
				knownSubtotalUsd: 0.00012,
				attemptCount: 2,
				pricedAttemptCount: 1,
				costCompleteness: "partial",
				reason: "missing_attempt_usage",
			},
		});
	});
});

describe("runKernelTurnWork agent-in-the-loop delegation review", () => {
	function heldDelegationKernel(
		approver: { tediId: string; label: string } | null,
	) {
		return async () =>
			({
				route: route({
					routeKind: "delegate_tedi",
					targetTediId: "tedi-cpo",
					targetTediLabel: "CPO",
					risk: "medium",
					targetActivityId: "activity-roadmap",
				}),
				assistantContent: approver
					? `I prepared a delegation to CPO. It is not dispatched yet: I routed the decision to ${approver.label}, and I'll ask you only if ${approver.label} declines or cannot decide.`
					: "I prepared a delegation to CPO. It is not dispatched yet; approve this Home run to dispatch the work order.",
				delegation: {
					workOrder: {
						kind: "tedi.delegate",
						objective: "Review the roadmap.",
						outputContract: "Return a short summary.",
						status: "draft",
						toolGuidance: [],
						boundaries: [],
						sourceContent: "Have CPO review the roadmap.",
						targetTediId: "tedi-cpo",
						targetTediLabel: "CPO",
						executionRequirement: {
							surface: "native",
							requiredCapabilities: [],
							fallbackSurface: null,
							prohibitedSurfaces: [],
							satisfiable: true,
							reason: "test",
						},
					},
					decision: {
						mode: "needs_approval",
						approvalRoute: "agent",
						canAutoDispatch: false,
						reason:
							"target lacks a matching production entrustment for this route risk, task family, tools, and constraints",
					},
					approver,
				},
			}) as unknown as Awaited<ReturnType<KernelTurnWorkDeps["kernel"]>>;
	}

	it("creates the held Work Item + proposal for the approver and wakes it after parking", async () => {
		const metadataPatches: Array<Record<string, unknown>> = [];
		const order: string[] = [];
		const requestDelegationAgentReview = vi.fn(async (input) => {
			order.push("request");
			return {
				status: "pending" as const,
				approverTediId: input.approverTediId,
				approverTediLabel: input.approverTediLabel,
				proposalId: "proposal-1",
				proposalVersion: 1,
				workItemId: "wi-held-1",
				requestedAt: input.requestedAt,
				expiresAt: input.expiresAt,
			};
		});
		const wakeDelegationAgentReview = vi.fn(async () => {
			order.push("wake");
		});
		const recorder = progressRecorder();
		const deps = stubDeps({
			db: capturingDbProxy(metadataPatches),
			kernel: heldDelegationKernel({ tediId: "tedi-cto", label: "CTO" }),
			requestDelegationAgentReview,
			wakeDelegationAgentReview,
			insertKernelRuntimeEvent: async (event) => {
				order.push(event.kind);
				return {
					id: `event:${event.kind}`,
					organizationId: event.organizationId,
					kind: event.kind,
					conversationId: event.conversationId,
					runId: event.runId,
					payload: event.payload,
					runtime: { backend: "custom" },
					createdAt: event.createdAt ?? "2026-06-11T00:00:01.000Z",
				} as KernelRuntimeEvent;
			},
			onProgress: recorder.onProgress,
		});

		const result = await runKernelTurnWork(deps, turnInput());

		expect(result.status).toBe("requires_approval");
		expect(requestDelegationAgentReview).toHaveBeenCalledWith(
			expect.objectContaining({
				organizationId: "org-1",
				homeRunId: "run-1",
				approverTediId: "tedi-cto",
				targetTediId: "tedi-cpo",
				holdReason: expect.stringContaining("entrustment"),
				route: expect.objectContaining({
					risk: "medium",
					targetActivityId: "activity-roadmap",
				}),
			}),
		);
		// 24h default approval TTL from the governance TTL resolver.
		const request = requestDelegationAgentReview.mock.calls[0]?.[0];
		expect(
			Date.parse(request.expiresAt) - Date.parse(request.requestedAt),
		).toBe(24 * 3_600_000);
		expect(wakeDelegationAgentReview).toHaveBeenCalledWith({
			organizationId: "org-1",
			proposalId: "proposal-1",
		});
		// Wake only after the run parked and approval.requested landed.
		expect(order.indexOf("wake")).toBeGreaterThan(
			order.indexOf("approval.requested"),
		);
		expect(recorder.stages).toContain("Awaiting CTO decision");
		const runPatch = metadataPatches.find((patch) => "homeDelegation" in patch);
		expect(runPatch?.homeDelegation).toMatchObject({
			agentReview: {
				status: "pending",
				approverTediId: "tedi-cto",
				proposalId: "proposal-1",
				workItemId: "wi-held-1",
			},
		});
		expect(result.assistantMessage.content).toContain(
			"routed the decision to CTO",
		);
	});

	it("falls back to the operator card when the review cannot be requested", async () => {
		const metadataPatches: Array<Record<string, unknown>> = [];
		const wakeDelegationAgentReview = vi.fn();
		const deps = stubDeps({
			db: capturingDbProxy(metadataPatches),
			kernel: heldDelegationKernel({ tediId: "tedi-cto", label: "CTO" }),
			requestDelegationAgentReview: async () => {
				throw new Error("Designated approver is not eligible");
			},
			wakeDelegationAgentReview,
		});

		const result = await runKernelTurnWork(deps, turnInput());

		expect(result.status).toBe("requires_approval");
		expect(wakeDelegationAgentReview).not.toHaveBeenCalled();
		const runPatch = metadataPatches.find((patch) => "homeDelegation" in patch);
		expect(runPatch?.homeDelegation).toMatchObject({
			agentReview: {
				status: "unavailable",
				approverTediId: "tedi-cto",
				reason: expect.stringContaining("not eligible"),
			},
		});
		expect(result.assistantMessage.content).toContain("approve this Home run");
		expect(result.assistantMessage.content).not.toContain(
			"routed the decision",
		);
	});

	it("does not engage an agent when no approver resolved", async () => {
		const requestDelegationAgentReview = vi.fn();
		const deps = stubDeps({
			kernel: heldDelegationKernel(null),
			requestDelegationAgentReview,
		});
		const result = await runKernelTurnWork(deps, turnInput());
		expect(result.status).toBe("requires_approval");
		expect(requestDelegationAgentReview).not.toHaveBeenCalled();
	});

	it("keeps the operator card when the run is already bound to a canonical Work Item", async () => {
		const metadataPatches: Array<Record<string, unknown>> = [];
		const requestDelegationAgentReview = vi.fn();
		const deps = stubDeps({
			db: capturingDbProxy(metadataPatches),
			kernel: heldDelegationKernel({ tediId: "tedi-cto", label: "CTO" }),
			requestDelegationAgentReview,
		});
		await runKernelTurnWork(deps, {
			...turnInput(),
			runtimeMetadata: { workItemId: "wi-canonical" },
		});
		expect(requestDelegationAgentReview).not.toHaveBeenCalled();
		const runPatch = metadataPatches.find((patch) => "homeDelegation" in patch);
		expect(runPatch?.homeDelegation).toMatchObject({
			agentReview: {
				status: "unavailable",
				reason: expect.stringContaining("wi-canonical"),
			},
		});
	});
});

describe("runKernelTurnWork settle critical path", () => {
	function answerKernel(): KernelTurnWorkDeps["kernel"] {
		return async () => ({
			route: route({ routeKind: "answer_in_home", answer: "All quiet." }),
			assistantContent: "All quiet.",
			evidence: null,
		});
	}
	function toEvent(event: HomeTurnRuntimeEventInput): KernelRuntimeEvent {
		return {
			id: `event:${event.kind}`,
			organizationId: event.organizationId,
			kind: event.kind,
			conversationId: event.conversationId,
			runId: event.runId,
			payload: event.payload,
			runtime: { backend: "custom" },
			createdAt: event.createdAt ?? "2026-06-11T00:00:01.000Z",
		} as KernelRuntimeEvent;
	}

	it("lands the run patch, message.completed and the receipt through the batched persist", async () => {
		const order: string[] = [];
		const persistTurnSettlement = vi.fn(
			async (
				input: Parameters<
					NonNullable<KernelTurnWorkDeps["persistTurnSettlement"]>
				>[0],
			) => {
				order.push("persist");
				return {
					assistantEvent: toEvent(input.events[0]),
					terminalEvent: toEvent(input.events[1]),
				};
			},
		);
		const deps = stubDeps({
			kernel: answerKernel(),
			persistTurnSettlement,
			insertKernelRuntimeEvent: async (event) => {
				order.push(`insert:${event.kind}`);
				return toEvent(event);
			},
			offsetIso: (baseIso, offsetMs) =>
				new Date(Date.parse(baseIso) + offsetMs).toISOString(),
		});
		const result = await runKernelTurnWork(deps, turnInput());
		expect(result.status).toBe("needs_delegation");
		expect(persistTurnSettlement).toHaveBeenCalledTimes(1);
		const call = persistTurnSettlement.mock.calls[0]?.[0];
		expect(call?.run.fromStatus).toBe("running");
		expect(call?.run.patch.status).toBe("completed");
		expect(call?.events.map((event) => event.kind)).toEqual([
			"message.completed",
			"run.completed",
		]);
		// The receipt stays strictly after message.completed in the offset stream.
		const [assistant, terminal] = call?.events ?? [];
		expect(String(terminal?.createdAt) > String(assistant?.createdAt)).toBe(
			true,
		);
		// The terminal transcript never goes through the one-row insert path.
		expect(order).toEqual(["persist"]);
		// The returned snapshot is built from the batched assistant row.
		expect(result.assistantMessage.createdAt).toBe(assistant?.createdAt);
		expect(result.assistantMessage.content).toBe("All quiet.");
	});

	it("hands the title work to holdAfterSettle and resolves before it completes", async () => {
		const held: Promise<void>[] = [];
		let titleCompleted = false;
		let releaseTitle: () => void = () => {};
		const deps = stubDeps({
			kernel: answerKernel(),
			holdAfterSettle: (work) => {
				held.push(work);
			},
			generateConversationTitle: () =>
				new Promise<void>((resolve) => {
					releaseTitle = () => {
						titleCompleted = true;
						resolve();
					};
				}),
		});
		const result = await runKernelTurnWork(deps, turnInput());
		expect(result.status).toBe("needs_delegation");
		expect(titleCompleted).toBe(false);
		expect(held).toHaveLength(1);
		releaseTitle();
		await held[0];
		expect(titleCompleted).toBe(true);
	});

	it("a held promise that rejects is caught before the holder sees it", async () => {
		const held: Promise<void>[] = [];
		const deps = stubDeps({
			kernel: answerKernel(),
			holdAfterSettle: (work) => {
				held.push(work);
			},
			generateConversationTitle: () =>
				Promise.reject(new Error("title exploded")),
		});
		const result = await runKernelTurnWork(deps, turnInput());
		expect(result.status).toBe("needs_delegation");
		expect(held).toHaveLength(1);
		await expect(held[0]).resolves.toBeUndefined();
	});
});
