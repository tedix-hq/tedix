import { describe, expect, it, vi } from "vite-plus/test";
import {
	augmentTreeWithFanoutChildren,
	buildFanoutChildNodes,
} from "./kernel/child-run-delegated-result";
import { readSingleChildRunSummary } from "./kernel/child-run-reads";
import {
	explicitDelegationNeedsEmbodiedSurface,
	kernelRuntimeTestHooks,
} from "./kernel-runtime/policy-normalization";

import {
	ORG_ID,
	type WorkItemRow,
	type WorkAttemptRow,
	normalizeKernelRuntimeRunInsert,
	createKernelRuntimeDb,
	createContext,
	createKernelRuntimeClient,
	childRuntimeEvent,
} from "./__tests__/kernel-runtime-db";

vi.mock("@tedix/db/queries/work-items/admissions", async (importOriginal) => {
	const original =
		await importOriginal<
			typeof import("@tedix/db/queries/work-items/admissions")
		>();
	return {
		...original,
		evaluateAndRecordWorkAdmission: vi.fn(async (_db, input) => ({
			id: `admission:${input.workItemId}:${input.executorId}`,
			expiresAt: new Date(
				Date.parse(input.now) + input.leaseTtlMs,
			).toISOString(),
			decision: "admitted" as const,
		})),
	};
});

vi.mock("@tedix/db/queries/work-items/attempts", async (importOriginal) => {
	const original =
		await importOriginal<
			typeof import("@tedix/db/queries/work-items/attempts")
		>();
	return {
		...original,
		startWorkItemAttempt: vi.fn(
			async (
				db: unknown,
				input: {
					admissionId: string;
					executor: { type: "tedi" | "external_agent"; id: string };
					expiresAt?: string;
					metadata?: Record<string, unknown>;
					orgId: string;
					runId?: string;
					startedAt?: string;
					workItemId: string;
				},
			) => {
				const fake = db as {
					workAttemptRows: WorkAttemptRow[];
					workItemRows: WorkItemRow[];
				};
				const workItem = fake.workItemRows.find(
					(row) => row.id === input.workItemId,
				);
				if (!workItem) throw new Error(`Missing Work Item ${input.workItemId}`);
				const startedAt = input.startedAt ?? new Date().toISOString();
				const attempt = {
					id: crypto.randomUUID(),
					admissionId: input.admissionId,
					workItemId: input.workItemId,
					orgId: input.orgId,
					executorType: input.executor.type,
					executorId: input.executor.id,
					executorSessionId: null,
					externalSessionKey: null,
					runId: input.runId ?? null,
					runtimeState: "running",
					outcome: null,
					attemptNumber: fake.workAttemptRows.length + 1,
					startedAt,
					heartbeatAt: startedAt,
					expiresAt: input.expiresAt ?? null,
					finishedAt: null,
					summary: null,
					version: 1,
					metadata: input.metadata ?? {},
				} as WorkAttemptRow;
				fake.workAttemptRows.push(attempt);
				return { workItem, attempt, resumed: false };
			},
		),
		settleWorkItemAttempt: vi.fn(
			async (
				db: unknown,
				input: {
					attemptId: string;
					outcome: "succeeded" | "failed" | "cancelled";
					settledAt?: string;
					summary?: string;
				},
			) => {
				const fake = db as { workAttemptRows: WorkAttemptRow[] };
				const attempt = fake.workAttemptRows.find(
					(row) => row.id === input.attemptId,
				);
				if (!attempt)
					throw new Error(`Missing Work attempt ${input.attemptId}`);
				attempt.outcome = input.outcome;
				attempt.runtimeState =
					input.outcome === "succeeded"
						? "finished"
						: input.outcome === "failed"
							? "failed"
							: "cancelled";
				attempt.finishedAt = input.settledAt ?? new Date().toISOString();
				attempt.summary = input.summary ?? null;
				attempt.version += 1;
				return attempt;
			},
		),
	};
});

vi.mock("@tedix/db/queries/work-items/evidence", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@tedix/db/queries/work-items/evidence")
	>()),
	submitWorkItemEvidence: vi.fn(
		async (db: unknown, input: Record<string, any>) => {
			const fake = db as { workEvidenceRows: Array<Record<string, any>> };
			const evidence = {
				id: crypto.randomUUID(),
				attemptId: input.attemptId ?? null,
				claimKey: input.claimKey,
				digest: input.digest ?? null,
				disposition: "pending",
				kind: input.kind,
				metadata: input.metadata ?? {},
				uri: input.uri,
				workItemId: input.workItemId,
			};
			fake.workEvidenceRows.push(evidence);
			return evidence;
		},
	),
}));

vi.mock("@tedix/db/queries/work-items/projections", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@tedix/db/queries/work-items/projections")
	>()),
	listOrgWorkEvidence: vi.fn(
		async (db: unknown, input: Record<string, any>) => {
			const fake = db as {
				workEvidenceRows: Array<Record<string, any>>;
				workItemRows: WorkItemRow[];
			};
			return {
				data: fake.workEvidenceRows
					.filter(
						(row) =>
							row.workItemId === input.workItemId &&
							row.attemptId === input.attemptId,
					)
					.map((evidence) => ({
						evidence,
						workItem: fake.workItemRows.find(
							(item) => item.id === evidence.workItemId,
						),
					})),
				nextCursor: null,
				observedAt: new Date().toISOString(),
			};
		},
	),
}));

