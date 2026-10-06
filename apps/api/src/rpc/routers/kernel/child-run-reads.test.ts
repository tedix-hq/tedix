import type { SQL } from "drizzle-orm";
import { SQLiteDialect } from "drizzle-orm/sqlite-core";
import type { HomeRun } from "@tedix/api-contract/schemas/kernel-runtime";
import {
	tediArtifacts as tediArtifactsTable,
	type tediRuntimeEvents,
	tediRuntimeEvents as tediRuntimeEventsTable,
} from "@tedix/db/schema";
import { describe, expect, it } from "vite-plus/test";
import type { BaseContext } from "../../orpc";
import {
	buildFanoutChildNodes,
	buildHomeChildRunTree,
	childRunPreviewFromEvents,
	computeChildRunLiveness,
	delegatedWidgetProjectionFromEvents,
	latestActivityLabelFromEvents,
	readChildRunEvidenceRows,
	readChildRunResultAndLiveness,
	summarizeChildRuntimeEvents,
	workstationProcessOutcomeFromArtifactEvent,
	workflowInspectionFromEvents,
} from "./child-run-reads";

type EventRow = typeof tediRuntimeEvents.$inferSelect;

function makeEvent(
	kind: string,
	opts: {
		payload?: Record<string, unknown> | null;
		delta?: string | null;
		createdAt?: string;
	} = {},
): EventRow {
	return {
		id: `evt-${kind}-${Math.random().toString(36).slice(2, 8)}`,
		tediId: "tedi-cto",
		runId: "run-1",
		organizationId: "org-1",
		conversationId: "home:main",
		kind: kind as EventRow["kind"],
		payload: opts.payload ?? null,
		delta: opts.delta ?? null,
		messageId: null,
		createdAt: opts.createdAt ?? "2026-06-22T10:00:00.000Z",
		runtime: null,
		runtimeMetadata: null,
	} as EventRow;
}

function makeHomeRun(overrides: Partial<HomeRun>): HomeRun {
	return {
		id: "home-run-1",
		organizationId: "org-1",
		conversationId: "home:main",
		status: "running",
		delegatedTediId: "tedi-cto",
		childRunId: "child-1",
		runtime: { backend: "custom" },
		createdAt: "2026-06-22T10:00:00.000Z",
		updatedAt: "2026-06-22T10:05:00.000Z",
		progress: { current: 48, total: 100, label: "Running", detail: "" },
		metadata: {},
		...overrides,
	} as HomeRun;
}

describe("latestActivityLabelFromEvents", () => {
	it("labels a tool.started event as 'calling <name>'", () => {
		expect(
			latestActivityLabelFromEvents([
				makeEvent("tool.started", { payload: { name: "firecrawl_scrape" } }),
			]),
		).toBe("calling firecrawl_scrape");
	});

	it("labels a message.delta event as 'responding…'", () => {
		expect(latestActivityLabelFromEvents([makeEvent("message.delta")])).toBe(
			"responding…",
		);
	});

	it("reads artifact labels only from the canonical nested artifact", () => {
		expect(
			latestActivityLabelFromEvents([
				makeEvent("artifact.created", {
					payload: { artifact: { name: "report.md" } },
				}),
			]),
		).toBe("writing report.md");
		expect(
			latestActivityLabelFromEvents([
				makeEvent("artifact.created", { payload: { name: "legacy.md" } }),
			]),
		).toBe("writing artifact");
	});

	it("returns null when no meaningful event is present", () => {
		expect(
			latestActivityLabelFromEvents([makeEvent("run.completed")]),
		).toBeNull();
		expect(latestActivityLabelFromEvents([])).toBeNull();
	});
});

describe("workstationProcessOutcomeFromArtifactEvent", () => {
	it("does not label a process outcome from a top-level artifact name", () => {
		const outcome = workstationProcessOutcomeFromArtifactEvent(
			makeEvent("artifact.created", {
				payload: {
					artifact: {
						metadata: { eventType: "workstation.process.completed" },
					},
					name: "legacy.log",
				},
			}),
		);
		expect(outcome?.preview).toBe(
			"Workstation workstation process completed; subprocess artifact evidence is available.",
		);
	});
});

describe("childRunPreviewFromEvents", () => {
	it("wraps a structured tool.completed result in the canonical Raw result envelope", () => {
		const preview = childRunPreviewFromEvents(
			[makeEvent("tool.completed", { payload: { data: { ok: true } } })],
			null,
		);
		expect(preview).toMatch(/^Raw result: ```json/);
		expect(preview).toContain('"ok":true');
	});

	it("humanizes a tool-error result when there is no prose preview", () => {
		const preview = childRunPreviewFromEvents(
			[
				makeEvent("tool.completed", {
					payload: { data: "Execution error: boom" },
				}),
			],
			null,
		);
		expect(preview).toBe("Tool step errored: boom");
	});

	it("passes through the prose preview when there is no structured result", () => {
		expect(childRunPreviewFromEvents([], "just prose")).toBe("just prose");
	});

	it("prefers the child's prose final message over an intermediate structured tool result", () => {
		const preview = childRunPreviewFromEvents(
			[
				makeEvent("tool.completed", {
					payload: { data: [{ callable: "descope.get_all_lists" }] },
				}),
			],
			"Partial — unable to verify the workflow definition.",
		);
		expect(preview).toBe("Partial — unable to verify the workflow definition.");
	});

	it("still envelopes a final message that is itself structured JSON", () => {
		const preview = childRunPreviewFromEvents(
			[makeEvent("tool.completed", { payload: { data: { other: 1 } } })],
			'{"answer":42}',
		);
		expect(preview).toMatch(/^Raw result: ```json/);
		expect(preview).toContain('"answer":42');
	});

	it("humanizes a tool error even when the raw preview is whitespace-only", () => {
		const preview = childRunPreviewFromEvents(
			[
				makeEvent("tool.completed", {
					payload: { data: "Execution error: boom" },
				}),
			],
			"  ",
		);
		expect(preview).toBe("Tool step errored: boom");
	});
});

