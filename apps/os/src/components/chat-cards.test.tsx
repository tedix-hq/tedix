import type { RuntimeStreamEvent } from "@tedix/api-contract/schemas/runtime-submissions";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import {
	type ApprovalCardData,
	ApprovalCard,
	approvalsFromRunSet,
	type CardRunLinkProps,
	compactPreview,
	dedupeDelegations,
	DelegationProofChip,
	DelegationWorkCard,
	delegationFromRun,
	delegationProofFromRun,
	ExecutionLinkChip,
	mergeToolEvents,
	PREVIEW_MAX_LENGTH,
	pruneDepartedRunFrames,
	RunControls,
	RunLinkChip,
	sortToolStates,
	toolCallLabel,
	type ToolCallState,
	ToolCallCard,
} from "./chat-cards";

const RUN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CHILD_RUN_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TEDI_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ORG_ID = "33333333-3333-4333-8333-333333333333";
const TOOL_CALL_ID = "call-1";

/** Router-free stand-in for the TanStack Link so cards SSR in tests. */
function StubLink({
	to,
	params,
	search,
	className,
	children,
}: CardRunLinkProps) {
	const href = `${to.replace("$runId", params.runId)}${search?.branch ? `?branch=${encodeURIComponent(search.branch)}` : ""}`;
	return (
		<a data-testid="run-chip" href={href} className={className}>
			{children}
		</a>
	);
}

function frame(overrides: Partial<RuntimeStreamEvent>): RuntimeStreamEvent {
	return {
		id: `evt:${overrides.kind}:${TOOL_CALL_ID}`,
		kind: "tool.started",
		runId: RUN_ID,
		createdAt: "2026-08-13T10:00:00.000Z",
		...overrides,
	};
}

/** SSE-shaped tool frame: toolCallId lives ONLY in the payload (toFrame()). */
function toolFrame(
	kind: "tool.started" | "tool.completed" | "tool.failed",
	createdAt: string,
	payload: Record<string, unknown> = {},
): RuntimeStreamEvent {
	return frame({
		id: `evt:${kind}:${TOOL_CALL_ID}`,
		kind,
		createdAt,
		payload: {
			channel: "home",
			toolCallId: TOOL_CALL_ID,
			name: "list_skills",
			phase: kind.slice("tool.".length),
			...payload,
		},
	});
}

describe("mergeToolEvents", () => {
	it("folds started -> completed into one completed entry with duration", () => {
		const merged = mergeToolEvents([
			toolFrame("tool.started", "2026-08-13T10:00:00.000Z", {
				appSlug: "skills",
			}),
			toolFrame("tool.completed", "2026-08-13T10:00:02.500Z"),
		]);
		expect(merged.size).toBe(1);
		const state = merged.get(TOOL_CALL_ID);
		expect(state?.status).toBe("completed");
		expect(state?.name).toBe("list_skills");
		expect(state?.appSlug).toBe("skills");
		expect(state?.runId).toBe(RUN_ID);
		expect(state?.durationMs).toBe(2500);
	});

	it("folds started -> failed and keeps the error preview", () => {
		const merged = mergeToolEvents([
			toolFrame("tool.started", "2026-08-13T10:00:00.000Z"),
			toolFrame("tool.failed", "2026-08-13T10:00:01.000Z", {
				error: { message: "boom" },
			}),
		]);
		const state = merged.get(TOOL_CALL_ID);
		expect(state?.status).toBe("failed");
		expect(state?.errorPreview).toContain("boom");
		expect(state?.durationMs).toBe(1000);
	});

	it("never downgrades a terminal status on out-of-order started replay", () => {
		const merged = mergeToolEvents([
			toolFrame("tool.completed", "2026-08-13T10:00:02.000Z"),
			toolFrame("tool.started", "2026-08-13T10:00:00.000Z", {
				args: { limit: 5 },
			}),
		]);
		const state = merged.get(TOOL_CALL_ID);
		expect(state?.status).toBe("completed");
		expect(state?.startedAt).toBe("2026-08-13T10:00:00.000Z");
		expect(state?.argsPreview).toContain("limit");
		expect(state?.durationMs).toBe(2000);
	});

	it("is idempotent under frame re-delivery", () => {
		const started = toolFrame("tool.started", "2026-08-13T10:00:00.000Z");
		const completed = toolFrame("tool.completed", "2026-08-13T10:00:01.000Z");
		const merged = mergeToolEvents([started, completed, started, completed]);
		expect(merged.size).toBe(1);
		expect(merged.get(TOOL_CALL_ID)?.status).toBe("completed");
	});

	it("reads a top-level toolCallId (readRunEvents shape) and skips other kinds", () => {
		const merged = mergeToolEvents([
			frame({
				id: "evt:top-level",
				kind: "tool.started",
				toolCallId: "call-2",
				payload: { name: "get_skill", phase: "started" },
			}),
			frame({ id: "evt:msg", kind: "message.delta", delta: "hi" }),
			frame({ id: "evt:no-id", kind: "tool.started", payload: {} }),
		]);
		expect(merged.size).toBe(1);
		expect(merged.get("call-2")?.name).toBe("get_skill");
	});
});

