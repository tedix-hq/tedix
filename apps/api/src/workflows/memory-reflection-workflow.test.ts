/**
 * Reflection projection checkpoints and capability-flywheel distillation.
 * Unit coverage for the input-shaping
 * helpers exported from the reflection workflow: per-tedi evidence grouping
 * (threshold, sample cap, id resolution), the distill/skip decision (evidence
 * floor + nightly refresh gate), objective extraction/truncation, prompt
 * shape, and the model-output sanitizer. The Workflow class itself is not
 * exercised directly; the projection runner uses a durable-step test double
 * (`cloudflare:workers` is mocked so the module loads under
 * plain-node vitest); the storage helpers have their own node:sqlite tests in
 * packages/db.
 */

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tedix/db/queries/memory-graph/facts", () => ({
	getFactById: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
	WorkflowEntrypoint: class {},
}));

import type { WorkflowStep } from "cloudflare:workers";
import { getFactById } from "@tedix/db/queries/memory-graph/facts";

import {
	reconcileReflectedMemory,
	reflectionAutoLinkScope,
	runOptionalGraphLinking,
	buildCapabilityDistillationPrompt,
	buildCapabilityEvidenceLines,
	CAPABILITY_DESCRIPTION_MAX_CHARS,
	CAPABILITY_DISTILL_EVIDENCE_ROW_CAP,
	CAPABILITY_DISTILL_MIN_EVIDENCE,
	CAPABILITY_DISTILL_OBJECTIVE_CHARS,
	CAPABILITY_DISTILL_REFRESH_HOURS,
	type CapabilityEvidenceEvalRow,
	extractDelegationObjective,
	groupCapabilityEvidence,
	sanitizeLearnedDescription,
	shouldDistillTediCapability,
	summarizeConsolidationTransitions,
	truncateObjective,
} from "./memory-reflection-workflow";

const NOW_MS = Date.parse("2026-07-07T00:00:00.000Z");

function evalRow(
	overrides: Partial<CapabilityEvidenceEvalRow> = {},
): CapabilityEvidenceEvalRow {
	return {
		tediId: "tedi-1",
		passed: true,
		metadata: { delegatedTediId: "tedi-1", runId: "run-1" },
		...overrides,
	};
}

describe("groupCapabilityEvidence", () => {
	it("groups by metadata.delegatedTediId with full counts and runId samples", () => {
		const grouped = groupCapabilityEvidence([
			evalRow({ metadata: { delegatedTediId: "tedi-a", runId: "run-1" } }),
			evalRow({
				passed: false,
				metadata: { delegatedTediId: "tedi-a", runId: "run-2" },
			}),
			evalRow({ metadata: { delegatedTediId: "tedi-b", runId: "run-3" } }),
		]);

		expect(grouped.size).toBe(2);
		expect(grouped.get("tedi-a")).toEqual({
			tediId: "tedi-a",
			passed: 1,
			total: 2,
			samples: [
				{ runId: "run-1", passed: true },
				{ runId: "run-2", passed: false },
			],
		});
		expect(grouped.get("tedi-b")?.total).toBe(1);
	});

	it("falls back to the row tediId and drops rows with no resolvable tedi", () => {
		const grouped = groupCapabilityEvidence([
			evalRow({ tediId: "tedi-row", metadata: { runId: "run-1" } }),
			evalRow({ tediId: null, metadata: null }),
		]);
		expect([...grouped.keys()]).toEqual(["tedi-row"]);
	});

	it("caps samples at the evidence row cap while counting ALL outcomes", () => {
		const rows = Array.from({ length: 30 }, (_, i) =>
			evalRow({
				passed: i % 2 === 0,
				metadata: { delegatedTediId: "tedi-a", runId: `run-${i}` },
			}),
		);
		const evidence = groupCapabilityEvidence(rows).get("tedi-a")!;
		expect(evidence.total).toBe(30);
		expect(evidence.passed).toBe(15);
		expect(evidence.samples).toHaveLength(CAPABILITY_DISTILL_EVIDENCE_ROW_CAP);
		// Newest-first input order is preserved in the sample.
		expect(evidence.samples[0]).toEqual({ runId: "run-0", passed: true });
	});

	it("tolerates a non-string runId (sample keeps null)", () => {
		const evidence = groupCapabilityEvidence([
			evalRow({ metadata: { delegatedTediId: "tedi-a", runId: 42 } }),
		]).get("tedi-a")!;
		expect(evidence.samples).toEqual([{ runId: null, passed: true }]);
	});
});