describe("delegatedWidgetProjectionFromEvents", () => {
	it.each(["tedix_mcp_call_tool", "tedix_mcp_code", "code"])(
		"does not invent an app for the %s gateway wrapper",
		(name) => {
			const resultProjection = {
				items: [{ title: "Bun" }, { title: "Node.js" }],
				layoutSpec: {
					root: "comparison",
					elements: {
						comparison: {
							type: "ComparisonLayout",
							props: { results: { $state: "/items" } },
						},
					},
				},
				_meta: {
					ui: {
						resourceUri: "ui://widgets/mcp-app/tedix-unified/r/comparison.html",
					},
				},
			};
			expect(
				delegatedWidgetProjectionFromEvents([
					makeEvent("tool.completed", { payload: { name, resultProjection } }),
				]),
			).toEqual([
				{
					resourceUri: resultProjection._meta.ui.resourceUri,
					toolResult: resultProjection,
				},
			]);
		},
	);

	/**
	 * Provenance must come from the tool NAME on the event, never from the
	 * result body — the body is the untrusted half. A result that declares
	 * another app's widget is exactly the case the stamp exists to expose.
	 */
	it("stamps the producing app from the tool name, not the payload", () => {
		const widgets = delegatedWidgetProjectionFromEvents([
			makeEvent("tool.completed", {
				payload: {
					name: "metabase__render_dashboard",
					data: {
						result: {
							_meta: {
								ui: { resourceUri: "ui://widgets/mcp-app/acme/x.html" },
							},
						},
					},
				},
			}),
		]);
		expect(widgets).toHaveLength(1);
		// The URI still says acme; the stamp says who actually ran. The
		// renderer compares them and refuses.
		expect(widgets[0]?.producedByAppSlug).toBe("metabase");
	});

	it("leaves provenance absent when the event carries no tool name", () => {
		const widgets = delegatedWidgetProjectionFromEvents([
			makeEvent("tool.completed", {
				payload: {
					data: {
						result: {
							_meta: {
								ui: { resourceUri: "ui://widgets/mcp-app/acme/x.html" },
							},
						},
					},
				},
			}),
		]);
		expect(widgets).toHaveLength(1);
		// UNKNOWN, not fabricated: renderers treat absence as unverifiable.
		expect(widgets[0]?.producedByAppSlug).toBeUndefined();
	});

	it("preserves a bounded ui.create_view result while stripping credentials", () => {
		const resourceUri = "ui://widgets/mcp-app/acme/r/comparison.html";
		const widgets = delegatedWidgetProjectionFromEvents([
			makeEvent("tool.completed", {
				payload: {
					input: { query: "running shoes", accessToken: "do-not-copy" },
					data: {
						result: {
							rows: [{ product: "Alpha", price: 42 }],
							apiKey: "do-not-copy",
							_meta: { ui: { resourceUri } },
						},
					},
				},
			}),
		]);

		expect(widgets).toEqual([
			{
				resourceUri,
				toolInput: { query: "running shoes" },
				toolResult: {
					rows: [{ product: "Alpha", price: 42 }],
					_meta: { ui: { resourceUri } },
				},
			},
		]);
	});

	it("prefers an explicit pre-truncation MCP UI projection", () => {
		const resourceUri = "ui://widgets/mcp-app/acme/r/comparison.html";
		const widgets = delegatedWidgetProjectionFromEvents([
			makeEvent("tool.completed", {
				payload: {
					result: { __tedix_truncated: true, preview: "clipped" },
					resultProjection: {
						items: [{ product: "Alpha", price: 42 }],
						_meta: { ui: { resourceUri } },
					},
				},
			}),
		]);

		expect(widgets).toEqual([
			{
				resourceUri,
				toolResult: {
					items: [{ product: "Alpha", price: 42 }],
					_meta: { ui: { resourceUri } },
				},
			},
		]);
	});

	it("rejects invalid resources, caps widgets, and drops oversized initial results", () => {
		const invalid = makeEvent("tool.completed", {
			payload: {
				data: { _meta: { ui: { resourceUri: "https://example.com/app" } } },
			},
		});
		const valid = Array.from({ length: 5 }, (_, index) =>
			makeEvent("tool.completed", {
				payload: {
					data: {
						items: Array.from({ length: 100 }, () => ({
							value: "x".repeat(4_096),
						})),
						_meta: {
							ui: {
								resourceUri: `ui://widgets/mcp-app/app-${index}/view.html`,
							},
						},
					},
				},
			}),
		);

		const widgets = delegatedWidgetProjectionFromEvents([invalid, ...valid]);
		expect(widgets).toHaveLength(3);
		expect(widgets.every((widget) => widget.toolResult === undefined)).toBe(
			true,
		);
	});
});