describe("compactPreview", () => {
	it("collapses whitespace, JSON-encodes objects, and clamps with ellipsis", () => {
		expect(compactPreview("  a\n  b ")).toBe("a b");
		expect(compactPreview({ a: 1 })).toBe('{"a":1}');
		expect(compactPreview(null)).toBeNull();
		expect(compactPreview("")).toBeNull();
		const clamped = compactPreview("x".repeat(400));
		expect(clamped?.length).toBe(160);
		expect(clamped?.endsWith("…")).toBe(true);
	});
});

describe("RunLinkChip", () => {
	it("links to the run detail route through an injected component", () => {
		const html = renderToStaticMarkup(
			<RunLinkChip runId={RUN_ID} LinkComponent={StubLink} />,
		);
		expect(html).toContain(`href="/work/runs/${RUN_ID}"`);
		expect(html).toContain("Run details");
		expect(html).not.toContain(`run ${RUN_ID.slice(0, 8)}`);
	});

	it("keeps Home execution ids out of the skill-workflow route", () => {
		const html = renderToStaticMarkup(
			<ExecutionLinkChip runId={RUN_ID} LinkComponent={StubLink} />,
		);
		expect(html).toContain(`href="/work/executions/${RUN_ID}"`);
		expect(html).not.toContain("/work/runs/");
	});
});

describe("toolCallLabel", () => {
	it("turns protocol identifiers into human action labels", () => {
		expect(toolCallLabel("google_gmail.search_threads")).toBe(
			"Google gmail search threads",
		);
		expect(toolCallLabel(" ")).toBe("Tool action");
	});
});

describe("sortToolStates", () => {
	it("orders the live-card block chronologically by first activity", () => {
		const early: ToolCallState = {
			toolCallId: "call-early",
			name: "a",
			appSlug: null,
			status: "completed",
			runId: RUN_ID,
			argsPreview: null,
			resultPreview: null,
			errorPreview: null,
			startedAt: "2026-08-13T10:00:00.000Z",
			endedAt: "2026-08-13T10:00:01.000Z",
			durationMs: 1000,
		};
		const late = {
			...early,
			toolCallId: "call-late",
			startedAt: "2026-08-13T10:05:00.000Z",
		};
		const endedOnly = {
			...early,
			toolCallId: "call-ended-only",
			startedAt: null,
			endedAt: "2026-08-13T10:02:00.000Z",
		};
		const sorted = sortToolStates([late, endedOnly, early]);
		expect(sorted.map((state) => state.toolCallId)).toEqual([
			"call-early",
			"call-ended-only",
			"call-late",
		]);
	});
});

describe("pruneDepartedRunFrames", () => {
	const frameFor = (id: string, runId: string): RuntimeStreamEvent => ({
		id,
		kind: "tool.started",
		runId,
		createdAt: "2026-08-13T10:00:00.000Z",
	});

	it("drops frames of runs that left the active set", () => {
		const frames = new Map([
			["evt-1", frameFor("evt-1", RUN_ID)],
			["evt-2", frameFor("evt-2", "run-other")],
		]);
		const seen = new Set<string>();
		// First pass: both runs active — nothing pruned.
		expect(pruneDepartedRunFrames(frames, seen, [RUN_ID, "run-other"])).toBe(
			false,
		);
		expect(frames.size).toBe(2);
		// RUN_ID completes (leaves the active set) — its frames go.
		expect(pruneDepartedRunFrames(frames, seen, ["run-other"])).toBe(true);
		expect(frames.has("evt-1")).toBe(false);
		expect(frames.has("evt-2")).toBe(true);
	});

	it("never prunes a run that was not yet observed active", () => {
		const frames = new Map([["evt-1", frameFor("evt-1", RUN_ID)]]);
		const seen = new Set<string>();
		// The run streams frames before the run set ever lists it as active.
		expect(pruneDepartedRunFrames(frames, seen, [])).toBe(false);
		expect(frames.size).toBe(1);
	});
});