vi.mock("@tedix/db/queries/work-items/crud", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@tedix/db/queries/work-items/crud")
	>()),
	completeWorkItem: vi.fn(async (db: unknown, input: Record<string, any>) => {
		const fake = db as { workItemRows: WorkItemRow[] };
		const item = fake.workItemRows.find((row) => row.id === input.workItemId);
		if (!item) throw new Error(`Missing Work Item ${input.workItemId}`);
		item.disposition = "completed";
		return item;
	}),
}));

function tedixOsUnwrapStructuredPayload(output: unknown): unknown {
	if (typeof output !== "string") return null;
	let rest = output.trim();
	if (!rest) return null;
	let hadWrapper = false;
	const prefix = /^raw result\s*:\s*/i.exec(rest);
	if (prefix) {
		rest = rest.slice(prefix[0].length).trim();
		hadWrapper = true;
	}
	if (rest.startsWith("```")) {
		const fence =
			/^```[ \t]*(?:json|jsonc|json5)?[ \t]*\n([\s\S]*?)\n?```$/i.exec(rest);
		if (!fence) return null;
		rest = (fence[1] ?? "").trim();
		hadWrapper = true;
	} else {
		const inline = /^(`{1,2})([\s\S]*?)\1$/.exec(rest);
		if (inline) {
			rest = (inline[2] ?? "").trim();
			hadWrapper = true;
		}
	}
	if (!hadWrapper) return null;
	const first = rest[0];
	if (first !== "{" && first !== "[") return null;
	try {
		const parsed = JSON.parse(rest) as unknown;
		return parsed === null || typeof parsed !== "object" ? null : parsed;
	} catch {
		return null;
	}
}

describe("childRunPreview structured-result envelope (Tedix OS Phase D)", () => {
	const project = kernelRuntimeTestHooks.childRunPreviewFromEventsForTest;

	function toolCompletedRow(payload: Record<string, unknown> | null) {
		return childRuntimeEvent({
			createdAt: "2026-06-18T00:00:01.000Z",
			id: "child-tool-completed",
			kind: "tool.completed",
			payload,
			runId: "child-run-1",
			tediId: "tedi-cto",
		});
	}

	function messageCompletedRow(content: string) {
		return childRuntimeEvent({
			createdAt: "2026-06-18T00:00:02.000Z",
			id: "child-message-completed",
			kind: "message.completed",
			payload: { role: "assistant", content },
			runId: "child-run-1",
			tediId: "tedi-cto",
		});
	}

	it("prefers the child's prose final message over a structured tool.completed payload", () => {
		// The tedi's own conclusion is the operator-facing answer — an
		// intermediate tool payload (test results, discovery listing) must not
		// bury it. The structured envelope survives as evidence, not as the
		// message preview.
		const data = {
			passed: 12,
			failed: 1,
			skipped: 0,
			total: 13,
			failing: [{ name: "auth › rejects expired token", status: "failed" }],
		};
		// Rows are stored newest-first (desc createdAt), matching the reader.
		const preview = project(
			[
				messageCompletedRow("Ran the suite — see results."),
				toolCompletedRow({ data }),
			],
			"Ran the suite — see results.",
		);
		expect(preview).toBe("Ran the suite — see results.");
	});

	it("emits the canonical envelope for a structured tool.completed payload when the child produced no message", () => {
		const data = {
			passed: 12,
			failed: 1,
			skipped: 0,
			total: 13,
			failing: [{ name: "auth › rejects expired token", status: "failed" }],
		};
		const preview = project([toolCompletedRow({ data })], null);
		expect(preview).toBe(
			`Raw result: \`\`\`json\n${JSON.stringify(data)}\n\`\`\``,
		);
		// The exact envelope the Tedix OS consumer unwraps back to the structured value.
		expect(tedixOsUnwrapStructuredPayload(preview)).toEqual(data);
	});

	it("lights the card from an agent-runtime tool.completed `payload.result` JSON string (no `data`, no message)", () => {
		// The agent runtime's MCP-client emitter (`recordToolEvent`) carries the raw
		// tool output as a JSON string under `payload.result`, never `payload.data`
		// (verified against the prod ledger). The `data ?? result` fallback must light
		// the same canonical envelope so message-less delegated tool work is not dark.
		const data = {
			results: [{ id: "fact-1", summary: "Tedix ships autonomous workers" }],
			total: 1,
		};
		const preview = project(
			[
				toolCompletedRow({
					name: "tedix_mcp_code",
					result: JSON.stringify(data),
				}),
			],
			null,
		);
		expect(preview).toBe(
			`Raw result: \`\`\`json\n${JSON.stringify(data)}\n\`\`\``,
		);
		expect(tedixOsUnwrapStructuredPayload(preview)).toEqual(data);
	});

	it("emits the canonical envelope when the final assistant message IS structured JSON (plan card)", () => {
		const plan = {
			title: "Launch checklist",
			steps: [
				{ label: "Draft RFC", status: "completed" },
				{ label: "Ship canary", status: "in_progress" },
			],
		};
		const content = JSON.stringify(plan);
		const preview = project([messageCompletedRow(content)], content);
		expect(preview).toBe(`Raw result: \`\`\`json\n${content}\n\`\`\``);
		expect(tedixOsUnwrapStructuredPayload(preview)).toEqual(plan);
	});

	it("unwraps a fenced ```json final message into the canonical envelope", () => {
		const obj = { ok: true, count: 3 };
		const content = `\`\`\`json\n${JSON.stringify(obj, null, 2)}\n\`\`\``;
		const preview = project([messageCompletedRow(content)], content);
		expect(tedixOsUnwrapStructuredPayload(preview)).toEqual(obj);
	});

	it("keeps prose unchanged for a genuinely unstructured result — never fake JSON", () => {
		const prose = "I finished the assignment and shipped the canary.";
		const preview = project([messageCompletedRow(prose)], prose);
		expect(preview).toBe(prose);
		expect(tedixOsUnwrapStructuredPayload(preview)).toBeNull();
	});

	it("does not wrap a partial/malformed JSON-looking string", () => {
		const broken = '{"steps": [{"label": "Draft RFC"';
		const preview = project([messageCompletedRow(broken)], broken);
		expect(preview).toBe(broken);
		expect(tedixOsUnwrapStructuredPayload(preview)).toBeNull();
	});

	// ── Fix 1: DESC-mispick ────────────────────────────────────────────────────

	it("multi-tool DESC-mispick: picks the STRUCTURED earlier result, not the most-recent error", () => {
		// Rows are DESC-createdAt. The most-recent tool.completed is an error;
		// the earlier one is a structured object. Fix 1 must skip the error and
		// return the structured envelope — not the raw "Execution error:" string.
		const structuredData = {
			results: [{ id: "fact-1", summary: "Tedix ships autonomous workers" }],
			total: 1,
		};
		const errorRow = childRuntimeEvent({
			createdAt: "2026-06-18T00:00:03.000Z", // most recent
			id: "child-tool-error",
			kind: "tool.completed",
			payload: { name: "search", result: "Execution error: scope timeout" },
			runId: "child-run-multi",
			tediId: "tedi-cto",
		});
		const structuredRow = childRuntimeEvent({
			createdAt: "2026-06-18T00:00:02.000Z", // earlier
			id: "child-tool-structured",
			kind: "tool.completed",
			payload: {
				name: "memory_search",
				result: JSON.stringify(structuredData),
			},
			runId: "child-run-multi",
			tediId: "tedi-cto",
		});
		// DESC order: error row is first
		const preview = project([errorRow, structuredRow], null);
		expect(preview).toBe(
			`Raw result: \`\`\`json\n${JSON.stringify(structuredData)}\n\`\`\``,
		);
		expect(tedixOsUnwrapStructuredPayload(preview)).toEqual(structuredData);
	});

	it("tool-error-only run with no prose preview produces a humanized one-liner, not raw engine internals", () => {
		// All tool.completed rows are error strings, rawPreview is null.
		// The preview must be "Tool step errored: …", not the raw "Execution error:" string.
		const errorRow = childRuntimeEvent({
			createdAt: "2026-06-18T00:00:01.000Z",
			id: "child-tool-error-only",
			kind: "tool.completed",
			payload: {
				name: "exec",
				result:
					"Execution error: POST https://runtime.example/v1/run timed out after 30000ms",
			},
			runId: "child-run-error-only",
			tediId: "tedi-cto",
		});
		const preview = project([errorRow], null);
		expect(typeof preview).toBe("string");
		expect(preview).toMatch(/^Tool step errored:/);
		// Must not contain raw POST URL or Execution error prefix.
		expect(preview).not.toMatch(/^Execution error:/);
		expect(preview).not.toMatch(/POST https?:\/\//);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Fix 2 & 4: run.failed humanized preview + structured-tool hasSubstantive gate
// ─────────────────────────────────────────────────────────────────────────────

describe("summarizeChildRuntimeEvents legibility fixes", () => {
	// Fix 2: run.failed with runtime_dropped reason
	it("run.failed payload.reason='runtime_dropped' → humanized operator-facing preview", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db);
		const TEDI_ID = "tedi-cto";
		const RUN_ID = "child-run-dropped";
		db.runtimeEvents.push(
			childRuntimeEvent({
				createdAt: "2026-06-18T16:14:00.000Z",
				id: "child-run.failed-dropped",
				kind: "run.failed",
				payload: { reason: "runtime_dropped" },
				runId: RUN_ID,
				tediId: TEDI_ID,
			}),
		);
		const summary = await readSingleChildRunSummary(context, {
			tediId: TEDI_ID,
			runId: RUN_ID,
		});
		expect(summary).not.toBeNull();
		expect(summary?.childRunStatus).toBe("failed");
		// Preview must be the humanized string, not null or a raw payload dump.
		expect(summary?.childRunPreview).toBe(
			"The tedi runtime dropped this run before it finished — retry.",
		);
	});

	it("run.failed recovery_exhausted/out_of_memory → humanized operator-facing preview", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db);
		const TEDI_ID = "tedi-cto";
		const RUN_ID = "child-run-recovery-oom";
		db.runtimeEvents.push(
			childRuntimeEvent({
				createdAt: "2026-06-18T16:15:00.000Z",
				id: "child-run.failed-oom",
				kind: "run.failed",
				payload: {
					reason: "recovery_exhausted",
					error: "chat recovery exhausted: out_of_memory",
					recovery: { reason: "out_of_memory" },
				},
				runId: RUN_ID,
				tediId: TEDI_ID,
			}),
		);
		const summary = await readSingleChildRunSummary(context, {
			tediId: TEDI_ID,
			runId: RUN_ID,
		});
		expect(summary?.childRunStatus).toBe("failed");
		expect(summary?.childRunPreview).toBe(
			"The tedi exceeded the Durable Object memory limit while recovering this turn.",
		);
	});

	// Fix 2: run.failed with a message containing a raw POST URL
	it("run.failed with raw Cloudflare POST URL in message → stripped preview", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db);
		const TEDI_ID = "tedi-cto";
		const RUN_ID = "child-run-cf-error";
		db.runtimeEvents.push(
			childRuntimeEvent({
				createdAt: "2026-06-18T16:14:00.000Z",
				id: "child-run.failed-cf",
				kind: "run.failed",
				payload: {
					reason: "network_error",
					message:
						"Agent unreachable\nPOST https://agents.example/v1/dispatch\n503 Service Unavailable",
				},
				runId: RUN_ID,
				tediId: TEDI_ID,
			}),
		);
		const summary = await readSingleChildRunSummary(context, {
			tediId: TEDI_ID,
			runId: RUN_ID,
		});
		expect(summary?.childRunStatus).toBe("failed");
		const preview = summary?.childRunPreview as string;
		expect(preview).not.toMatch(/POST https?:\/\//);
		expect(preview).not.toMatch(/503/);
		expect(preview).toMatch(/Agent unreachable/);
	});

	// Fix 4: structured-tool-only success is not downgraded to "failed"
	it("structured-tool-only success (tool.completed object, no message.completed) → status=completed, hasSubstantive=true", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db);
		const TEDI_ID = "tedi-cto";
		const RUN_ID = "child-run-tool-only";
		const structuredData = { answer: 42, unit: "widgets" };
		db.runtimeEvents.push(
			childRuntimeEvent({
				createdAt: "2026-06-18T16:14:00.000Z",
				id: "child-run.completed",
				kind: "run.completed",
				runId: RUN_ID,
				tediId: TEDI_ID,
			}),
			childRuntimeEvent({
				createdAt: "2026-06-18T16:13:58.000Z",
				id: "child-tool-only",
				kind: "tool.completed",
				payload: { name: "compute", result: JSON.stringify(structuredData) },
				runId: RUN_ID,
				tediId: TEDI_ID,
			}),
		);
		const summary = await readSingleChildRunSummary(context, {
			tediId: TEDI_ID,
			runId: RUN_ID,
		});
		expect(summary).not.toBeNull();
		// Must not be downgraded to "failed" by the disposition gate.
		expect(summary?.childRunStatus).toBe("completed");
		// Preview must be the structured envelope.
		const preview = summary?.childRunPreview as string;
		expect(preview).toMatch(/^Raw result:/);
		expect(tedixOsUnwrapStructuredPayload(preview)).toEqual(structuredData);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// latestActivityLabel — live-panel "calling <tool>" surface
