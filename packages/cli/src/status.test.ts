import { describe, expect, test } from "bun:test";
import { TediRunStatusSchema } from "@tedix/api-contract/schemas/cognitive-runtime";
import {
	buildStatusReport,
	renderStatusReport,
	TERMINAL_STATUSES,
} from "./status";

// A representative read_home_run_set payload mixing in-flight, approval-blocked,
// settled, and delegated runs. Each run row carries the real run-set fields:
// id, status, progress.label/detail, metadata.kernelRoute, delegatedTediId,
// childRunId, metadata.childRunPreview.
function sampleRunSet() {
	return {
		runSet: {
			conversationId: "conv-1",
			runs: [
				{
					id: "r-run",
					status: "running",
					progress: { label: "Thinking", detail: "looking things up" },
					metadata: {
						kernelRoute: { routeKind: "delegate_tedi", targetTediLabel: "CTO" },
					},
				},
				{
					id: "r-appr",
					status: "requires_approval",
					progress: { label: "Approve the write?" },
					metadata: {
						kernelRoute: {
							routeKind: "propose_tool_write",
							answer: "Draft ready",
						},
					},
				},
				{
					id: "r-done",
					status: "completed",
					metadata: { kernelRoute: { routeKind: "answer", answer: "All set" } },
				},
				{
					id: "r-deleg-appr",
					status: "completed",
					metadata: {
						kernelRoute: {
							routeKind: "delegate_tedi",
							targetTediId: "tedi-cfo",
							targetTediLabel: "CFO",
						},
						homeDelegation: {
							workOrder: {
								status: "draft",
								objective: "Check the Stripe catalog",
							},
							decision: {
								mode: "needs_approval",
								reason: "target not active",
							},
						},
					},
				},
				{
					id: "r-deleg",
					status: "running",
					delegatedTediId: "tedi-cto",
					childRunId: "child-9",
					metadata: {
						kernelRoute: { routeKind: "delegate_tedi", targetTediLabel: "CTO" },
						childRunPreview: "Working on it",
					},
				},
			],
			activeRunIds: ["r-run", "r-appr", "r-deleg"],
		},
	};
}

// A read_child_run_tree payload: a kernel root node with two delegated child
// tedis. Node fields mirror printChildTreePayload: label, status, homeRunId,
// delegatedTediId, childRunId, children.
function sampleChildTree() {
	return {
		tree: {
			conversationId: "conv-1",
			nodes: [
				{
					homeRunId: "r-deleg",
					label: "Kernel",
					children: [
						{
							label: "CTO",
							delegatedTediId: "tedi-cto",
							childRunId: "child-9",
							status: "running",
							preview: "Investigating the API",
						},
						{
							label: "CMO",
							delegatedTediId: "tedi-cmo",
							childRunId: "child-10",
							status: "completed",
							summary: "Drafted the campaign",
						},
					],
				},
			],
		},
	};
}

describe("@tedix/cli TERMINAL_STATUSES parity", () => {
	test("every terminal status is a canonical TediRunStatus (no British/typo drift)", () => {
		for (const status of TERMINAL_STATUSES) {
			expect(TediRunStatusSchema.options).toContain(status);
		}
	});
});