describe("summarizeChildRuntimeEvents", () => {
	it("retains the text of an explicit refusal instead of claiming no output", () => {
		const summary = summarizeChildRuntimeEvents([
			makeEvent("run.completed"),
			makeEvent("message.completed", {
				payload: {
					role: "assistant",
					content: "Outcome: blocked\nExecution was not authorized.",
				},
			}),
		]);
		expect(summary?.childRunStatus).toBe("failed");
		expect(summary?.childRunPreview).toContain("Execution was not authorized");
		expect(summary?.childRunPreview).not.toContain("No output was produced");
	});

	it("returns null for an empty event list", () => {
		expect(summarizeChildRuntimeEvents([])).toBeNull();
	});

	it("marks a run.completed with a substantive message as completed", () => {
		const summary = summarizeChildRuntimeEvents([
			makeEvent("run.completed", { createdAt: "2026-06-22T10:05:00.000Z" }),
			makeEvent("message.completed", {
				payload: { content: "done" },
				createdAt: "2026-06-22T10:04:59.000Z",
			}),
		]);
		expect(summary?.childRunStatus).toBe("completed");
		expect(summary?.childRunPreview).toBe("done");
		expect(summary?.childRunEventCount).toBe(2);
	});

	it("projects a structured workflow inspection into stable Home metadata", () => {
		const event = makeEvent("tool.completed", {
			payload: {
				name: "tedix_mcp_code",
				result: {
					status: {
						id: "workflow-run-1",
						status: "completed",
						tediId: "tedi-cto",
					},
					inspection: {
						run: {
							id: "workflow-run-1",
							status: "completed",
							tediId: "tedi-cto",
						},
						revision: { skillSlug: "kernel-goal-loop", revision: 8 },
					},
				},
			},
		});
		expect(workflowInspectionFromEvents([event])).toEqual({
			status: "completed",
			workflowRunId: "workflow-run-1",
			workflowSlug: "kernel-goal-loop",
			workflowTediId: "tedi-cto",
		});
		expect(summarizeChildRuntimeEvents([event])?.kernelWorkflowInspect).toEqual(
			{
				status: "completed",
				workflowRunId: "workflow-run-1",
				workflowSlug: "kernel-goal-loop",
				workflowTediId: "tedi-cto",
			},
		);
	});

	it("rejects a workflow inspection whose status and inspection ids disagree", () => {
		const event = makeEvent("tool.completed", {
			payload: {
				result: {
					status: { id: "workflow-run-1" },
					inspection: {
						run: { id: "workflow-run-2" },
						revision: { skillSlug: "kernel-goal-loop" },
					},
				},
			},
		});
		expect(workflowInspectionFromEvents([event])).toBeNull();
	});

	it("uses durable result identity when the full structured result was truncated", () => {
		const event = makeEvent("tool.completed", {
			payload: {
				result: '{"status":{"id":"workflow-run-1"}...(truncated)',
				resultIdentity: {
					status: {
						id: "workflow-run-1",
						status: "completed",
						tediId: "tedi-cto",
					},
					inspection: {
						run: { id: "workflow-run-1" },
						revision: { skillSlug: "kernel-goal-loop" },
					},
				},
			},
		});
		expect(workflowInspectionFromEvents([event])).toEqual({
			status: "completed",
			workflowRunId: "workflow-run-1",
			workflowSlug: "kernel-goal-loop",
			workflowTediId: "tedi-cto",
		});
	});

	it("ignores trailing non-assistant messages when choosing the child preview", () => {
		const summary = summarizeChildRuntimeEvents([
			makeEvent("run.completed", { createdAt: "2026-06-22T10:05:00.000Z" }),
			makeEvent("message.completed", {
				payload: { role: "user", content: "trailing user input" },
				createdAt: "2026-06-22T10:04:59.000Z",
			}),
			makeEvent("message.completed", {
				payload: { role: "assistant", content: "child answer" },
				createdAt: "2026-06-22T10:04:58.000Z",
			}),
		]);
		expect(summary?.childRunPreview).toBe("child answer");
	});

	it("downgrades a bare run.completed with no result to failed (disposition gate)", () => {
		const summary = summarizeChildRuntimeEvents([makeEvent("run.completed")]);
		expect(summary?.childRunStatus).toBe("failed");
	});

	it("preserves a structured partial stop on run.completed", () => {
		const summary = summarizeChildRuntimeEvents([
			makeEvent("run.completed", {
				payload: { stopReason: "step_ceiling" },
			}),
			makeEvent("message.completed", {
				payload: { role: "assistant", content: "Partial findings" },
			}),
		]);
		expect(summary).toMatchObject({
			childRunStatus: "partial",
			childRunStopReason: "step_ceiling",
		});
	});

	it.each([
		"Partial result: live verification timed out.",
		"**Partial — live verification was blocked.**",
	])("projects a standardized reported partial as partial: %s", (content) => {
		const summary = summarizeChildRuntimeEvents([
			makeEvent("run.completed"),
			makeEvent("message.completed", {
				payload: { role: "assistant", content },
			}),
		]);
		expect(summary).toMatchObject({
			childRunStatus: "partial",
			childRunStopReason: "reported_partial",
			childRunPreview: content,
		});
	});

	it("a marker-only stop (older runtime, no structured reason) is failed with the runtime's reason", () => {
		const marker =
			"[Turn stopped early: per-turn provider-call ceiling reached (10/10 steps). Partial results above; remaining work was not attempted.]";
		const summary = summarizeChildRuntimeEvents([
			makeEvent("run.completed"),
			makeEvent("message.completed", {
				payload: { role: "assistant", content: marker },
			}),
		]);
		expect(summary).toMatchObject({
			childRunStatus: "failed",
			childRunStopReason: "step_ceiling",
			childRunStopDetail:
				"Stopped after 10 steps: per-turn provider-call ceiling reached",
			childRunPreview:
				"No output was produced. Stopped after 10 steps: per-turn provider-call ceiling reached",
		});
	});

	it("a structured stop whose only text is the marker is failed, not partial", () => {
		const summary = summarizeChildRuntimeEvents([
			makeEvent("run.completed", {
				payload: { stopReason: "context_ceiling" },
			}),
			makeEvent("message.completed", {
				payload: {
					role: "assistant",
					content:
						"[Turn stopped early: per-turn cumulative input-token ceiling reached (750642/750000 input tokens over 17 steps). Partial results above; remaining work was not attempted.]",
				},
			}),
		]);
		expect(summary).toMatchObject({
			childRunStatus: "failed",
			childRunStopReason: "context_ceiling",
			childRunStopDetail:
				"Stopped after 17 steps: per-turn cumulative input-token ceiling reached",
		});
	});

	it("a structured stop with a forced text report before the marker (newer runtime) is partial", () => {
		const content =
			"Inspected the build; the root cause is a missing migration.\n\n[Turn stopped early: per-turn cumulative input-token ceiling reached (750642/750000 input tokens over 17 steps). Partial results above; remaining work was not attempted.]";
		const summary = summarizeChildRuntimeEvents([
			makeEvent("run.completed", {
				payload: { stopReason: "context_ceiling" },
			}),
			makeEvent("message.completed", {
				payload: { role: "assistant", content },
			}),
		]);
		expect(summary).toMatchObject({
			childRunStatus: "partial",
			childRunStopReason: "context_ceiling",
			childRunStopDetail:
				"Stopped after 17 steps: per-turn cumulative input-token ceiling reached",
			childRunPreview: content,
		});
	});

	it("does not infer partial from ordinary assistant prose about limits", () => {
		const summary = summarizeChildRuntimeEvents([
			makeEvent("run.completed"),
			makeEvent("message.completed", {
				payload: {
					role: "assistant",
					content:
						"The provider limit is documented; the requested work is complete.",
				},
			}),
		]);
		expect(summary).toMatchObject({
			childRunStatus: "completed",
			childRunStopReason: null,
		});
	});

	it("marks a run.failed with no completion event as failed", () => {
		const summary = summarizeChildRuntimeEvents([makeEvent("run.failed")]);
		expect(summary?.childRunStatus).toBe("failed");
	});

	it("derives streaming from a message.delta with no terminal event", () => {
		const summary = summarizeChildRuntimeEvents([
			makeEvent("message.delta", { delta: "partial" }),
		]);
		expect(summary?.childRunStatus).toBe("streaming");
	});

	it("derives running from a run.started with no terminal or delta event", () => {
		const summary = summarizeChildRuntimeEvents([makeEvent("run.started")]);
		expect(summary?.childRunStatus).toBe("running");
	});

	it.each(["tool.started", "tool.completed", "tool.failed", "step.completed"])(
		"keeps a bounded active window running after run.started ages out: %s",
		(kind) => {
			const rows = [
				makeEvent(kind, { payload: { name: "exec", toolNames: ["exec"] } }),
				...Array.from({ length: 24 }, () => makeEvent("context.injected")),
				makeEvent("run.started"),
				makeEvent("message.received"),
			];
			const latest = rows.slice(0, 25);
			expect(latest.some((row) => row.kind === "run.started")).toBe(false);
			for (const window of [rows, latest]) {
				expect(summarizeChildRuntimeEvents(window)).toMatchObject({
					childRunStatus: "running",
					childRunLatestActivityLabel: "calling exec",
					childRunTerminalAt: null,
				});
			}
		},
	);

	it.each(["message.received", "context.injected", "artifact.created"])(
		"does not infer execution from %s alone",
		(kind) => {
			expect(summarizeChildRuntimeEvents([makeEvent(kind)])).toMatchObject({
				childRunStatus: "queued",
				childRunTerminalAt: null,
			});
		},
	);

	it.each([
		["run.completed", "completed"],
		["run.failed", "failed"],
		["run.canceled", "canceled"],
		["approval.requested", "requires_approval"],
		["message.delta", "streaming"],
	])("preserves %s priority over execution activity", (kind, status) => {
		const summary = summarizeChildRuntimeEvents([
			makeEvent(kind, { delta: kind === "message.delta" ? "answer" : null }),
			makeEvent("tool.started", { payload: { name: "exec" } }),
			makeEvent("message.completed", {
				payload: { role: "assistant", content: "The requested work is done." },
			}),
		]);
		expect(summary?.childRunStatus).toBe(status);
	});

	it("keeps an unresolved durable approval visible as requires_approval", () => {
		const summary = summarizeChildRuntimeEvents([
			makeEvent("approval.requested", {
				payload: {
					surface: "durable_codemode",
					executionId: "exec-1",
				},
			}),
			makeEvent("message.completed", {
				payload: { content: "Paused for approval" },
			}),
			makeEvent("run.started"),
		]);
		expect(summary?.childRunStatus).toBe("requires_approval");
	});

	it("moves an approval-resolved run back to running until its terminal event", () => {
		const summary = summarizeChildRuntimeEvents([
			makeEvent("approval.resolved"),
			makeEvent("approval.requested"),
			makeEvent("run.started"),
		]);
		expect(summary?.childRunStatus).toBe("running");
	});
});