// ─────────────────────────────────────────────────────────────────────────────

describe("summarizeChildRuntimeEvents — latestActivityLabel (CLI live panel)", () => {
	const TEDI_ID = "tedi-cto";
	const RUN_ID = "child-run-activity";

	it("tool.started as latest event → childRunLatestActivityLabel='calling <tool>'", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db);
		// DESC order: tool.started is the most recent event (run still in-flight).
		db.runtimeEvents.push(
			childRuntimeEvent({
				createdAt: "2026-06-22T10:00:02.000Z",
				id: "child-tool-started",
				kind: "tool.started",
				payload: { name: "workers_builds_list_builds", arguments: {} },
				runId: RUN_ID,
				tediId: TEDI_ID,
			}),
			childRuntimeEvent({
				createdAt: "2026-06-22T10:00:00.000Z",
				id: "child-run-started",
				kind: "run.started",
				runId: RUN_ID,
				tediId: TEDI_ID,
			}),
		);
		const summary = await readSingleChildRunSummary(context, {
			tediId: TEDI_ID,
			runId: RUN_ID,
		});
		expect(summary).not.toBeNull();
		expect(summary?.childRunLatestActivityLabel).toBe(
			"calling workers_builds_list_builds",
		);
	});

	it("tool.completed as latest event → childRunLatestActivityLabel='calling <tool>'", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db);
		db.runtimeEvents.push(
			childRuntimeEvent({
				createdAt: "2026-06-22T10:00:03.000Z",
				id: "child-tool-completed",
				kind: "tool.completed",
				payload: { name: "firecrawl_scrape", result: "done", latencyMs: 800 },
				runId: RUN_ID,
				tediId: TEDI_ID,
			}),
			childRuntimeEvent({
				createdAt: "2026-06-22T10:00:00.000Z",
				id: "child-run-started-2",
				kind: "run.started",
				runId: RUN_ID,
				tediId: TEDI_ID,
			}),
		);
		const summary = await readSingleChildRunSummary(context, {
			tediId: TEDI_ID,
			runId: RUN_ID,
		});
		expect(summary).not.toBeNull();
		expect(summary?.childRunLatestActivityLabel).toBe(
			"calling firecrawl_scrape",
		);
	});

	it("message.delta as latest event → childRunLatestActivityLabel='responding…'", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db);
		db.runtimeEvents.push(
			childRuntimeEvent({
				createdAt: "2026-06-22T10:00:04.000Z",
				delta: "The deploy run shows…",
				id: "child-msg-delta",
				kind: "message.delta",
				runId: RUN_ID,
				tediId: TEDI_ID,
			}),
			childRuntimeEvent({
				createdAt: "2026-06-22T10:00:00.000Z",
				id: "child-run-started-3",
				kind: "run.started",
				runId: RUN_ID,
				tediId: TEDI_ID,
			}),
		);
		const summary = await readSingleChildRunSummary(context, {
			tediId: TEDI_ID,
			runId: RUN_ID,
		});
		expect(summary).not.toBeNull();
		expect(summary?.childRunLatestActivityLabel).toBe("responding…");
	});

	it("run.started → childRunLatestActivityLabel='thinking…' (widened Part B)", async () => {
		// After Part B widening, run.started maps to "thinking…" instead of null.
		// This pins the new correct behavior so regressions are caught.
		const db = createKernelRuntimeDb();
		const context = createContext(db);
		db.runtimeEvents.push(
			childRuntimeEvent({
				createdAt: "2026-06-22T10:00:00.000Z",
				id: "child-run-started-4",
				kind: "run.started",
				runId: RUN_ID,
				tediId: TEDI_ID,
			}),
		);
		const summary = await readSingleChildRunSummary(context, {
			tediId: TEDI_ID,
			runId: RUN_ID,
		});
		expect(summary).not.toBeNull();
		expect(summary?.childRunLatestActivityLabel).toBe("thinking…");
	});

	it("running run with tool.started → progress.detail='calling <tool>' (not event count)", async () => {
		const db = createKernelRuntimeDb();
		const RUN_ROW_ID = "home-run-with-child";
		const CHILD_TEDI = "tedi-cto-agent";
		// Seed a kernel run row that delegates to CHILD_TEDI / RUN_ID.
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: RUN_ROW_ID,
				organizationId: ORG_ID,
				conversationId: "home:test",
				status: "running",
				delegatedTediId: CHILD_TEDI,
				childRunId: RUN_ID,
				createdAt: "2026-06-22T10:00:00.000Z",
				updatedAt: "2026-06-22T10:00:02.000Z",
			}),
		);
		// Seed child runtime events: run.started then tool.started (tool.started is
		// the most recent — rows are stored in insertion order but the query is DESC
		// by createdAt, so push latest createdAt last and let the mock sort them).
		db.runtimeEvents.push(
			childRuntimeEvent({
				createdAt: "2026-06-22T10:00:00.000Z",
				id: "child-run-started-progress",
				kind: "run.started",
				runId: RUN_ID,
				tediId: CHILD_TEDI,
			}),
			childRuntimeEvent({
				createdAt: "2026-06-22T10:00:02.000Z",
				id: "child-tool-started-progress",
				kind: "tool.started",
				payload: { name: "workers_builds_list_builds", arguments: {} },
				runId: RUN_ID,
				tediId: CHILD_TEDI,
			}),
		);
		const client = createKernelRuntimeClient(createContext(db));
		const result = await client.readRunSet({
			conversationId: "home:test",
			limit: 10,
		});
		const run = result.runSet.runs.find((r) => r.id === RUN_ROW_ID);
		expect(run).not.toBeUndefined();
		// The live-panel reads progress.detail as the activity string.
		// It must show "calling workers_builds_list_builds", not "2 runtime events recorded".
		expect(run?.progress.detail).toBe("calling workers_builds_list_builds");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// latestActivityLabelFromEventsForTest — direct unit tests for Part B widened