function toolState(overrides: Partial<ToolCallState> = {}): ToolCallState {
	return {
		toolCallId: TOOL_CALL_ID,
		name: "list_skills",
		appSlug: "skills",
		status: "running",
		runId: RUN_ID,
		argsPreview: null,
		resultPreview: null,
		errorPreview: null,
		startedAt: "2026-08-13T10:00:00.000Z",
		endedAt: null,
		durationMs: null,
		...overrides,
	};
}

describe("ToolCallCard", () => {
	it("renders a running call with a spinner and no duration", () => {
		const html = renderToStaticMarkup(<ToolCallCard tool={toolState()} />);
		expect(html).toContain('data-tool-status="running"');
		// The running affordance is the shared Kumo `Loader` (an SVG carrying
		// `role="status"`), not a hand-rolled `animate-spin` icon.
		expect(html).toContain('role="status"');
		expect(html).toContain('aria-label="Tool call running"');
		expect(html).not.toContain("animate-spin");
		expect(html).toContain("list_skills");
		expect(html).toContain("skills");
		expect(html).not.toContain("ms<");
		expect(html).toContain("max-w-full");
		expect(html).not.toContain("border-kumo-hairline bg-kumo-base");
	});

	it("renders a completed call with duration and result preview", () => {
		const html = renderToStaticMarkup(
			<ToolCallCard
				tool={toolState({
					status: "completed",
					durationMs: 2500,
					resultPreview: '{"count":3}',
				})}
			/>,
		);
		expect(html).toContain('data-tool-status="completed"');
		expect(html).toContain("2.5s");
		expect(html).toContain("count");
		expect(html).not.toContain('aria-label="Tool call running"');
		expect(html).not.toContain("animate-spin");
	});

	it("renders a failed call with the error (or a fallback line)", () => {
		const withError = renderToStaticMarkup(
			<ToolCallCard
				tool={toolState({ status: "failed", errorPreview: "boom" })}
			/>,
		);
		expect(withError).toContain('data-tool-status="failed"');
		expect(withError).toContain("boom");
		const withoutError = renderToStaticMarkup(
			<ToolCallCard tool={toolState({ status: "failed" })} />,
		);
		expect(withoutError).toContain("The tool call failed.");
	});
});

describe("delegationFromRun / DelegationWorkCard", () => {
	const run = {
		id: RUN_ID,
		organizationId: ORG_ID,
		conversationId: "home:main",
		status: "running",
		delegatedTediId: TEDI_ID,
		childRunId: CHILD_RUN_ID,
		createdAt: "2026-08-13T10:00:00.000Z",
		progress: { current: 40, total: 100, label: "synthesizing…" },
	} as const;

	it("projects a delegated run and returns null for plain kernel turns", () => {
		const work = delegationFromRun(run);
		expect(work?.childRunId).toBe(CHILD_RUN_ID);
		expect(work?.activityLabel).toBe("synthesizing…");
		expect(
			delegationFromRun({
				...run,
				delegatedTediId: null,
				childRunId: null,
			}),
		).toBeNull();
	});

	it("renders the tedi name, status chip, and child-run link", () => {
		const work = delegationFromRun(run);
		if (!work) throw new Error("expected delegation work");
		const html = renderToStaticMarkup(
			<DelegationWorkCard
				work={work}
				tediName="CTO"
				LinkComponent={StubLink}
			/>,
		);
		expect(html).toContain('data-run-status="running"');
		expect(html).toContain("CTO");
		expect(html).toContain(
			`href="/work/executions/${RUN_ID}?branch=${CHILD_RUN_ID}"`,
		);
		expect(html).toContain("synthesizing…");
		expect(html).toContain('role="status"');
		expect(html).toContain('aria-label="Delegated work running"');
		expect(html).not.toContain("animate-spin");
		expect(html).toContain("max-w-full");
		expect(html).not.toContain("border-kumo-hairline bg-kumo-base");
	});

	it.each([undefined, null, "", "   ", "\u202e"])(
		"uses a friendly fallback for an unavailable name (%j)",
		(tediName) => {
			const work = delegationFromRun({ ...run, childRunId: null });
			if (!work) throw new Error("expected delegation work");
			const html = renderToStaticMarkup(
				<DelegationWorkCard
					work={work}
					tediName={tediName}
					LinkComponent={StubLink}
				/>,
			);
			expect(html).toContain("a digital worker");
			expect(html).not.toContain(TEDI_ID.slice(0, 8));
			expect(html).toContain(`href="/work/executions/${RUN_ID}"`);
		},
	);
});

