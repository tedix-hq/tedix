/**
 * Cross-body USAGE INVARIANT conformance test.
 *
 * Modeled on comparable frameworks' per-executor usage tests: rather than testing
 * one body in isolation, this asserts the SAME invariant holds for every body
 * that emits a {@link BodyExecutionResult} — isolate (Cloudflare Agents), kernel
 * (route planner), and the container (runtime) — so no body can drift.
 *
 * The invariant (docs/cognition + body-certification telemetry):
 *   1. Every body turn result carries a `usage` object with all seven canonical
 *      fields present (the schema makes this structural).
 *   2. Provider-reported counts are FORWARDED verbatim when present.
 *   3. A count the provider did NOT report is `null` — NEVER a fabricated `0`.
 *      A genuine `0` (e.g. zero cache reads) is preserved as `0`, distinct from
 *      "unavailable".
 *   4. The canonical usage shape is shared: the runtime-event `usage` field and
 *      the body-result `usage` field validate against the SAME schema, and the
 *      `bodyExecutionUsageFromRecord` projector round-trips it.
 */

import { describe, expect, it } from "vite-plus/test";
import {
	BodyExecutionResultSchema,
	BodyExecutionUsageSchema,
} from "../schemas/body-certification";
import { TediRuntimeEventSchema } from "../schemas/cognitive-runtime";
import {
	bodyExecutionUsageFromRecord,
	buildBodyExecutionResult,
} from "./body-execution-result";

const CANONICAL_USAGE_FIELDS = [
	"provider",
	"model",
	"inputTokens",
	"outputTokens",
	"reasoningTokens",
	"cacheReadTokens",
	"cacheWriteTokens",
] as const;

// One representative completed turn per body. Each is the shape that body's
// real turn code passes to buildBodyExecutionResult (partial usage allowed).
const BODY_FIXTURES = [
	{
		bodyKind: "agent",
		runtimeServices: ["cloudflare-agents", "think", "mcp"],
		// Isolate sums step telemetry: provider/model + input/output known; the
		// streaming path surfaced no cache counts → those stay absent (→ null).
		usage: {
			provider: "azure-openai",
			model: "gpt-5-1-preview",
			inputTokens: 1200,
			outputTokens: 80,
		},
	},
	{
		bodyKind: "kernel",
		runtimeServices: ["kernel-runtime", "home", "mcp"],
		// Kernel threads route-planner usage; cache reads genuinely 0 this turn.
		usage: {
			provider: "azure-openai",
			model: "gpt-5.6-terra",
			inputTokens: 640,
			outputTokens: 32,
			cacheReadTokens: 0,
		},
	},
	{
		bodyKind: "workstation",
		runtimeServices: ["sandbox"],
		// Workstation episodes may have no model telemetry.
		usage: undefined as
			| undefined
			| Partial<{
					provider: string | null;
					model: string | null;
					inputTokens: number | null;
					outputTokens: number | null;
					reasoningTokens: number | null;
					cacheReadTokens: number | null;
					cacheWriteTokens: number | null;
			  }>,
	},
] as const;

describe("cross-body BodyExecutionResult usage invariant", () => {
	for (const fixture of BODY_FIXTURES) {
		it(`${fixture.bodyKind}: carries a complete usage object that validates against the canonical schema`, () => {
			const result = buildBodyExecutionResult({
				bodyKind: fixture.bodyKind,
				status: "completed",
				runId: `run-${fixture.bodyKind}`,
				startedAt: "2026-06-16T10:00:00.000Z",
				endedAt: "2026-06-16T10:00:01.000Z",
				...(fixture.usage ? { usage: fixture.usage } : {}),
				runtimeServices: [...fixture.runtimeServices],
			});

			// (1) structural: all six fields present, schema-valid.
			expect(BodyExecutionUsageSchema.safeParse(result.usage).success).toBe(
				true,
			);
			for (const field of CANONICAL_USAGE_FIELDS) {
				expect(result.usage).toHaveProperty(field);
			}
		});
	}

	it("forwards provider-reported counts verbatim (isolate)", () => {
		const result = buildBodyExecutionResult({
			bodyKind: "agent",
			status: "completed",
			runId: "run-isolate",
			startedAt: "2026-06-16T10:00:00.000Z",
			endedAt: "2026-06-16T10:00:01.000Z",
			usage: {
				provider: "azure-openai",
				model: "gpt-5-1-preview",
				inputTokens: 1200,
				outputTokens: 80,
			},
		});
		expect(result.usage.inputTokens).toBe(1200);
		expect(result.usage.outputTokens).toBe(80);
		expect(result.usage.reasoningTokens).toBeNull();
		expect(result.usage.provider).toBe("azure-openai");
		// Fields the provider omitted → null, NEVER a fabricated 0.
		expect(result.usage.cacheReadTokens).toBeNull();
		expect(result.usage.cacheWriteTokens).toBeNull();
	});

	it("preserves a genuine 0 distinctly from null-absent (kernel)", () => {
		const result = buildBodyExecutionResult({
			bodyKind: "kernel",
			status: "completed",
			runId: "run-kernel",
			startedAt: "2026-06-16T10:00:00.000Z",
			endedAt: "2026-06-16T10:00:01.000Z",
			usage: { inputTokens: 640, outputTokens: 32, cacheReadTokens: 0 },
		});
		expect(result.usage.cacheReadTokens).toBe(0); // reported zero, kept
		expect(result.usage.cacheWriteTokens).toBeNull(); // unreported, null
	});

	it("never fabricates token counts for a body with no telemetry", () => {
		const result = buildBodyExecutionResult({
			bodyKind: "workstation",
			status: "completed",
			runId: "run-workstation",
			startedAt: "2026-06-16T10:00:00.000Z",
			endedAt: "2026-06-16T10:00:01.000Z",
			runtimeServices: ["sandbox"],
		});
		for (const field of CANONICAL_USAGE_FIELDS) {
			expect(result.usage[field]).toBeNull();
		}
	});
});