describe("shouldDistillTediCapability", () => {
	it("skips under the evidence floor", () => {
		expect(
			shouldDistillTediCapability({
				total: CAPABILITY_DISTILL_MIN_EVIDENCE - 1,
				existingUpdatedAt: null,
				nowMs: NOW_MS,
			}),
		).toBe(false);
	});

	it("distills at the floor when never distilled before", () => {
		expect(
			shouldDistillTediCapability({
				total: CAPABILITY_DISTILL_MIN_EVIDENCE,
				existingUpdatedAt: null,
				nowMs: NOW_MS,
			}),
		).toBe(true);
	});

	it("skips a profile refreshed within the nightly window (idempotent per night)", () => {
		const oneHourAgo = new Date(NOW_MS - 60 * 60 * 1000).toISOString();
		expect(
			shouldDistillTediCapability({
				total: 10,
				existingUpdatedAt: oneHourAgo,
				nowMs: NOW_MS,
			}),
		).toBe(false);
	});

	it("refreshes a stale profile and treats unparsable timestamps as stale", () => {
		const staleMs =
			NOW_MS - (CAPABILITY_DISTILL_REFRESH_HOURS + 1) * 60 * 60 * 1000;
		expect(
			shouldDistillTediCapability({
				total: 10,
				existingUpdatedAt: new Date(staleMs).toISOString(),
				nowMs: NOW_MS,
			}),
		).toBe(true);
		expect(
			shouldDistillTediCapability({
				total: 10,
				existingUpdatedAt: "not-a-date",
				nowMs: NOW_MS,
			}),
		).toBe(true);
	});
});

describe("extractDelegationObjective", () => {
	it("reads homeDelegation.workOrder.objective", () => {
		expect(
			extractDelegationObjective({
				homeDelegation: {
					workOrder: { objective: "  Audit the deploy pipeline  " },
				},
			}),
		).toBe("Audit the deploy pipeline");
	});

	it("returns null for missing/malformed nesting", () => {
		expect(extractDelegationObjective(null)).toBeNull();
		expect(extractDelegationObjective({})).toBeNull();
		expect(
			extractDelegationObjective({ homeDelegation: "not-an-object" }),
		).toBeNull();
		expect(
			extractDelegationObjective({
				homeDelegation: { workOrder: { objective: "   " } },
			}),
		).toBeNull();
	});
});

describe("truncateObjective", () => {
	it("collapses whitespace and passes short objectives through", () => {
		expect(truncateObjective("check   the\n  logs")).toBe("check the logs");
	});

	it("caps long objectives with an ellipsis at the char budget", () => {
		const long = "x".repeat(400);
		const truncated = truncateObjective(long);
		expect(truncated.length).toBeLessThanOrEqual(
			CAPABILITY_DISTILL_OBJECTIVE_CHARS,
		);
		expect(truncated.endsWith("…")).toBe(true);
	});
});

describe("buildCapabilityEvidenceLines", () => {
	it("renders PASS/FAIL lines and skips entries with no objective", () => {
		expect(
			buildCapabilityEvidenceLines([
				{ objective: "ship the weekly report", passed: true },
				{ objective: null, passed: true },
				{ objective: "  ", passed: false },
				{ objective: "rotate the API keys", passed: false },
			]),
		).toEqual([
			"- PASS: ship the weekly report",
			"- FAIL: rotate the API keys",
		]);
	});
});