describe("buildFanoutChildNodes", () => {
	it("builds queued nodes for live slots", () => {
		const nodes = buildFanoutChildNodes({
			homeRunId: "home-run-1",
			conversationId: "home:main",
			delegatedTediId: "tedi-cto",
			liveSlots: [
				{
					id: "parent:fanout:tedi-cto:fanout:child-1",
					childRunId: "tedi-cto:fanout:child-1",
					ownerTediId: "tedi-cto",
					ownerSlug: "cto",
					ownerLabel: "Summarize page",
					objective: "Summarize the product page",
					status: "queued",
					dispatchedAt: "2026-06-22T10:00:00Z",
				},
			],
			terminalByRunId: new Map(),
		});
		expect(nodes).toHaveLength(1);
		expect(nodes[0]).toMatchObject({
			id: "fanout:tedi-cto:tedi-cto:fanout:child-1",
			delegatedTediId: "tedi-cto",
			childRunId: "tedi-cto:fanout:child-1",
			status: "queued",
			active: true,
			depth: 1,
		});
	});

	it("upgrades a live slot to its D1 terminal status and dedups", () => {
		const nodes = buildFanoutChildNodes({
			homeRunId: "home-run-1",
			conversationId: "home:main",
			delegatedTediId: "tedi-cto",
			liveSlots: [
				{
					id: "parent:fanout:tedi-cto:fanout:child-1",
					childRunId: "tedi-cto:fanout:child-1",
					ownerTediId: "tedi-cto",
					ownerSlug: "cto",
					ownerLabel: "Task A",
					objective: "Do task A",
					status: "queued",
					dispatchedAt: null,
				},
			],
			terminalByRunId: new Map([["tedi-cto:fanout:child-1", "completed"]]),
		});
		expect(nodes).toHaveLength(1);
		expect(nodes[0]?.status).toBe("completed");
		expect(nodes[0]?.active).toBe(false);
	});

	it("keeps terminal-only fan-out labels distinguishable after truncation", () => {
		const nodes = buildFanoutChildNodes({
			homeRunId: "home-run-1",
			conversationId: "home:main",
			delegatedTediId: "tedi-cto",
			liveSlots: [],
			terminalByRunId: new Map([
				["tedi-cto:fanout:fp1-1782204114", "completed"],
				["tedi-cto:fanout:fp2-1782204114", "completed"],
			]),
		});

		expect(nodes.map((node) => node.label)).toEqual([
			"Fan-out fp1-1782204114",
			"Fan-out fp2-1782204114",
		]);
		expect(nodes[0]?.label.slice(0, 18)).not.toBe(nodes[1]?.label.slice(0, 18));
	});
});