// event kinds. Tests the new labels that were not previously matched:
//   run.started → "thinking…"
//   context.injected → "loading context…"
//   artifact.created → "writing <name>"
//   subagent.started → "delegating…"
//   message.completed (no run.completed yet) → "wrapping up…"
// ─────────────────────────────────────────────────────────────────────────────

describe("latestActivityLabelFromEvents — widened Part B event kinds", () => {
	const fn = kernelRuntimeTestHooks.latestActivityLabelFromEventsForTest;

	function makeEvent(
		kind: string,
		payload?: Record<string, unknown>,
	): (typeof import("@tedix/db/schema"))["tediRuntimeEvents"]["$inferSelect"] {
		return {
			id: `evt-${kind}`,
			tediId: "tedi-cto",
			runId: "run-1",
			organizationId: "org-1",
			conversationId: "home:main",
			kind: kind as Parameters<typeof fn>[0][number]["kind"],
			payload: payload ?? null,
			delta: null,
			messageId: null,
			createdAt: "2026-06-22T10:00:00.000Z",
			runtime: null,
			runtimeMetadata: null,
		} as Parameters<typeof fn>[0][number];
	}

	it("run.started as latest event → 'thinking…'", () => {
		expect(fn([makeEvent("run.started")])).toBe("thinking…");
	});

	it("context.injected as latest event → 'loading context…'", () => {
		expect(fn([makeEvent("context.injected")])).toBe("loading context…");
	});

	it("artifact.created with named payload → 'writing <name>'", () => {
		expect(
			fn([
				makeEvent("artifact.created", { artifact: { name: "turn_summary" } }),
			]),
		).toBe("writing turn_summary");
	});

	it("artifact.created with long name → truncated to 35 chars with ellipsis", () => {
		const longName = "a".repeat(40);
		const result = fn([
			makeEvent("artifact.created", { artifact: { name: longName } }),
		]);
		expect(result).toBe(`writing ${"a".repeat(35)}…`);
	});

	it("artifact.created with no name in payload → 'writing artifact' fallback", () => {
		expect(fn([makeEvent("artifact.created", {})])).toBe("writing artifact");
	});

	it("subagent.started as latest event → 'delegating…'", () => {
		expect(fn([makeEvent("subagent.started")])).toBe("delegating…");
	});

	it("message.completed as latest event → 'wrapping up…'", () => {
		// message.completed before any run.completed = the run is still settling.
		expect(fn([makeEvent("message.completed", { content: "Done." })])).toBe(
			"wrapping up…",
		);
	});

	it("message.received as latest event → 'reading the task'", () => {
		expect(fn([makeEvent("message.received")])).toBe("reading the task");
	});

	it("message.progress as latest event → 'synthesizing…' (T1.1 heartbeat)", () => {
		// The T1.1 mid-round heartbeat emits message.progress while the model is
		// composing its reply (post-tool, pre-message.delta). The live panel must
		// read "synthesizing…" instead of freezing on the last tool name.
		expect(fn([makeEvent("message.progress", { round: 1 })])).toBe(
			"synthesizing…",
		);
	});

	it("tool.started newer than message.progress — tool.started wins (still 'calling')", () => {
		// Heartbeat must not override an actively-running tool: DESC order, newest
		// (tool.started) matches first.
		expect(
			fn([
				makeEvent("tool.started", { name: "firecrawl_scrape" }),
				makeEvent("message.progress", { round: 1 }),
			]),
		).toBe("calling firecrawl_scrape");
	});

	it("run.started older than tool.started — tool.started wins (DESC order, first match)", () => {
		// In DESC order (newest first): tool.started (t=2) is before run.started (t=1).
		expect(
			fn([
				makeEvent("tool.started", { name: "firecrawl_scrape" }),
				makeEvent("run.started"),
			]),
		).toBe("calling firecrawl_scrape");
	});

	it("only run.completed present (terminal run) → null (run is done, no in-progress label)", () => {
		// run.completed is not in the widened set, so it falls through to null.
		expect(fn([makeEvent("run.completed")])).toBeNull();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// readSingleChildRunSummary — crash-lease sweep self-heal
// ─────────────────────────────────────────────────────────────────────────────

describe("readSingleChildRunSummary", () => {
	const TEDI_ID = "tedi-cto";
	const CHILD_RUN_ID = "child-run-1";

	it("returns completed summary when child has a run.completed event with substantive content", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db);
		db.runtimeEvents.push(
			childRuntimeEvent({
				createdAt: "2026-06-18T16:14:00.000Z",
				id: "child-run.completed",
				kind: "run.completed",
				runId: CHILD_RUN_ID,
				tediId: TEDI_ID,
			}),
			childRuntimeEvent({
				createdAt: "2026-06-18T16:13:50.000Z",
				id: "child-msg.completed",
				kind: "message.completed",
				delta: "Firecrawl scrape completed — 12 pages extracted.",
				runId: CHILD_RUN_ID,
				tediId: TEDI_ID,
			}),
		);
		const summary = await readSingleChildRunSummary(context, {
			tediId: TEDI_ID,
			runId: CHILD_RUN_ID,
		});
		expect(summary).not.toBeNull();
		expect(summary?.childRunStatus).toBe("completed");
		expect(typeof summary?.childRunPreview).toBe("string");
		expect(
			(summary?.childRunPreview as string | undefined)?.length,
		).toBeGreaterThan(0);
	});

	it("keeps a workstation subprocess artifact non-terminal when run.completed is missing", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db);
		db.runtimeEvents.push(
			childRuntimeEvent({
				createdAt: "2026-06-18T16:14:00.000Z",
				id: "child-artifact-terminal",
				kind: "artifact.created",
				payload: {
					artifact: {
						name: "workstation_process/install/evidence.json",
						metadata: {
							source: "workstation_process",
							processId: "install",
							eventType: "workstation.process.completed",
							exitCode: 0,
						},
					},
				},
				runId: CHILD_RUN_ID,
				tediId: TEDI_ID,
			}),
			childRuntimeEvent({
				createdAt: "2026-06-18T16:13:00.000Z",
				id: "child-run.started",
				kind: "run.started",
				runId: CHILD_RUN_ID,
				tediId: TEDI_ID,
			}),
		);
		const summary = await readSingleChildRunSummary(context, {
			tediId: TEDI_ID,
			runId: CHILD_RUN_ID,
		});
		expect(summary).toMatchObject({
			childRunStatus: "running",
			childRunLatestEventKind: "artifact.created",
			childRunTerminalAt: null,
			childRunTerminalEventKind: null,
		});
		expect(summary?.childRunPreview).toContain("process install completed");
	});

	it("returns failed summary when child has a run.completed event but NO substantive content (disposition gate)", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db);
		db.runtimeEvents.push(
			childRuntimeEvent({
				createdAt: "2026-06-18T16:14:00.000Z",
				id: "child-bare-completed",
				kind: "run.completed",
				runId: CHILD_RUN_ID,
				tediId: TEDI_ID,
			}),
		);
		const summary = await readSingleChildRunSummary(context, {
			tediId: TEDI_ID,
			runId: CHILD_RUN_ID,
		});
		expect(summary).not.toBeNull();
		// Disposition gate: bare run.completed with no substantive result is "failed",
		// so the crash-terminalization branch should not self-heal to completed.
		expect(summary?.childRunStatus).toBe("failed");
	});

	it("returns failed summary when child has a run.failed event", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db);
		db.runtimeEvents.push(
			childRuntimeEvent({
				createdAt: "2026-06-18T16:14:00.000Z",
				id: "child-run.failed",
				kind: "run.failed",
				runId: CHILD_RUN_ID,
				tediId: TEDI_ID,
			}),
		);
		const summary = await readSingleChildRunSummary(context, {
			tediId: TEDI_ID,
			runId: CHILD_RUN_ID,
		});
		expect(summary?.childRunStatus).toBe("failed");
	});

	it("returns null when the child has no events", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db);
		const summary = await readSingleChildRunSummary(context, {
			tediId: TEDI_ID,
			runId: CHILD_RUN_ID,
		});
		expect(summary).toBeNull();
	});

	it("fail-soft: returns null on DB error", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db);
		db.controls.childRuntimeSelectError = new Error("D1 unavailable");
		const summary = await readSingleChildRunSummary(context, {
			tediId: TEDI_ID,
			runId: CHILD_RUN_ID,
		});
		expect(summary).toBeNull();
	});
});