describe("buildCapabilityDistillationPrompt", () => {
	it("renders the bounded prompt block", () => {
		const prompt = buildCapabilityDistillationPrompt({
			tediName: "CTO",
			passed: 4,
			total: 5,
			lines: ["- PASS: ship the weekly report", "- FAIL: rotate the API keys"],
		});
		expect(prompt).toContain("Worker: CTO");
		expect(prompt).toContain("4/5 delegated objectives passed");
		expect(prompt).toContain(
			"Graded delegations (newest first):\n- PASS: ship the weekly report\n- FAIL: rotate the API keys",
		);
	});
});

describe("sanitizeLearnedDescription", () => {
	it("collapses model output to single-line prose", () => {
		expect(
			sanitizeLearnedDescription(
				"  Reliably ships research objectives.\nFails at destructive writes.  ",
			),
		).toBe("Reliably ships research objectives. Fails at destructive writes.");
	});

	it("strips code fences and symmetric quote wrappers", () => {
		expect(sanitizeLearnedDescription('```text\n"Solid at reads."\n```')).toBe(
			"Solid at reads.",
		);
	});

	it("returns null for empty/whitespace/non-string output", () => {
		expect(sanitizeLearnedDescription("")).toBeNull();
		expect(sanitizeLearnedDescription("   ")).toBeNull();
		expect(sanitizeLearnedDescription(null)).toBeNull();
		expect(sanitizeLearnedDescription(undefined)).toBeNull();
	});

	it("caps runaway output at the stored-description budget", () => {
		const out = sanitizeLearnedDescription("word ".repeat(500));
		expect(out).not.toBeNull();
		expect(out!.length).toBeLessThanOrEqual(CAPABILITY_DESCRIPTION_MAX_CHARS);
		expect(out!.endsWith("…")).toBe(true);
	});
});

describe("summarizeConsolidationTransitions (quota)", () => {
	it("counts promote/merge/archive transitions, folding expired probation into archived", () => {
		const transitions = summarizeConsolidationTransitions({
			probationPromoted: 3,
			duplicatesMerged: 2,
			factsArchived: 4,
			probationExpired: 5,
		});
		expect(transitions).toEqual({
			promoted: 3,
			demoted: 0,
			merged: 2,
			archived: 9,
			total: 14,
		});
	});

	it("reports zero transitions for an append-only run (quota-failing shape)", () => {
		const transitions = summarizeConsolidationTransitions({
			probationPromoted: 0,
			duplicatesMerged: 0,
			factsArchived: 0,
			probationExpired: 0,
		});
		expect(transitions.total).toBe(0);
	});

	it("clamps negative inputs to zero", () => {
		const transitions = summarizeConsolidationTransitions({
			probationPromoted: -1,
			duplicatesMerged: -2,
			factsArchived: -3,
			probationExpired: -4,
			demoted: -5,
		});
		expect(transitions.total).toBe(0);
	});
});