describe("buildHomeChildRunTree (tree status/label mapping)", () => {
	it("builds a delegation node using metadata.childRunStatus and the kernelRoute owner label", () => {
		const tree = buildHomeChildRunTree({
			organizationId: "org-1",
			conversationId: "home:main",
			runs: [
				makeHomeRun({
					metadata: {
						childRunStatus: "running",
						kernelRoute: { ownerLabel: "CTO" },
					},
				}),
			],
		});
		expect(tree.nodes).toHaveLength(1);
		expect(tree.nodes[0]).toMatchObject({
			id: "child:tedi-cto:child-1",
			delegatedTediId: "tedi-cto",
			childRunId: "child-1",
			status: "running",
			active: true,
			label: "CTO",
			depth: 0,
		});
		expect(tree.activeNodeId).toBe("child:tedi-cto:child-1");
	});

	it("falls back to run.status when metadata.childRunStatus is absent", () => {
		const tree = buildHomeChildRunTree({
			organizationId: "org-1",
			conversationId: "home:main",
			runs: [makeHomeRun({ status: "completed", metadata: {} })],
		});
		expect(tree.nodes[0]?.status).toBe("completed");
		expect(tree.nodes[0]?.active).toBe(false);
		expect(tree.activeNodeId).toBeNull();
	});

	it("omits runs that are neither delegated nor carry a child run id", () => {
		const tree = buildHomeChildRunTree({
			organizationId: "org-1",
			conversationId: "home:main",
			runs: [makeHomeRun({ delegatedTediId: null, childRunId: null })],
		});
		expect(tree.nodes).toHaveLength(0);
	});

	it("projects approved Home plan assignments as children of one coordinated run", () => {
		const tree = buildHomeChildRunTree({
			organizationId: "org-1",
			conversationId: "home:main",
			runs: [
				makeHomeRun({
					delegatedTediId: null,
					childRunId: null,
					status: "running",
					metadata: {
						homePlan: {
							assignments: [
								{
									id: "a1",
									ownerTediId: "tedi-cto",
									ownerLabel: "CTO",
									childRunId: "child-cto",
									workItemId: "work-cto",
									objective: "Inspect main",
									status: "completed",
								},
								{
									id: "a2",
									ownerTediId: "tedi-cpo",
									ownerLabel: "CPO",
									childRunId: "child-cpo",
									objective: "Inspect runtime",
									status: "running",
								},
							],
						},
					},
				}),
			],
		});
		expect(tree.nodes).toHaveLength(1);
		expect(tree.nodes[0]).toMatchObject({
			id: "home:home-run-1",
			homeRunId: "home-run-1",
			label: "Home plan",
			active: true,
			children: [
				{
					id: "child:tedi-cto:child-cto",
					label: "CTO",
					status: "completed",
					active: false,
					depth: 1,
				},
				{
					id: "child:tedi-cpo:child-cpo",
					label: "CPO",
					status: "running",
					active: true,
					depth: 1,
				},
			],
		});
		expect(tree.activeNodeId).toBe("home:home-run-1");
	});
});