describe("explicitDelegationNeedsEmbodiedSurface (native-vs-workstation gate)", () => {
	it("defaults to NATIVE when no embodiment signal is present", () => {
		// A plain operator delegation ("report git HEAD", a remote-MCP read) carries
		// only `source`/`operator` metadata — no embodied need. Must stay native.
		expect(explicitDelegationNeedsEmbodiedSurface(undefined)).toBe(false);
		expect(explicitDelegationNeedsEmbodiedSurface(null)).toBe(false);
		expect(
			explicitDelegationNeedsEmbodiedSurface({
				source: "os.home",
				operator: { id: "u1", email: "operator@example.com" },
			}),
		).toBe(false);
	});

	it("requires the embodied surface when the caller stamps an explicit signal", () => {
		expect(
			explicitDelegationNeedsEmbodiedSurface({ needsEmbodiedSurface: true }),
		).toBe(true);
		expect(
			explicitDelegationNeedsEmbodiedSurface({ requireWorkstation: true }),
		).toBe(true);
		// Mirrors the kernel route vocabulary verbatim.
		expect(
			explicitDelegationNeedsEmbodiedSurface({ effortClass: "embodied" }),
		).toBe(true);
	});

	it("treats non-embodied effort classes as native", () => {
		for (const effortClass of ["single_read", "multi_hop_read", "fan_out"]) {
			expect(explicitDelegationNeedsEmbodiedSurface({ effortClass })).toBe(
				false,
			);
		}
	});

	it("ignores truthy-but-not-true and malformed signals (fail to native)", () => {
		// Only a strict boolean `true` flips the gate — a string "true" or a
		// non-object metadata must not accidentally lease a workstation.
		expect(
			explicitDelegationNeedsEmbodiedSurface({ needsEmbodiedSurface: "true" }),
		).toBe(false);
		expect(
			explicitDelegationNeedsEmbodiedSurface({ requireWorkstation: 1 }),
		).toBe(false);
		expect(explicitDelegationNeedsEmbodiedSurface("embodied")).toBe(false);
		expect(
			explicitDelegationNeedsEmbodiedSurface([{ effortClass: "embodied" }]),
		).toBe(false);
	});
});