describe("dedupeDelegations", () => {
	const baseRun = {
		id: RUN_ID,
		organizationId: ORG_ID,
		conversationId: "home:main",
		status: "running",
		delegatedTediId: TEDI_ID,
		childRunId: CHILD_RUN_ID,
		createdAt: "2026-08-13T10:00:00.000Z",
	} as const;

	it("renders one card per delegated child run, not one per parent row", () => {
		const works = dedupeDelegations([
			baseRun,
			{ ...baseRun, id: "parent-2", createdAt: "2026-08-13T10:01:00.000Z" },
			{ ...baseRun, id: "parent-3", createdAt: "2026-08-13T10:02:00.000Z" },
		]);
		expect(works).toHaveLength(1);
		expect(works[0]?.childRunId).toBe(CHILD_RUN_ID);
		// Newest row wins among equals.
		expect(works[0]?.runId).toBe("parent-3");
	});

	it("prefers a terminal status over an active one regardless of order", () => {
		const works = dedupeDelegations([
			{
				...baseRun,
				id: "parent-done",
				status: "completed",
				createdAt: "2026-08-13T10:00:00.000Z",
			},
			{
				...baseRun,
				id: "parent-stale-active",
				status: "running",
				createdAt: "2026-08-13T10:05:00.000Z",
			},
		]);
		expect(works).toHaveLength(1);
		expect(works[0]?.status).toBe("completed");
	});

	it("keys undelegated-child rows by their own run id and skips plain turns", () => {
		const works = dedupeDelegations([
			{ ...baseRun, childRunId: null },
			{
				...baseRun,
				id: "parent-b",
				childRunId: null,
				createdAt: "2026-08-13T10:01:00.000Z",
			},
			{ ...baseRun, id: "plain", delegatedTediId: null, childRunId: null },
		]);
		expect(works).toHaveLength(2);
		expect(works.map((work) => work.runId).sort()).toEqual([
			RUN_ID,
			"parent-b",
		]);
	});
});

function approval(overrides: Partial<ApprovalCardData> = {}): ApprovalCardData {
	return {
		approvalId: "appr-1",
		runId: RUN_ID,
		summary: "Approve write: record_skill (skills)",
		status: "pending",
		...overrides,
	};
}

describe("ApprovalCard", () => {
	it("renders Approve/Reject for an actionable pending approval", () => {
		const html = renderToStaticMarkup(<ApprovalCard approval={approval()} />);
		expect(html).toContain('data-approval-status="pending"');
		expect(html).toContain("type-tedix-body");
		expect(html).toContain("Approve");
		expect(html).toContain("Reject");
		expect(html).not.toContain('disabled=""');
	});

	it("disables both buttons while a resolution is in flight", () => {
		const html = renderToStaticMarkup(
			<ApprovalCard approval={approval()} resolving />,
		);
		const disabledCount = html.split('disabled=""').length - 1;
		expect(disabledCount).toBe(2);
	});

	it("stays visibly pending — never flipped locally — until the kernel confirms", () => {
		// Resolving releases a parked write proposal and the downstream tool then
		// RUNS; tediApprovals.resolve refuses a second attempt, so there is no
		// rollback that could undo an optimistic flip. The card therefore keeps
		// its pending status and announces the wait instead.
		const html = renderToStaticMarkup(
			<ApprovalCard approval={approval()} resolving />,
		);
		expect(html).toContain('aria-busy="true"');
		expect(html).toContain('data-pending="true"');
		expect(html).toContain('data-approval-status="pending"');
		expect(html).toContain('data-slot="approval-pending"');
		expect(html).toContain("Waiting for the kernel to confirm");
		expect(html).not.toContain('data-approval-status="approved"');
	});

	it("carries no busy state when no decision is in flight", () => {
		const html = renderToStaticMarkup(<ApprovalCard approval={approval()} />);
		expect(html).not.toContain("aria-busy");
		expect(html).not.toContain('data-slot="approval-pending"');
	});

	it("renders expired approvals without buttons per the safety default", () => {
		const html = renderToStaticMarkup(
			<ApprovalCard approval={approval({ expired: true })} />,
		);
		expect(html).toContain('data-approval-status="expired"');
		expect(html).toContain("Expired — denied by default per safety policy.");
		expect(html).not.toContain(">Approve<");
		expect(html).not.toContain(">Reject<");
	});

	it("renders no_action approvals informationally, without buttons", () => {
		const html = renderToStaticMarkup(
			<ApprovalCard approval={approval({ decisionMode: "no_action" })} />,
		);
		expect(html).toContain("resolves through its own surface");
		expect(html).not.toContain(">Approve<");
	});

	it("marks escalated approvals", () => {
		const html = renderToStaticMarkup(
			<ApprovalCard approval={approval({ status: "escalated" })} />,
		);
		expect(html).toContain("escalated");
	});

	it("offers session allowance only for a scoped delegation", () => {
		const scoped = renderToStaticMarkup(
			<ApprovalCard
				approval={approval({ sessionScopeKey: `delegate:${TEDI_ID}` })}
			/>,
		);
		const unscoped = renderToStaticMarkup(
			<ApprovalCard approval={approval()} />,
		);
		expect(scoped).toContain("Always allow this session");
		expect(unscoped).not.toContain("Always allow this session");
	});

	it("keeps copy readable and wraps actions below it in a narrow chat pane", () => {
		const html = renderToStaticMarkup(
			<ApprovalCard
				approval={approval({
					summary: "Approve delegation to globex-operator",
					detail:
						"A long approval reason must remain readable in a resizable workspace pane.",
					sessionScopeKey: "delegate:globex-operator",
				})}
			/>,
		);
		expect(html).toContain("grid-cols-[auto_minmax(0,1fr)]");
		expect(html).toContain("col-span-2");
		expect(html).toContain("flex-wrap");
		expect(html).toContain("break-words");
		expect(html).not.toContain("max-w-[85%]");
		expect(html).not.toContain("break-all");
	});
});