describe("@tedix/cli buildStatusReport", () => {
	test("buckets active / requires_approval / settled runs", () => {
		const report = buildStatusReport({
			conversationId: "conv-1",
			runSet: sampleRunSet(),
		});
		expect(report.conversationId).toBe("conv-1");

		// Original terminal proposal metadata cannot reopen the active run bucket.
		const activeIds = report.activeRuns.map((r) => r.homeRunId).sort();
		expect(activeIds).toEqual(["r-appr", "r-deleg", "r-run"]);
		expect(activeIds).not.toContain("r-done");
		expect(activeIds).not.toContain("r-deleg-appr");

		const run = report.activeRuns.find((r) => r.homeRunId === "r-run");
		expect(run?.status).toBe("running");
		expect(run?.label).toBe("Thinking");
		expect(run?.targetTedi).toBe("CTO");
	});

	test("pendingApprovals includes live gates and excludes terminal draft history", () => {
		const report = buildStatusReport({
			conversationId: "conv-1",
			runSet: sampleRunSet(),
		});
		expect(report.pendingApprovals).toHaveLength(1);
		expect(report.pendingApprovals.map((row) => row.homeRunId).sort()).toEqual([
			"r-appr",
		]);
		// summary prefers the progress label.
		expect(
			report.pendingApprovals.find((row) => row.homeRunId === "r-appr")
				?.summary,
		).toBe("Approve the write?");
		expect(
			report.pendingApprovals.some((row) => row.homeRunId === "r-deleg-appr"),
		).toBe(false);
	});

	test.each(["completed", "failed", "canceled"])(
		"retains %s draft history without activity or approval counts",
		(status) => {
			const payload = sampleRunSet();
			const proposal = payload.runSet.runs.find(
				(run) => run.id === "r-deleg-appr",
			)!;
			proposal.status = status;
			const original = structuredClone(proposal);
			const report = buildStatusReport({
				conversationId: "conv-1",
				runSet: payload,
			});
			expect(report.activeRuns.map((run) => run.homeRunId)).not.toContain(
				proposal.id,
			);
			expect(report.pendingApprovals.map((run) => run.homeRunId)).toEqual([
				"r-appr",
			]);
			expect(proposal).toEqual(original);
			expect(renderStatusReport(report, { json: false })).not.toContain(
				proposal.id,
			);
		},
	);

	test("a live draft recommendation remains actionable alongside an explicit approval gate", () => {
		const payload = sampleRunSet();
		const proposal = payload.runSet.runs.find(
			(run) => run.id === "r-deleg-appr",
		)!;
		proposal.status = "requires_approval";
		const report = buildStatusReport({
			conversationId: "conv-1",
			runSet: payload,
		});
		expect(
			report.activeRuns.find((run) => run.homeRunId === proposal.id),
		).toMatchObject({
			status: "requires_approval",
			label: "Awaiting approval",
		});
		expect(report.pendingApprovals).toEqual([
			{ homeRunId: "r-appr", summary: "Approve the write?" },
			{ homeRunId: proposal.id, summary: "Check the Stripe catalog" },
		]);
		expect(renderStatusReport(report, { json: false })).toContain(
			"active=4 approvals=2",
		);
	});

	test("recentDelegations come from the child tree when present", () => {
		const report = buildStatusReport({
			conversationId: "conv-1",
			runSet: sampleRunSet(),
			childTree: sampleChildTree(),
		});
		expect(report.recentDelegations).toHaveLength(2);
		const cto = report.recentDelegations.find((d) => d.tedi === "CTO");
		const cmo = report.recentDelegations.find((d) => d.tedi === "CMO");
		expect(cto?.childRunId).toBe("child-9");
		expect(cto?.status).toBe("running");
		expect(cto?.preview).toBe("Investigating the API");
		expect(cmo?.childRunId).toBe("child-10");
		expect(cmo?.preview).toBe("Drafted the campaign");
		// The kernel root node has no childRunId, so it is excluded.
		expect(report.recentDelegations.some((d) => d.tedi === "Kernel")).toBe(
			false,
		);
	});

	test("recentDelegations fall back to run rows when no child tree", () => {
		const report = buildStatusReport({
			conversationId: "conv-1",
			runSet: sampleRunSet(),
		});
		expect(report.recentDelegations).toHaveLength(1);
		expect(report.recentDelegations[0]).toMatchObject({
			tedi: "CTO",
			childRunId: "child-9",
			status: "running",
			preview: "Working on it",
		});
	});

	test("present-but-empty child tree falls back to run-derived delegations", () => {
		const report = buildStatusReport({
			conversationId: "conv-1",
			runSet: sampleRunSet(),
			childTree: { tree: { conversationId: "conv-1", nodes: [] } },
		});
		expect(report.recentDelegations).toHaveLength(1);
		expect(report.recentDelegations[0]?.childRunId).toBe("child-9");
	});

	test("tolerates a flat { runs: [...] } shape (no runSet wrapper)", () => {
		const report = buildStatusReport({
			conversationId: "conv-2",
			runSet: { runs: [{ id: "r-x", status: "queued" }] },
		});
		expect(report.activeRuns).toHaveLength(1);
		expect(report.activeRuns[0]).toMatchObject({
			homeRunId: "r-x",
			status: "queued",
		});
	});

	test("is fully defensive about malformed payloads (never throws)", () => {
		for (const bad of [null, undefined, 42, "nope", [], {}, { runSet: 7 }]) {
			const report = buildStatusReport({
				conversationId: "conv-3",
				runSet: bad,
				childTree: bad,
			});
			expect(report.conversationId).toBe("conv-3");
			expect(report.activeRuns).toEqual([]);
			expect(report.pendingApprovals).toEqual([]);
			expect(report.recentDelegations).toEqual([]);
		}
	});

	test("reads runs and delegations through the Code Mode envelope", () => {
		// Both reads run as Code Mode, so the payload can still be the gateway
		// envelope `{ executionId, result }`. The envelope used to hide the whole
		// child tree (delegations=0 while a delegated run was in flight).
		const report = buildStatusReport({
			conversationId: "home:cli:-private-tmp",
			runSet: { executionId: "exec-1", result: sampleRunSet() },
			childTree: {
				executionId: "exec-2",
				result: {
					tree: {
						conversationId: "home:cli:-private-tmp",
						nodes: [
							{
								homeRunId: "r-deleg",
								delegatedTediId: "tedi-cto",
								childRunId: "child-9",
								label: "CTO",
								status: "running",
								active: true,
								children: [],
								metadata: {
									progress: { label: "Working", detail: "reading the repo" },
									preview: "Reviewing the kernel change",
								},
							},
						],
					},
				},
			},
		});
		expect(report.errors).toBeUndefined();
		expect(report.activeRuns.map((run) => run.homeRunId)).toEqual([
			"r-run",
			"r-appr",
			"r-deleg",
		]);
		expect(report.recentDelegations).toEqual([
			{
				tedi: "CTO",
				childRunId: "child-9",
				status: "running",
				preview: "Reviewing the kernel change",
			},
		]);
	});

	test("a truncated gateway result is an error, never an empty conversation", () => {
		const truncated = {
			executionId: "exec-1",
			result: {
				__tedix_truncated: true,
				preview: '{"runSet":{"runs":[{"id":"r-deleg","status":"running"',
				approxTokens: 27269,
				guidance: "Result truncated by the Code Mode gateway: ~27,269 tokens",
			},
		};
		const report = buildStatusReport({
			conversationId: "conv-5",
			runSet: truncated,
			childTree: truncated,
			errors: ["Runs: earlier"],
		});
		expect(report.activeRuns).toEqual([]);
		expect(report.recentDelegations).toEqual([]);
		expect(report.errors).toEqual([
			"Runs: earlier",
			"Runs: Result truncated by the Code Mode gateway: ~27,269 tokens",
			"Delegations: Result truncated by the Code Mode gateway: ~27,269 tokens",
		]);
		expect(renderStatusReport(report, { json: false })).toContain(
			"Status incomplete",
		);
	});

	test("skips non-record rows and rows without an id", () => {
		const report = buildStatusReport({
			conversationId: "conv-4",
			runSet: {
				runSet: {
					runs: [
						null,
						"garbage",
						{ status: "running" }, // no id → skipped by summarizeHomePayload
						{ id: "r-ok", status: "running" },
					],
				},
			},
		});
		expect(report.activeRuns).toHaveLength(1);
		expect(report.activeRuns[0]?.homeRunId).toBe("r-ok");
	});
});