describe("buildFanoutChildNodes", () => {
	it("builds nodes for live slots with queued status", () => {
		const nodes = buildFanoutChildNodes({
			homeRunId: "home-run-1",
			conversationId: "home:main",
			delegatedTediId: "tedi-cto",
			liveSlots: [
				{
					id: "parent-run-1:fanout:tedi-cto:fanout:child-1",
					childRunId: "tedi-cto:fanout:child-1",
					ownerTediId: "tedi-cto",
					ownerSlug: "cto",
					ownerLabel: "Summarize page",
					objective: "Summarize the product page",
					status: "queued",
					dispatchedAt: "2026-06-22T10:00:00Z",
				},
				{
					id: "parent-run-1:fanout:tedi-cto:fanout:child-2",
					childRunId: "tedi-cto:fanout:child-2",
					ownerTediId: "tedi-cto",
					ownerSlug: "cto",
					ownerLabel: "Analyze competitors",
					objective: "Analyze competitor data",
					status: "queued",
					dispatchedAt: "2026-06-22T10:00:01Z",
				},
			],
			terminalByRunId: new Map(),
		});
		expect(nodes).toHaveLength(2);
		expect(nodes[0]).toMatchObject({
			id: "fanout:tedi-cto:tedi-cto:fanout:child-1",
			homeRunId: "home-run-1",
			delegatedTediId: "tedi-cto",
			childRunId: "tedi-cto:fanout:child-1",
			status: "queued",
			active: true,
			depth: 1,
			children: [],
		});
	});

	it("upgrades live-slot status from D1 terminal evidence", () => {
		const terminalByRunId = new Map<
			string,
			"completed" | "failed" | "canceled"
		>([["tedi-cto:fanout:child-1", "completed"]]);
		const nodes = buildFanoutChildNodes({
			homeRunId: "home-run-1",
			conversationId: "home:main",
			delegatedTediId: "tedi-cto",
			liveSlots: [
				{
					id: "parent-run-1:fanout:tedi-cto:fanout:child-1",
					childRunId: "tedi-cto:fanout:child-1",
					ownerTediId: "tedi-cto",
					ownerSlug: "cto",
					ownerLabel: "Task A",
					objective: "Do task A",
					status: "queued",
					dispatchedAt: "2026-06-22T10:00:00Z",
				},
			],
			terminalByRunId,
		});
		expect(nodes[0]?.status).toBe("completed");
		expect(nodes[0]?.active).toBe(false);
	});

	it("includes terminal runs not in live slots (already cleared from DO)", () => {
		const terminalByRunId = new Map<
			string,
			"completed" | "failed" | "canceled"
		>([
			["tedi-cto:fanout:child-done-1", "completed"],
			["tedi-cto:fanout:child-done-2", "failed"],
		]);
		const nodes = buildFanoutChildNodes({
			homeRunId: "home-run-1",
			conversationId: "home:main",
			delegatedTediId: "tedi-cto",
			liveSlots: [],
			terminalByRunId,
		});
		expect(nodes).toHaveLength(2);
		const done = nodes.find(
			(n) => n.childRunId === "tedi-cto:fanout:child-done-1",
		);
		const failed = nodes.find(
			(n) => n.childRunId === "tedi-cto:fanout:child-done-2",
		);
		expect(done?.status).toBe("completed");
		expect(failed?.status).toBe("failed");
	});

	it("deduplicates childRunId appearing in both slots and terminal map", () => {
		const terminalByRunId = new Map<
			string,
			"completed" | "failed" | "canceled"
		>([["tedi-cto:fanout:child-dup", "completed"]]);
		const nodes = buildFanoutChildNodes({
			homeRunId: "home-run-1",
			conversationId: "home:main",
			delegatedTediId: "tedi-cto",
			liveSlots: [
				{
					id: "parent-run-1:fanout:tedi-cto:fanout:child-dup",
					childRunId: "tedi-cto:fanout:child-dup",
					ownerTediId: "tedi-cto",
					ownerSlug: "cto",
					ownerLabel: "Dup",
					objective: "dup",
					status: "queued",
					dispatchedAt: null,
				},
			],
			terminalByRunId,
		});
		// slot took priority; terminal map should not add a second node
		expect(nodes).toHaveLength(1);
		expect(nodes[0]?.status).toBe("completed");
	});

	it("returns [] when no slots and no terminal runs", () => {
		const nodes = buildFanoutChildNodes({
			homeRunId: "home-run-1",
			conversationId: "home:main",
			delegatedTediId: "tedi-cto",
			liveSlots: [],
			terminalByRunId: new Map(),
		});
		expect(nodes).toHaveLength(0);
	});
});