describe("canonical usage is promoted from the REAL writer payload shape", () => {
	// The terminal-event writers (isolate `ledger-mirror.ts` run.completed,
	// kernel `turn-work.ts` message.completed/run.completed) emit BOTH the scalar
	// `payload.tokensUsed` AND the canonical `payload.usage` breakdown. The
	// promoter (`normalizeRuntimeEvent` in apps/api, via `bodyExecutionUsageFromRecord`)
	// reads `payload.usage`. This block exercises that exact payload shape — the
	// previous version hand-built a top-level event `usage`, which masked the bug
	// where the promoter read a key NO writer emitted.

	it("promotes payload.usage from the real run.completed writer payload", () => {
		// EXACT shape ledger-mirror / turn-work put on the event payload.
		const writerPayload = {
			tokensUsed: 1280,
			usage: {
				provider: "azure-openai",
				model: "gpt-5-1-preview",
				inputTokens: 1200,
				outputTokens: 80,
				reasoningTokens: 12,
				cacheReadTokens: null,
				cacheWriteTokens: null,
			},
		};

		const promoted = bodyExecutionUsageFromRecord(writerPayload.usage);
		expect(promoted).not.toBeNull();
		expect(BodyExecutionUsageSchema.safeParse(promoted).success).toBe(true);
		expect(promoted).toMatchObject({
			provider: "azure-openai",
			inputTokens: 1200,
			outputTokens: 80,
		});

		// The promoted usage validates as the typed event field.
		const event = TediRuntimeEventSchema.parse({
			id: "evt-1",
			tediId: "tedi-1",
			kind: "run.completed",
			payload: writerPayload,
			usage: promoted ?? undefined,
			createdAt: "2026-06-16T10:00:01.000Z",
		});
		expect(event.usage).toEqual(promoted);
	});

	it("the scalar tokensUsed ALONE does not populate usage (regression guard)", () => {
		// This is the ORIGINAL bug shape: an event carrying only the scalar. The
		// promoter must NOT invent a usage breakdown from it — which is exactly why
		// the writers were updated to also emit the canonical `payload.usage`.
		const tokensOnlyPayload = { tokensUsed: 1280 };
		expect(bodyExecutionUsageFromRecord(tokensOnlyPayload.usage)).toBeNull();
		// And a scalar number is not a usage record either.
		expect(bodyExecutionUsageFromRecord(1280)).toBeNull();
	});

	it("the payload→usage projector round-trips the canonical fields and drops empty/foreign blobs", () => {
		const projected = bodyExecutionUsageFromRecord({
			provider: "azure-openai",
			model: "gpt-5.6-terra",
			inputTokens: 12,
			outputTokens: 3,
			reasoningTokens: 2,
			// stray non-numeric / foreign keys are ignored
			ignored: "x",
			totalTokens: "not-a-number",
		});
		expect(BodyExecutionUsageSchema.safeParse(projected).success).toBe(true);
		expect(projected).toMatchObject({
			provider: "azure-openai",
			inputTokens: 12,
			outputTokens: 3,
			reasoningTokens: 2,
			cacheReadTokens: null,
			cacheWriteTokens: null,
		});

		// An empty / usage-less blob is NOT promoted to a fabricated all-null
		// usage object — it returns null so a non-usage event has no usage field.
		expect(bodyExecutionUsageFromRecord({})).toBeNull();
		expect(bodyExecutionUsageFromRecord(undefined)).toBeNull();
		expect(bodyExecutionUsageFromRecord({ unrelated: 1 })).toBeNull();
	});
});

describe("BodyExecutionResult envelope still validates with usage threaded", () => {
	it("round-trips through the schema", () => {
		const result = buildBodyExecutionResult({
			bodyKind: "agent",
			status: "completed",
			runId: "run-roundtrip",
			startedAt: "2026-06-16T10:00:00.000Z",
			endedAt: "2026-06-16T10:00:01.000Z",
			usage: { provider: "azure-openai", inputTokens: 5 },
		});
		expect(BodyExecutionResultSchema.safeParse(result).success).toBe(true);
	});
});