describe("computeChildRunLiveness", () => {
	// Production event rows are DESC (newest-first); the helper reverses them.
	// Build chronologically here and reverse to simulate the real input order.
	const desc = (chronological: EventRow[]): EventRow[] =>
		[...chronological].reverse();
	const code = (codeStr: string) => ({ code: codeStr });

	it("discovery-only run has NO execution evidence (the stall)", () => {
		const liveness = computeChildRunLiveness(
			desc([
				makeEvent("tool.started", {
					payload: {
						name: "tedix_mcp_search_tools",
						arguments: { query: "github" },
					},
				}),
				makeEvent("tool.completed", {
					payload: { name: "tedix_mcp_search_tools" },
				}),
				makeEvent("tool.started", {
					payload: {
						name: "tedix_mcp_code",
						arguments: code("async () => await discover.list_namespaces()"),
					},
				}),
				makeEvent("tool.completed", { payload: { name: "tedix_mcp_code" } }),
				// The model's own per-round record agrees: 2 tool calls, both observed.
				makeEvent("step.completed", {
					payload: { toolCallCount: 1, toolNames: ["tedix_mcp_search_tools"] },
				}),
				makeEvent("step.completed", {
					payload: { toolCallCount: 1, toolNames: ["tedix_mcp_code"] },
				}),
				// Real emitted shape: label nested at payload.artifact.name and
				// path-formed ("<name>/<runId>.json"), exactly as the runtime writes it.
				makeEvent("artifact.created", {
					payload: { artifact: { name: "turn_summary/run-1.json" } },
				}),
			]),
		);
		expect(liveness.toolCallCount).toBe(2);
		expect(liveness.hasExecutionEvidence).toBe(false);
		// Every step-recorded call has a matching tool.started → no blind spot, so
		// the gate is free to treat this as a confident discovery stall.
		expect(liveness.hasUnclassifiedToolCall).toBe(false);
	});

	it("step.completed tally exceeding tool.started flags a blind spot (direct-path gap)", () => {
		// The confirmed direct-path bug: round-0 search_tools emits tool.started but
		// round-1 tedix_mcp_code executes with its tool.started DROPPED — only the
		// step.completed tally records it. The gate must not read this as discovery-only.
		const liveness = computeChildRunLiveness(
			desc([
				makeEvent("tool.started", {
					payload: {
						name: "tedix_mcp_search_tools",
						arguments: { query: "web" },
					},
				}),
				makeEvent("tool.completed", {
					payload: { name: "tedix_mcp_search_tools" },
				}),
				makeEvent("step.completed", {
					payload: { toolCallCount: 1, toolNames: ["tedix_mcp_search_tools"] },
				}),
				// tedix_mcp_code ran (step says so) but its tool.started never landed.
				makeEvent("step.completed", {
					payload: { toolCallCount: 1, toolNames: ["tedix_mcp_code"] },
				}),
			]),
		);
		// Authoritative count comes from the step tally (2), not the 1 observed start.
		expect(liveness.toolCallCount).toBe(2);
		expect(liveness.hasExecutionEvidence).toBe(false);
		expect(liveness.hasUnclassifiedToolCall).toBe(true);
	});

	it("classifies a facet-native direct tool from step.completed.toolNames", () => {
		const liveness = computeChildRunLiveness(
			desc([
				makeEvent("step.completed", {
					payload: { toolCallCount: 1, toolNames: ["browser_execute"] },
				}),
			]),
		);
		expect(liveness.toolCallCount).toBe(1);
		expect(liveness.hasExecutionEvidence).toBe(true);
		expect(liveness.hasUnclassifiedToolCall).toBe(false);
	});

	it("keeps a missing named codemode call unknown while classifying direct tools", () => {
		const liveness = computeChildRunLiveness(
			desc([
				makeEvent("step.completed", {
					payload: { toolCallCount: 1, toolNames: ["browser_execute"] },
				}),
				makeEvent("step.completed", {
					payload: { toolCallCount: 1, toolNames: ["tedix_mcp_code"] },
				}),
			]),
		);
		expect(liveness.toolCallCount).toBe(2);
		expect(liveness.hasExecutionEvidence).toBe(true);
		expect(liveness.hasUnclassifiedToolCall).toBe(true);
	});

	it("keeps missing named discovery calls non-evidence without marking them unknown", () => {
		const liveness = computeChildRunLiveness(
			desc([
				makeEvent("step.completed", {
					payload: { toolCallCount: 1, toolNames: ["tedix_mcp_search_tools"] },
				}),
			]),
		);
		expect(liveness.toolCallCount).toBe(1);
		expect(liveness.hasExecutionEvidence).toBe(false);
		expect(liveness.hasUnclassifiedToolCall).toBe(false);
	});

	it("run that CALLS a real tool (after a failed retry) has execution evidence", () => {
		const liveness = computeChildRunLiveness(
			desc([
				makeEvent("tool.started", {
					payload: { name: "tedix_mcp_search_tools", arguments: {} },
				}),
				makeEvent("tool.completed", {
					payload: { name: "tedix_mcp_search_tools" },
				}),
				makeEvent("tool.started", {
					payload: {
						name: "tedix_mcp_code",
						arguments: code(
							"async () => await github_tedix.list_commits({ per_page: 5 })",
						),
					},
				}),
				makeEvent("tool.failed", { payload: { name: "tedix_mcp_code" } }), // timeout
				makeEvent("tool.started", {
					payload: {
						name: "tedix_mcp_code",
						arguments: code(
							"async () => await github_tedix.list_commits({ per_page: 5 })",
						),
					},
				}),
				makeEvent("tool.completed", {
					payload: {
						name: "tedix_mcp_code",
						result: {
							result: {
								completionEvidence: {
									operation: "read_execution",
									status: "succeeded",
									supportedClaims: ["the command completed successfully"],
								},
							},
						},
					},
				}),
			]),
		);
		expect(liveness.toolCallCount).toBe(3);
		// The FIRST code start (timeout) pairs with tool.failed; the SECOND pairs
		// with tool.completed → an execution tool succeeded.
		expect(liveness.hasExecutionEvidence).toBe(true);
		expect(liveness.hasTerminalExecutionEvidence).toBe(true);
	});

	it("does not accept a bare Code Mode completion without completionEvidence", () => {
		const liveness = computeChildRunLiveness(
			desc([
				makeEvent("tool.started", {
					payload: {
						name: "tedix_mcp_code",
						arguments: code(
							"async () => await github_tedix.list_commits({ per_page: 5 })",
						),
					},
				}),
				makeEvent("tool.completed", {
					payload: { name: "tedix_mcp_code", result: {} },
				}),
			]),
		);
		expect(liveness.hasExecutionEvidence).toBe(false);
		expect(liveness.hasUnclassifiedToolCall).toBe(true);
	});

	it("accepts the EXECUTOR receipt carried beside the model's projection", () => {
		// The live failure: a program returns `{ count: 9 }`, which drops the
		// per-call completionEvidence its tool results carried. The executor's own
		// receipt rides beside `result`, so a run that demonstrably executed is no
		// longer scored as UNKNOWN evidence.
		const liveness = computeChildRunLiveness(
			desc([
				makeEvent("tool.started", {
					payload: {
						name: "tedix_mcp_code",
						arguments: code("async () => await tedis.list_tedis({})"),
					},
				}),
				makeEvent("tool.completed", {
					payload: {
						name: "tedix_mcp_code",
						result: { count: 9 },
						completionEvidence: {
							operation: "tedix_mcp_code",
							status: "succeeded",
							supportedClaims: [
								"1 of 1 Code Mode tool call(s) returned successfully (tedis.list_tedis=succeeded)",
							],
						},
					},
				}),
			]),
		);
		expect(liveness.hasExecutionEvidence).toBe(true);
		expect(liveness.hasUnclassifiedToolCall).toBe(false);
	});

	it("a FAILED executor receipt is not execution evidence", () => {
		const liveness = computeChildRunLiveness(
			desc([
				makeEvent("tool.started", {
					payload: {
						name: "tedix_mcp_code",
						arguments: code("async () => await tedis.list_tedis({})"),
					},
				}),
				makeEvent("tool.completed", {
					payload: {
						name: "tedix_mcp_code",
						// A program can swallow an inner failure and still return a
						// happy-looking value; the receipt is what the executor saw.
						result: { ok: true },
						completionEvidence: {
							operation: "tedix_mcp_code",
							status: "failed",
							supportedClaims: [],
						},
					},
				}),
			]),
		);
		expect(liveness.hasExecutionEvidence).toBe(false);
		expect(liveness.hasUnclassifiedToolCall).toBe(true);
	});

	it("a real (non-turn_summary) artifact is execution evidence", () => {
		// The runtime nests the label at payload.artifact.name — the shape 100% of
		// production artifact.created events carry.
		const liveness = computeChildRunLiveness(
			desc([
				makeEvent("artifact.created", {
					payload: { artifact: { name: "report.md" } },
				}),
			]),
		);
		expect(liveness.hasExecutionEvidence).toBe(true);
	});

	it("ignores a top-level artifact name outside the canonical artifact object", () => {
		const liveness = computeChildRunLiveness(
			desc([makeEvent("artifact.created", { payload: { name: "report.md" } })]),
		);
		expect(liveness.hasExecutionEvidence).toBe(false);
	});

	it("path-formed turn_summary matches bookkeeping on its first segment", () => {
		const liveness = computeChildRunLiveness(
			desc([
				makeEvent("artifact.created", {
					payload: { artifact: { name: "turn_summary/tedi-1_mcp_key.json" } },
				}),
			]),
		);
		expect(liveness.hasExecutionEvidence).toBe(false);
	});

	it("workstation_process artifacts count as (non-terminal) execution evidence", () => {
		// A subprocess artifact exists only
		// when a process actually ran under the run's workstation lease — that is
		// execution, unlike a self-referential turn_summary. Terminal settlement
		// still requires a run.* event.
		const liveness = computeChildRunLiveness(
			desc([
				makeEvent("artifact.created", {
					payload: {
						artifact: { name: "workstation_process/proc-1/stdout.log" },
					},
				}),
			]),
		);
		expect(liveness.hasExecutionEvidence).toBe(true);
		expect(liveness.hasTerminalExecutionEvidence).toBe(false);
	});

	it("no tool calls → toolCallCount 0, no execution evidence", () => {
		const liveness = computeChildRunLiveness(
			desc([makeEvent("message.completed", { payload: { content: "hi" } })]),
		);
		expect(liveness.toolCallCount).toBe(0);
		expect(liveness.hasExecutionEvidence).toBe(false);
		expect(liveness.hasUnclassifiedToolCall).toBe(false);
	});
});