describe("augmentTreeWithFanoutChildren", () => {
	it("returns the base tree unchanged when there are no active delegation nodes", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db);
		const tree = {
			organizationId: ORG_ID,
			conversationId: "home:main",
			nodes: [],
			activeNodeId: null,
			updatedAt: null,
		};
		const result = await augmentTreeWithFanoutChildren(context, tree, []);
		expect(result).toBe(tree); // same reference — no work done
	});

	it("returns the base tree unchanged when delegation node is terminal", async () => {
		const db = createKernelRuntimeDb();
		const context = createContext(db);
		const tree = {
			organizationId: ORG_ID,
			conversationId: "home:main",
			nodes: [
				{
					id: "child:tedi-cto:child-run-1",
					homeRunId: "home-run-1",
					conversationId: "home:main",
					delegatedTediId: "tedi-cto",
					childRunId: "child-run-1",
					parentRunId: null,
					label: "cto",
					status: "completed" as const,
					active: false,
					depth: 0,
					updatedAt: null,
					children: [],
				},
			],
			activeNodeId: null,
			updatedAt: null,
		};
		const result = await augmentTreeWithFanoutChildren(context, tree, []);
		// Terminal node → not augmented → tree unchanged
		expect(result).toBe(tree);
	});

	it("returns base tree when no service-binding fetcher (test env) — fail-soft", async () => {
		const db = createKernelRuntimeDb();
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: "home-run-1",
				organizationId: ORG_ID,
				conversationId: "home:fanout",
				status: "running",
				delegatedTediId: "tedi-cto",
				childRunId: "child-run-1",
				metadata: { delegatedTediSlug: "cto" },
				createdAt: "2026-06-22T10:00:00.000Z",
				updatedAt: "2026-06-22T10:00:00.000Z",
			}),
		);
		const context = createContext(db);
		// No TEDI_SERVICE in context.env → config.fetcher is undefined → fail-soft → []
		const tree = {
			organizationId: ORG_ID,
			conversationId: "home:fanout",
			nodes: [
				{
					id: "child:tedi-cto:child-run-1",
					homeRunId: "home-run-1",
					conversationId: "home:fanout",
					delegatedTediId: "tedi-cto",
					childRunId: "child-run-1",
					parentRunId: null,
					label: "cto",
					status: "running" as const,
					active: true,
					depth: 0,
					updatedAt: null,
					children: [],
				},
			],
			activeNodeId: "child:tedi-cto:child-run-1",
			updatedAt: null,
		};
		const result = await augmentTreeWithFanoutChildren(context, tree, db.runs);
		// No fetcher → readFanoutSlotsForNode returns [] → no D1 fanout events →
		// children stays [] → tree returned unchanged
		expect(result.nodes[0]?.children).toHaveLength(0);
	});

	it("readChildRunTree: existing delegation node still has children: [] when no fanout slots", async () => {
		const db = createKernelRuntimeDb();
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: "home-run-1",
				organizationId: ORG_ID,
				conversationId: "home:tree",
				status: "running",
				delegatedTediId: "tedi-cto",
				childRunId: "child-run-1",
				metadata: { delegatedTediSlug: "cto", childRunStatus: "running" },
				createdAt: "2026-06-06T08:00:00.000Z",
				updatedAt: "2026-06-06T08:01:00.000Z",
			}),
		);
		const client = createKernelRuntimeClient(createContext(db));
		const result = await client.readChildRunTree({
			conversationId: "home:tree",
		});
		expect(result.tree).toMatchObject({
			conversationId: "home:tree",
			activeNodeId: "child:tedi-cto:child-run-1",
			nodes: [
				{
					id: "child:tedi-cto:child-run-1",
					homeRunId: "home-run-1",
					delegatedTediId: "tedi-cto",
					childRunId: "child-run-1",
					label: "cto",
					status: "running",
					active: true,
					children: [],
				},
			],
		});
	});

	it("omits approvalMirrors when the rebuildable approval projection read fails", async () => {
		const db = createKernelRuntimeDb();
		db.runs.push(
			normalizeKernelRuntimeRunInsert({
				id: "home-approval-projection-failure",
				organizationId: ORG_ID,
				conversationId: "home:approval-projection-failure",
				status: "running",
				createdAt: "2026-07-22T19:00:00.000Z",
				updatedAt: "2026-07-22T19:00:00.000Z",
			}),
		);

		// The focused router fake intentionally has no approval-mirror table;
		// listActiveKernelApprovalMirrors therefore throws, exercising readRunSet's
		// fail-soft projection path without suppressing canonical run data.
		const result = await createKernelRuntimeClient(
			createContext(db),
		).readRunSet({
			conversationId: "home:approval-projection-failure",
		});

		expect(result.runSet.runs).toHaveLength(1);
		expect(result.runSet).not.toHaveProperty("approvalMirrors");
	});
});