describe("approval builders", () => {
	it("joins approval mirrors to their parent requires_approval run", () => {
		const cards = approvalsFromRunSet(
			{
				runs: [
					{
						id: RUN_ID,
						organizationId: ORG_ID,
						conversationId: "home:main",
						status: "requires_approval",
						childRunId: CHILD_RUN_ID,
						createdAt: "2026-08-13T10:00:00.000Z",
					},
				],
				approvalMirrors: {
					"appr-2": {
						id: "mirror-1",
						parentConversationId: "home:main",
						childRunId: CHILD_RUN_ID,
						approvalRequestId: "appr-2",
						delegatedTediId: TEDI_ID,
						status: "escalated",
						blockedAt: "2026-08-13T10:00:00.000Z",
						escalateAt: 1,
					},
				},
			},
			{ [TEDI_ID]: "CTO" },
		);
		expect(cards).toHaveLength(1);
		expect(cards[0]?.runId).toBe(RUN_ID);
		expect(cards[0]?.approvalId).toBe("appr-2");
		expect(cards[0]?.tediName).toBe("CTO");
		expect(cards[0]?.status).toBe("escalated");
	});

	it("projects a run-scoped delegation recommendation into an actionable card", () => {
		const cards = approvalsFromRunSet({
			runs: [
				{
					id: RUN_ID,
					organizationId: ORG_ID,
					conversationId: "home:main",
					status: "requires_approval",
					createdAt: "2026-08-13T10:00:00.000Z",
					updatedAt: "2026-08-13T10:00:01.000Z",
					metadata: {
						homeDelegation: {
							workOrder: {
								targetTediId: TEDI_ID,
								targetTediLabel: "Acme",
							},
							decision: {
								mode: "needs_approval",
								reason: "target not active",
							},
						},
					},
				},
			],
			approvalMirrors: {},
		});

		expect(cards).toEqual([
			expect.objectContaining({
				approvalId: `home-delegation:${RUN_ID}`,
				runId: RUN_ID,
				summary: "Approve delegation to Acme",
				detail: "target not active",
				status: "pending",
			}),
		]);
	});

	it.each(["completed", "failed", "canceled"] as const)(
		"retains %s delegation proposals without actions",
		(status) => {
			const base = {
				id: RUN_ID,
				organizationId: ORG_ID,
				conversationId: "home:main",
				createdAt: "2026-08-13T10:00:00.000Z",
				metadata: {
					homeDelegation: {
						workOrder: { targetTediLabel: "Acme" },
						decision: { mode: "needs_approval", reason: "policy" },
						resolutionStatus: "approved",
					},
				},
			};
			expect(
				approvalsFromRunSet({
					runs: [{ ...base, status: "requires_approval" }],
					approvalMirrors: {},
				}),
			).toEqual([]);
			expect(
				approvalsFromRunSet({
					runs: [
						{
							...base,
							status,
							metadata: {
								homeDelegation: {
									...base.metadata.homeDelegation,
									resolutionStatus: null,
								},
							},
						},
					],
					approvalMirrors: {},
				}),
			).toEqual([
				expect.objectContaining({
					approvalId: `home-delegation:${RUN_ID}`,
					decisionMode: "no_action",
					noActionNote: expect.stringContaining("retained as history"),
				}),
			]);
			const run = {
				...base,
				status,
				metadata: {
					homeDelegation: {
						...base.metadata.homeDelegation,
						resolutionStatus: null,
					},
				},
			};
			const original = structuredClone(run);
			const [card] = approvalsFromRunSet({ runs: [run], approvalMirrors: {} });
			expect(card?.sessionScopeKey).toBeUndefined();
			const html = renderToStaticMarkup(
				<ApprovalCard
					approval={card!}
					onResolve={() => {}}
					onAlwaysApprove={() => {}}
				/>,
			);
			expect(html).toContain(`Delegation proposal from ${status} run`);
			expect(html).not.toContain("<button");
			expect(run).toEqual(original);
		},
	);

	it("does not project a delegation after a child exists or resolution settles", () => {
		const delegation = {
			workOrder: { targetTediId: TEDI_ID, status: "draft" },
			decision: { mode: "needs_approval", reason: "policy" },
		};
		const base = {
			id: RUN_ID,
			organizationId: ORG_ID,
			conversationId: "home:main",
			status: "completed" as const,
			createdAt: "2026-08-13T10:00:00.000Z",
		};
		expect(
			approvalsFromRunSet({
				runs: [
					{
						...base,
						childRunId: CHILD_RUN_ID,
						metadata: { homeDelegation: delegation },
					},
				],
				approvalMirrors: {},
			}),
		).toEqual([]);
		expect(
			approvalsFromRunSet({
				runs: [
					{
						...base,
						metadata: {
							homeDelegation: { ...delegation, resolutionStatus: "rejected" },
						},
					},
				],
				approvalMirrors: {},
			}),
		).toEqual([]);
	});

	describe("agent-reviewed delegation holds", () => {
		const NOW = Date.parse("2026-09-26T12:00:00.000Z");
		function heldRun(agentReview: Record<string, unknown>) {
			return {
				runs: [
					{
						id: RUN_ID,
						organizationId: ORG_ID,
						conversationId: "home:main",
						status: "requires_approval" as const,
						createdAt: "2026-09-26T11:00:00.000Z",
						updatedAt: "2026-09-26T11:00:01.000Z",
						metadata: {
							homeDelegation: {
								workOrder: { targetTediId: TEDI_ID, targetTediLabel: "Acme" },
								decision: {
									mode: "needs_approval",
									approvalRoute: "agent",
									reason: "route classified as high risk",
								},
								agentReview: {
									approverTediId: "tedi-cto",
									approverTediLabel: "CTO",
									proposalId: "proposal-1",
									...agentReview,
								},
							},
						},
					},
				],
				approvalMirrors: {},
			};
		}

		it("shows a no-action awaiting card while the approver decides", () => {
			const cards = approvalsFromRunSet(
				heldRun({
					status: "pending",
					expiresAt: "2026-09-27T12:00:00.000Z",
				}),
				{},
				NOW,
			);
			expect(cards).toEqual([
				expect.objectContaining({
					approvalId: `home-delegation:${RUN_ID}`,
					summary: "Awaiting CTO decision",
					decisionMode: "no_action",
					detail: "route classified as high risk",
				}),
			]);
			// Never session-auto-approvable while the agent decides.
			expect(cards[0]?.sessionScopeKey).toBeUndefined();
			const html = renderToStaticMarkup(<ApprovalCard approval={cards[0]!} />);
			expect(html).not.toContain(">Approve<");
			expect(html).toContain("CTO decides through the Work approval plane");
		});

		it.each([
			[
				"expired",
				{ status: "pending", expiresAt: "2026-09-26T11:30:00.000Z" },
				"CTO did not decide before the review expired",
			],
			[
				"rejected",
				{ status: "rejected", rationale: "Roadmap frozen" },
				"CTO declined: Roadmap frozen",
			],
			[
				"unavailable",
				{ status: "unavailable", reason: "missing native tools" },
				"CTO could not review: missing native tools",
			],
		])(
			"returns the operator buttons once the review is %s",
			(_l, review, outcome) => {
				const cards = approvalsFromRunSet(heldRun(review), {}, NOW);
				expect(cards).toEqual([
					expect.objectContaining({
						summary: "Approve delegation to Acme",
						detail: `${outcome} · route classified as high risk`,
						sessionScopeKey: `delegate:${TEDI_ID}`,
					}),
				]);
				expect(cards[0]?.decisionMode).toBeUndefined();
				const html = renderToStaticMarkup(
					<ApprovalCard approval={cards[0]!} />,
				);
				expect(html).toContain("Approve");
				expect(html).toContain("Reject");
			},
		);

		it("projects nothing once the approver approved", () => {
			expect(
				approvalsFromRunSet(heldRun({ status: "approved" }), {}, NOW),
			).toEqual([]);
		});
	});
});