describe("readChildRunEvidenceRows (delegated-run keying + transient D1 retry)", () => {
	// The auto-dispatch child-run id shape verified against production D1:
	// `{tediId}:mcp:{homeRunId}_auto_{tediId}` — events and artifacts are keyed
	// by EXACTLY this stored childRunId (no mapping indirection), so an
	// empty-with-error read is a transport flake, never missing data.
	const TEDI_ID = "5eed0038-0000-4000-8000-000000000038";
	const HOME_RUN_ID = "5eed0047-0000-4000-8000-000000000047";
	const AUTO_CHILD_RUN_ID = `${TEDI_ID}:mcp:${HOME_RUN_ID}_auto_${TEDI_ID}`;
	const TRANSIENT_502 = new Error(
		"D1_ERROR: Failed to parse body as JSON, got: error code: 502",
	);

	function delegatedEvent(kind: string, createdAt: string): EventRow {
		return {
			...makeEvent(kind, { createdAt }),
			tediId: TEDI_ID,
			runId: AUTO_CHILD_RUN_ID,
		} as EventRow;
	}

	/**
	 * Table-aware chainable db stub: tediRuntimeEvents selects can be made to
	 * reject the first N attempts (transient flake), tediArtifacts selects
	 * resolve the given artifact rows, everything else (the
	 * chatDispatchIdempotency mapping read) resolves [].
	 */
	function evidenceDbStub(opts: {
		eventRows: EventRow[];
		artifactRows?: Array<Record<string, unknown>>;
		failFirstEventReads?: number;
		eventReadError?: Error;
		artifactReadError?: Error;
		finalEventRows?: EventRow[];
	}) {
		let eventReadCalls = 0;
		let artifactReadCalls = 0;
		const eventQueryParams: unknown[][] = [];
		const db = {
			select() {
				let table: unknown;
				const chain = {
					from(t: unknown) {
						table = t;
						return chain;
					},
					where(clause: SQL) {
						if (table === tediRuntimeEventsTable)
							eventQueryParams.push(
								new SQLiteDialect().sqlToQuery(clause).params,
							);
						return chain;
					},
					orderBy() {
						return chain;
					},
					limit() {
						if (table === tediRuntimeEventsTable) {
							eventReadCalls += 1;
							if (eventReadCalls > 1 && opts.finalEventRows)
								return Promise.resolve(opts.finalEventRows);
							if (eventReadCalls <= (opts.failFirstEventReads ?? 0)) {
								return Promise.reject(opts.eventReadError ?? TRANSIENT_502);
							}
							return Promise.resolve(opts.eventRows);
						}
						if (table === tediArtifactsTable) {
							artifactReadCalls += 1;
							if (opts.artifactReadError)
								return Promise.reject(opts.artifactReadError);
							return Promise.resolve(opts.artifactRows ?? []);
						}
						return Promise.resolve([]);
					},
				};
				return chain;
			},
		};
		return {
			context: { db } as unknown as BaseContext,
			eventReadCalls: () => eventReadCalls,
			artifactReadCalls: () => artifactReadCalls,
			eventQueryParams,
		};
	}

	it.each([
		[
			"Outcome: failed\n\nVerification output:\nFAIL\nrepo_commit 11683b627600b6fe2e5cfce0468f0cc13afe0e58",
			"failed",
		],
		[
			"Outcome: needs_follow_up\nOwner: CTO; next action: fix the merge.",
			"needs_follow_up",
		],
		["Outcome: succeeded\nThe requested answer is ready.", "succeeded"],
		["An ordinary answer without an outcome heading.", null],
		["", null],
	] as const)(
		"reads the task outcome only from the latest final: %s",
		async (content, outcome) => {
			const rows = [
				makeEvent("run.completed"),
				makeEvent("tool.completed", {
					payload: { result: "Outcome: succeeded" },
				}),
				makeEvent("message.completed", {
					payload: { role: "tool", content: "Outcome: succeeded" },
				}),
				makeEvent("message.delta", {
					payload: { role: "assistant", content: "Outcome: succeeded" },
				}),
				makeEvent("message.completed", {
					payload: { role: "assistant", content },
				}),
				makeEvent("message.completed", {
					payload: { role: "assistant", content: "Outcome: succeeded" },
				}),
			];
			const stub = evidenceDbStub({ eventRows: rows });
			const result = await readChildRunResultAndLiveness(stub.context, {
				tediId: TEDI_ID,
				runId: AUTO_CHILD_RUN_ID,
				organizationId: "org-1",
			});
			expect(result.declaredOutcome).toBe(outcome);
			expect(result.readAvailable).toBe(true);
			const summary = summarizeChildRuntimeEvents(rows);
			expect(summary?.childTaskOutcome).toBe(outcome);
			expect(summary?.childRunStatus).toBe("completed");
		},
	);

	it.each([
		"ledger unavailable",
		"D1_ERROR: Failed to parse body as JSON, got: error code: 502",
		"no such table: tedi_runtime_events",
	])(
		"distinguishes an unavailable authoritative read from an answer with no declaration: %s",
		async (message) => {
			const stub = evidenceDbStub({
				eventRows: [],
				failFirstEventReads: 10,
				eventReadError: new Error(message),
			});
			const result = await readChildRunResultAndLiveness(stub.context, {
				tediId: TEDI_ID,
				runId: AUTO_CHILD_RUN_ID,
				organizationId: "org-1",
			});
			expect(result).toMatchObject({
				readAvailable: false,
				declaredOutcome: null,
				transcript: null,
			});
		},
	);

	it("reads an authoritative task outcome when optional artifact lookup fails", async () => {
		const stub = evidenceDbStub({
			eventRows: [
				makeEvent("run.completed"),
				makeEvent("message.completed", {
					payload: {
						role: "assistant",
						content: "Outcome: succeeded\nThe requested answer is ready.",
					},
				}),
			],
			artifactReadError: new Error("artifact service unavailable"),
		});
		const result = await readChildRunResultAndLiveness(stub.context, {
			tediId: TEDI_ID,
			runId: AUTO_CHILD_RUN_ID,
			organizationId: "org-1",
		});
		expect(result).toMatchObject({
			readAvailable: true,
			declaredOutcome: "succeeded",
		});
		expect(result.transcript).toContain("The requested answer is ready");
		expect(stub.artifactReadCalls()).toBe(1);
	});

	it("recovers a failed final answer evicted from the mixed event window", async () => {
		const final = makeEvent("message.completed", {
			createdAt: "2026-07-11T17:20:10.000Z",
			payload: {
				role: "assistant",
				content:
					"Outcome: failed\nVerification output:\nFAIL. I did not publish.",
			},
		});
		const stub = evidenceDbStub({
			eventRows: Array.from({ length: 120 }, () =>
				makeEvent("tool.completed", {
					createdAt: "2026-07-11T17:20:11.000Z",
					payload: { result: "Outcome: succeeded" },
				}),
			),
			finalEventRows: [final],
		});
		const result = await readChildRunResultAndLiveness(stub.context, {
			tediId: TEDI_ID,
			runId: AUTO_CHILD_RUN_ID,
			organizationId: "org-1",
		});
		expect(stub.eventReadCalls()).toBe(2);
		expect(stub.eventQueryParams[1]).toEqual(
			expect.arrayContaining([
				"org-1",
				TEDI_ID,
				AUTO_CHILD_RUN_ID,
				"message.completed",
			]),
		);
		expect(result).toMatchObject({
			readAvailable: true,
			declaredOutcome: "failed",
		});
		expect(result.transcript).toContain("I did not publish");
	});

	it("does not confuse an absent final answer with a valid ordinary answer", async () => {
		const stub = evidenceDbStub({
			eventRows: [makeEvent("run.completed")],
			finalEventRows: [],
		});
		const result = await readChildRunResultAndLiveness(stub.context, {
			tediId: TEDI_ID,
			runId: AUTO_CHILD_RUN_ID,
			organizationId: "org-1",
		});
		expect(result).toMatchObject({
			readAvailable: false,
			declaredOutcome: null,
		});
	});

	it("returns evidence rows keyed by the exact stored auto-dispatch childRunId", async () => {
		const stub = evidenceDbStub({
			eventRows: [
				delegatedEvent("run.completed", "2026-07-11T17:20:11.000Z"),
				delegatedEvent("message.completed", "2026-07-11T17:20:10.000Z"),
			],
			artifactRows: [{ id: "artifact-1", runId: AUTO_CHILD_RUN_ID }],
		});
		const result = await readChildRunEvidenceRows(stub.context, {
			artifactLimit: 8,
			eventLimit: 100,
			runId: AUTO_CHILD_RUN_ID,
			tediId: TEDI_ID,
			organizationId: "org-1",
		});
		expect(result.observedRunIds).toEqual([AUTO_CHILD_RUN_ID]);
		expect(result.eventRows).toHaveLength(2);
		expect(result.artifactRows).toHaveLength(1);
	});

	it("retries a transient remote-D1 transport flake (502 body-parse) instead of rendering an empty ledger", async () => {
		const stub = evidenceDbStub({
			eventRows: [delegatedEvent("run.completed", "2026-07-11T17:20:11.000Z")],
			failFirstEventReads: 1,
		});
		const result = await readChildRunEvidenceRows(stub.context, {
			artifactLimit: 0,
			eventLimit: 120,
			runId: AUTO_CHILD_RUN_ID,
			tediId: TEDI_ID,
			organizationId: "org-1",
		});
		expect(stub.eventReadCalls()).toBe(2);
		expect(result.eventRows).toHaveLength(1);
	});

	it("fails soft to empty rows when the transient flake outlasts the retry budget (initial + 2 retries)", async () => {
		const stub = evidenceDbStub({
			eventRows: [delegatedEvent("run.completed", "2026-07-11T17:20:11.000Z")],
			failFirstEventReads: 10,
		});
		const result = await readChildRunEvidenceRows(stub.context, {
			artifactLimit: 0,
			eventLimit: 120,
			runId: AUTO_CHILD_RUN_ID,
			tediId: TEDI_ID,
			organizationId: "org-1",
		});
		expect(stub.eventReadCalls()).toBe(3);
		expect(result.eventRows).toEqual([]);
	});

	it("does NOT retry or swallow a non-transient error (schema drift must stay loud)", async () => {
		const stub = evidenceDbStub({
			eventRows: [],
			failFirstEventReads: 10,
			eventReadError: new Error("no such column: nonexistent"),
		});
		await expect(
			readChildRunEvidenceRows(stub.context, {
				artifactLimit: 0,
				eventLimit: 120,
				runId: AUTO_CHILD_RUN_ID,
				tediId: TEDI_ID,
				organizationId: "org-1",
			}),
		).rejects.toThrow("no such column");
		expect(stub.eventReadCalls()).toBe(1);
	});
});