describe("@tedix/cli renderStatusReport", () => {
	const report = buildStatusReport({
		conversationId: "conv-1",
		runSet: sampleRunSet(),
		childTree: sampleChildTree(),
	});

	test("json mode returns parseable JSON of the report", () => {
		const out = renderStatusReport(report, { json: true });
		expect(out.length).toBeGreaterThan(0);
		const parsed = JSON.parse(out);
		expect(parsed.conversationId).toBe("conv-1");
		expect(parsed.activeRuns).toHaveLength(3);
		expect(parsed.pendingApprovals).toHaveLength(1);
		expect(parsed.recentDelegations).toHaveLength(2);
	});

	test("human mode reflects counts and lists each bucket", () => {
		const out = renderStatusReport(report, { json: false });
		expect(out.length).toBeGreaterThan(0);
		expect(out).toContain("conversation=conv-1");
		// Header reflects the bucket counts.
		expect(out).toContain("active=3 approvals=1 delegations=2");
		// Rows reflect content.
		expect(out).toContain("r-run");
		expect(out).toContain("Thinking");
		expect(out).toContain("r-appr");
		expect(out).toContain("Approve the write?");
		expect(out).not.toContain("r-deleg-appr");
		expect(out).toContain("CTO");
		expect(out).toContain("child=child-9");
		// No raw ANSI escape sequences in plain-text render.
		expect(out).not.toContain("[");
	});

	test("human mode shows (none) for empty buckets", () => {
		const empty = buildStatusReport({ conversationId: "c", runSet: null });
		const out = renderStatusReport(empty, { json: false });
		expect(out).toContain("active=0 approvals=0 delegations=0");
		expect(out).toContain("(none)");
	});
});

test("failed reads remain visible in human and machine status", () => {
	const report = buildStatusReport({
		conversationId: "test",
		runSet: null,
		errors: ["Runs: missing mcp:messaging.read"],
	});
	expect(renderStatusReport(report, { json: false })).toContain(
		"Status incomplete",
	);
	expect(renderStatusReport(report, { json: false })).not.toContain("(none)");
	expect(JSON.parse(renderStatusReport(report, { json: true })).errors).toEqual(
		["Runs: missing mcp:messaging.read"],
	);
});