describe("RunControls", () => {
	it("renders a destructive Stop for an active run", () => {
		const html = renderToStaticMarkup(
			<RunControls status="running" onStop={() => {}} />,
		);
		expect(html).toContain('data-run-status="running"');
		expect(html).toContain("Stop");
		expect(html).not.toContain("Retry");
	});

	it("renders Stop while a run is parked on approval", () => {
		const html = renderToStaticMarkup(
			<RunControls status="requires_approval" />,
		);
		expect(html).toContain("Stop");
	});

	it("renders Retry only for failed delegated runs", () => {
		const delegated = renderToStaticMarkup(
			<RunControls status="failed" delegated />,
		);
		expect(delegated).toContain("Retry");
		expect(delegated).not.toContain("Stop");
		const kernelOnly = renderToStaticMarkup(<RunControls status="failed" />);
		expect(kernelOnly).toBe("");
	});

	it("renders nothing for terminal completed/canceled runs", () => {
		expect(renderToStaticMarkup(<RunControls status="completed" />)).toBe("");
		expect(renderToStaticMarkup(<RunControls status="canceled" />)).toBe("");
	});

	it("disables both controls while a mutation is pending (never optimistic)", () => {
		const stop = renderToStaticMarkup(<RunControls status="running" pending />);
		expect(stop).toContain('disabled=""');
		const retry = renderToStaticMarkup(
			<RunControls status="failed" delegated pending />,
		);
		expect(retry).toContain('disabled=""');
	});

	it("exposes the in-flight dispatch to assistive tech, status unchanged", () => {
		// Cancel is terminal and Retry opens a new execution epoch that spends;
		// neither may render its effect before the server confirms, so the run
		// status stays put and only the busy marker moves.
		const html = renderToStaticMarkup(<RunControls status="running" pending />);
		expect(html).toContain('aria-busy="true"');
		expect(html).toContain('data-pending="true"');
		expect(html).toContain('data-run-status="running"');
	});
});