describe("reflection projection checkpoints", () => {
	afterEach(() => vi.restoreAllMocks());
	const fact = (id: string, overrides: Record<string, unknown> = {}) => ({
		id,
		organizationId: "org-1",
		tediId: null,
		memoryScope: "org",
		usePolicy: "can_use_as_evidence",
		reviewStatus: "pending",
		archivedAt: null,
		validTo: null,
		content: `Current ${id}`,
		summary: null,
		factType: "technical",
		confidence: 0.7,
		...overrides,
	});
	function checkpointStep() {
		const completed = new Map<string, unknown>();
		const attempts: string[] = [];
		return {
			attempts,
			step: {
				do: async (
					name: string,
					_config: unknown,
					run: () => Promise<unknown>,
				) => {
					if (completed.has(name)) return completed.get(name);
					attempts.push(name);
					const result = await run();
					completed.set(name, result);
					return result;
				},
			} as unknown as WorkflowStep,
		};
	}

	it("retries only the failed fact and rereads its current invalidation", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		const rows = new Map([
			["a", fact("a")],
			["b", fact("b")],
		]);
		vi.mocked(getFactById).mockImplementation(
			async (_db, id) => rows.get(id) as never,
		);
		const remember = vi.fn(async ({ sessionId }: { sessionId: string }) => {
			if (sessionId === "fact:b") throw new Error("provider unavailable");
		});
		const deleteSession = vi.fn(async (_sessionId: string) => {});
		const binding = {
			getProfile: vi.fn(async () => ({ remember, deleteSession })),
		} as never;
		const { step, attempts } = checkpointStep();
		const input = {
			step,
			db: {} as never,
			binding,
			organizationId: "org-1",
			factIds: ["a", "b"],
		};
		await expect(reconcileReflectedMemory(input)).rejects.toThrow(
			"provider unavailable",
		);
		rows.set(
			"b",
			fact("b", {
				validTo: "2026-09-14T00:00:00Z",
				content: "Invalidated after first attempt",
			}),
		);
		await reconcileReflectedMemory(input);
		expect(attempts).toEqual([
			"reconcile-agent-memory:a",
			"reconcile-agent-memory:b",
			"reconcile-agent-memory:b",
		]);
		expect(remember.mock.calls.map(([call]) => call.sessionId)).toEqual([
			"fact:a",
			"fact:b",
		]);
		expect(deleteSession).toHaveBeenLastCalledWith("fact:b");
		expect(vi.mocked(getFactById).mock.calls.map(([, id]) => id)).toEqual([
			"a",
			"b",
			"b",
		]);
	});

	it("uses fresh lifecycle gates and skips missing or foreign facts", async () => {
		vi.mocked(getFactById).mockClear();
		const rows = new Map([
			["archived", fact("archived", { archivedAt: "2026-09-14T00:00:00Z" })],
			["restricted", fact("restricted", { reviewStatus: "restricted" })],
			[
				"withheld",
				fact("withheld", { usePolicy: "do_not_inject_automatically" }),
			],
			["foreign", fact("foreign", { organizationId: "org-2" })],
		]);
		vi.mocked(getFactById).mockImplementation(
			async (_db, id) => rows.get(id) as never,
		);
		const remember = vi.fn();
		const deleteSession = vi.fn(async (_sessionId: string) => {});
		const getProfile = vi.fn(async (_name: string) => ({
			remember,
			deleteSession,
		}));
		await reconcileReflectedMemory({
			step: checkpointStep().step,
			db: {} as never,
			binding: { getProfile } as never,
			organizationId: "org-1",
			factIds: ["archived", "restricted", "withheld", "foreign", "missing"],
		});
		expect(remember).not.toHaveBeenCalled();
		expect(deleteSession.mock.calls).toEqual([
			["fact:archived"],
			["fact:restricted"],
			["fact:withheld"],
		]);
		expect(getProfile).toHaveBeenCalledTimes(3);
		expect(getProfile.mock.calls.every(([name]) => name === "org-org-1")).toBe(
			true,
		);
	});
});

describe("reflection graph selection", () => {
	it("preserves org and tedi scope and never expands the selected set", () => {
		const facts = Array.from({ length: 100 }, (_, i) => ({ id: `f${i}` }));
		const scope = reflectionAutoLinkScope("org", "tedi", facts);
		expect(scope).toMatchObject({ organizationId: "org", tediId: "tedi" });
		expect(scope.factIds).toEqual(facts.slice(0, 80).map((f) => f.id));
		expect(reflectionAutoLinkScope("org", undefined, []).factIds).toEqual([]);
	});
});

describe("optional graph linking failure isolation", () => {
	it("continues later maintenance after an insertion failure without replaying inference", async () => {
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		const graph = vi.fn(async () => {
			throw new Error("D1 insertion failed after paid judgment");
		});
		const lifecycle = vi.fn();
		const result = await runOptionalGraphLinking(graph);
		lifecycle();
		expect(result.failed).toBe(true);
		expect(graph).toHaveBeenCalledTimes(1);
		expect(lifecycle).toHaveBeenCalledTimes(1);
		expect(warning).toHaveBeenCalledWith(
			expect.stringContaining("partial counts unavailable"),
		);
		warning.mockRestore();
	});
	it("preserves successful canonical counts", async () => {
		expect(
			await runOptionalGraphLinking(async () => ({
				proposals: [],
				edgesCreated: 2,
				judgments: 3,
				domainsScanned: 1,
			})),
		).toMatchObject({ failed: false, edgesCreated: 2, judgments: 3 });
	});
});