// ---------------------------------------------------------------------------
// Untrusted text (MCP-server / tool authored)
// ---------------------------------------------------------------------------

/** RIGHT-TO-LEFT OVERRIDE — reorders everything after it on screen. */
const RLO = "\u202E";
/** RIGHT-TO-LEFT ISOLATE / POP DIRECTIONAL ISOLATE. */
const RLI = "\u2067";
const PDI = "\u2069";

describe("untrusted text is sanitized at every card render site", () => {
	it("strips a bidi override from a tool name, app slug, and previews", () => {
		const html = renderToStaticMarkup(
			<ToolCallCard
				tool={toolState({
					name: `record${RLO}yreve_etirw`,
					appSlug: `sk${RLI}ills${PDI}`,
					status: "failed",
					argsPreview: `args${RLO}reversed`,
					errorPreview: `boom${RLO}reversed`,
				})}
			/>,
		);
		for (const control of [RLO, RLI, PDI]) {
			expect(html).not.toContain(control);
		}
		expect(html).toContain("recordyreve_etirw");
		expect(html).toContain("skills");
		expect(html).toContain("argsreversed");
		expect(html).toContain("boomreversed");
	});

	it("never DECODES an encoded control on the plain-text path", () => {
		// The markdown path had to grow a post-parse strip because its parser
		// decodes `&#x202E;`. This path has no parser: React renders the entity
		// as the literal characters an operator can see, so the control cannot
		// materialize. Asserted rather than assumed — the same decode-then-render
		// gap would be silent here too.
		const html = renderToStaticMarkup(
			<ToolCallCard tool={toolState({ name: "report&#x202E;txt.exe" })} />,
		);
		expect(html).not.toContain(RLO);
		expect(html).toContain("report&amp;#x202E;txt.exe");
	});

	it("renders markdown emphasis in a tool name as literal characters", () => {
		const html = renderToStaticMarkup(
			<ToolCallCard tool={toolState({ name: "**delete_everything**" })} />,
		);
		expect(html).toContain("**delete_everything**");
		expect(html).not.toContain("<strong>delete_everything</strong>");
		expect(html).not.toContain("<em>");
	});

	it("renders a forged approval line as literal text, never as the transcript's own voice", () => {
		// Cloudflare issue #42: a hostile server writing
		// "**Approved by your administrator.**" into an approval description.
		const html = renderToStaticMarkup(
			<ApprovalCard
				approval={approval({
					summary: `**Approved by your administrator.**${RLO}`,
					detail: "<b>Approved</b> — no action needed",
					tediName: `cto${RLO}`,
				})}
			/>,
		);
		expect(html).not.toContain(RLO);
		// Literal, not rendered: the asterisks and the escaped tag both survive.
		expect(html).toContain("**Approved by your administrator.**");
		expect(html).toContain("&lt;b&gt;Approved&lt;/b&gt;");
		expect(html).not.toContain("<b>Approved</b>");
		// The card still says what it actually is.
		expect(html).toContain('data-approval-status="pending"');
	});

	it("strips a bidi override from a delegation label built by the server", () => {
		const html = renderToStaticMarkup(
			<DelegationWorkCard
				work={{
					runId: RUN_ID,
					childRunId: CHILD_RUN_ID,
					delegatedTediId: TEDI_ID,
					status: "running",
					activityLabel: `synthesizing${RLO}gnihtemos esle`,
				}}
				tediName={`CT${RLO}O`}
				LinkComponent={StubLink}
			/>,
		);
		expect(html).not.toContain(RLO);
		expect(html).toContain("synthesizinggnihtemos esle");
		expect(html).toContain("CTO");
	});

	it("sanitizes a preview BEFORE it is clamped, so the control cannot hide in the budget", () => {
		const preview = compactPreview(`${RLO}${"a".repeat(200)}`);
		expect(preview).not.toContain(RLO);
		expect(preview?.length).toBe(PREVIEW_MAX_LENGTH);
	});
});

describe("delegationProof (metadata.delegationProof)", () => {
	const run = {
		id: RUN_ID,
		organizationId: ORG_ID,
		conversationId: "home:main",
		status: "completed",
		delegatedTediId: TEDI_ID,
		childRunId: CHILD_RUN_ID,
		createdAt: "2026-08-13T10:00:00.000Z",
	} as const;

	it("reads the verdict and note off run metadata, and nothing off prose", () => {
		expect(
			delegationProofFromRun({
				...run,
				metadata: {
					delegationProof: { verdict: "verified", note: " Output matched. " },
				},
			}),
		).toEqual({ verdict: "verified", note: "Output matched." });
		expect(
			delegationProofFromRun({
				...run,
				metadata: { delegationProof: { verdict: "partial" } },
			}),
		).toEqual({ verdict: "partial", note: null });
		expect(delegationProofFromRun(run)).toBeNull();
		expect(
			delegationProofFromRun({
				...run,
				metadata: { delegationProof: { note: "no verdict" } },
			}),
		).toBeNull();
	});

	it("renders the proof as a chip on the delegation card, never as prose", () => {
		const work = delegationFromRun({
			...run,
			metadata: {
				delegationProof: { verdict: "verified", note: "Checked the diff" },
			},
		});
		if (!work) throw new Error("expected delegation work");
		const html = renderToStaticMarkup(
			<DelegationWorkCard
				work={work}
				tediName="CTO"
				LinkComponent={StubLink}
			/>,
		);
		expect(html).toContain('data-slot="delegation-proof"');
		expect(html).toContain('data-verdict="verified"');
		expect(html).toContain("Proof: Verified");
		// The note is a hover affordance on the chip, not body copy.
		expect(html).toContain('title="Checked the diff"');
		expect(html).not.toContain(">Checked the diff<");
	});

	it("maps verdicts onto the status palette with a neutral fallback", () => {
		const chip = (verdict: string) =>
			renderToStaticMarkup(
				<DelegationProofChip proof={{ verdict, note: null }} />,
			);
		expect(chip("verified")).toContain('data-verdict="verified"');
		expect(chip("failed")).toContain("Proof: Failed");
		expect(chip("bespoke")).toContain("Proof: Bespoke");
	});
});
