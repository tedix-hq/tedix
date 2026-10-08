import "@orpc/openapi/extensions/route";
/**
 * Harness Versioning + Trace Bundle Contract
 *
 * Write/read surface for harness versions and trace bundles
 * (`docs/engineering/cognition/runtime.md`). The isolate DO's `HttpPlatformClient` calls
 * `ensureActiveHarnessVersion` (on identity load) and `recordTraceBundle` (per
 * run at close); Tedix OS Activity and audit surfaces read `listTraceBundles` and
 * `getActiveHarnessVersion`.
 *
 * Contracts live here (not inline in the router) per the repo contract-location
 * rule. Schemas are the canonical zod shapes in
 * `@tedix/api-contract/schemas/harness-version`.
 */

import { oc } from "@orpc/contract";
import * as z from "zod";
import { baseErrors } from "../errors";
import {
	EvalGateDecisionSchema,
	HarnessEvalResultSchema,
	HarnessEvalRunSchema,
	HarnessEvalSummarySchema,
	HarnessSubjectTraceBundleSchema,
	HarnessVersionSchema,
	PromotionDecisionSchema,
	TraceBundleSchema,
} from "../schemas/harness-version";

/**
 * Input for `ensureActiveHarnessVersion`: a tedi-scoped component-hash set plus
 * the identity needed to bump. The API decides whether a write is needed by
 * diffing `components` against the tedi's current active version. The caller
 * does NOT pass an `id`/`version` — the API assigns them on bump so version
 * monotonicity stays server-authoritative.
 */
export const EnsureActiveHarnessVersionInputSchema = z.object({
	tediId: z.string(),
	orgId: z.string().optional(),
	runtimeKind: z.string().optional(),
	/** component-name → content-hash | version string. */
	components: z.record(z.string(), z.string()),
	/** Why this set of components is in force ("initial baseline", "directive set changed"). */
	reason: z.string().optional(),
	/**
	 * Trace-safety policy id in force for this version's trace writers. Stamped
	 * onto the version row so the redaction policy that governed a run's raw
	 * evidence is auditable from the version itself (not only the bundle's
	 * manifest.json / R2 customMetadata). Optional + nullable: when absent the
	 * column is left unset and existing recording is unchanged.
	 */
	traceSafetyPolicyId: z.string().nullable().optional(),
});

export const EnsureActiveHarnessVersionOutputSchema = z.object({
	version: HarnessVersionSchema,
	/** True when this call wrote a new version (first ensure, or a component bump). */
	bumped: z.boolean(),
});

export const ListHarnessVersionsInputSchema = z.object({
	tediId: z.string(),
	promotionStatus: z
		.enum([
			"proposed",
			"evaluated",
			"canary",
			"active",
			"promoted",
			"rejected",
			"rolled_back",
		])
		.optional(),
	runtimeKind: z.string().optional(),
	limit: z.number().int().min(1).max(200).optional(),
});

export const ComponentDiffSchema = z.object({
	component: z.string(),
	base: z.string().nullable(),
	candidate: z.string().nullable(),
	status: z.enum(["added", "removed", "changed"]),
});

export const CompareHarnessVersionsInputSchema = z.object({
	tediId: z.string(),
	baseHarnessVersionId: z.string().optional(),
	candidateHarnessVersionId: z.string(),
});

export const CompareHarnessVersionsOutputSchema = z.object({
	base: HarnessVersionSchema.nullable(),
	candidate: HarnessVersionSchema,
	componentDiffs: z.array(ComponentDiffSchema),
	changed: z.boolean(),
});

export const RecordTraceBundleInputSchema = TraceBundleSchema;

export const ListTraceBundlesInputSchema = z.object({
	tediId: z.string(),
	runId: z.string().optional(),
	harnessVersionId: z.string().optional(),
	limit: z.number().int().min(1).max(200).optional(),
});

export const ListKernelTraceBundlesInputSchema = z.object({
	runId: z.string().optional(),
	harnessVersionId: z.string().optional(),
	limit: z.number().int().min(1).max(200).optional(),
});

export const KernelTraceBundleFileNameSchema = z.enum([
	"manifest.json",
	"prompt.json",
	"context-manifest.json",
	"route.json",
	"output.md",
	"outcome.json",
]);

export const ReadKernelTraceBundleFileInputSchema = z.object({
	organizationId: z.string().uuid(),
	runId: z.string().min(1).max(300),
	fileName: KernelTraceBundleFileNameSchema,
});

export const KernelTraceBundleFileOutputSchema = z.object({
	bundleId: z.string(),
	bundleUri: z.string(),
	fileName: KernelTraceBundleFileNameSchema,
	contentType: z.string(),
	content: z.string(),
	createdAt: z.string(),
	retentionExpiresAt: z.string(),
});

export const DeleteKernelTraceBundleInputSchema = z.object({
	organizationId: z.string().uuid(),
	runId: z.string().min(1).max(300),
	reason: z.string().min(1).max(1000),
});

export const DeleteKernelTraceBundleOutputSchema = z.object({
	bundleId: z.string(),
	deletedKeys: z.array(z.string()),
	deletedAt: z.string(),
	reason: z.string(),
});

export const RecordEvalResultInputSchema = HarnessEvalResultSchema;

export const ListEvalResultsInputSchema = z.object({
	tediId: z.string(),
	harnessVersionId: z.string().optional(),
	limit: z.number().int().min(1).max(200).optional(),
});

export const GetEvalSummaryInputSchema = z.object({
	tediId: z.string(),
	harnessVersionId: z.string(),
});

export const RecordEvalRunInputSchema = HarnessEvalRunSchema;

export const ListEvalRunsInputSchema = z.object({
	tediId: z.string(),
	harnessVersionId: z.string().optional(),
	limit: z.number().int().min(1).max(200).optional(),
});

export const PromoteHarnessVersionInputSchema = z.object({
	harnessVersionId: z.string(),
});

/** Promotion outcome: the decision plus the version + whether it was persisted. */
export const PromoteHarnessVersionOutputSchema = PromotionDecisionSchema.extend(
	{
		harnessVersionId: z.string(),
		applied: z.boolean(),
	},
).nullable();

const harnessOc = oc.route({ tags: ["harness"] }).errors(baseErrors);

/**
 * Tedi-scoped routes live under `/tedis/{tediId}/harness`. Routes whose input
 * deliberately carries no `tediId` (kernel subject resolved server-side;
 * promotion keyed by version id) get non-tedi REST paths — a `{tediId}` path
 * param without a matching required input field is unrepresentable in OpenAPI.
 * RPC procedure paths (`harness/...`) are unchanged.
 */
export const harnessContract = {
	...harnessOc.route({ prefix: "/tedis/{tediId}/harness" }).router({
		ensureActiveHarnessVersion: oc
			.route({
				method: "POST",
				path: "/versions/ensure-active",
				summary: "Ensure an active harness version exists for a tedi",
				description:
					"Idempotently ensures the tedi has an `active` HarnessVersion whose " +
					"`components` content-hash set matches the supplied one. Writes a new " +
					"version (parentVersionId = current active) only when the component " +
					"set differs from the active version; otherwise returns the existing " +
					"active version with `bumped=false`. Called by the runtime body on " +
					"identity load / first turn.",
			})
			.input(EnsureActiveHarnessVersionInputSchema)
			.output(EnsureActiveHarnessVersionOutputSchema),

		getActiveHarnessVersion: oc
			.route({
				method: "GET",
				path: "/versions/active",
				summary: "Get the active harness version for a tedi",
				description:
					"Returns the tedi's currently-active HarnessVersion, or null.",
			})
			.input(z.object({ tediId: z.string() }))
			.output(z.object({ version: HarnessVersionSchema.nullable() })),

		listHarnessVersions: oc
			.route({
				method: "GET",
				path: "/versions",
				summary: "List harness versions for a tedi",
				description:
					"Returns recent HarnessVersion rows for one tedi, optionally " +
					"filtered by promotion status or runtime kind. This is the read " +
					"surface behind MCP `harness_versions`.",
			})
			.input(ListHarnessVersionsInputSchema)
			.output(z.object({ versions: z.array(HarnessVersionSchema) })),

		compareHarnessVersions: oc
			.route({
				method: "GET",
				path: "/versions/{candidateHarnessVersionId}/compare",
				summary: "Compare a harness version against another version",
				description:
					"Diffs the candidate harness version's component map against a " +
					"specified base version, or the tedi's active version when no " +
					"base id is supplied. This is the read surface behind MCP " +
					"`harness_compare`.",
			})
			.input(CompareHarnessVersionsInputSchema)
			.output(CompareHarnessVersionsOutputSchema),

		recordTraceBundle: oc
			.route({
				method: "POST",
				path: "/trace-bundles",
				summary: "Record a trace bundle for one work episode",
				description:
					"Persists one TraceBundle (curated projection over the runtime " +
					"events / rationale records / artifacts for a single runId). " +
					"Idempotent on the deterministic bundle id (conflict-do-nothing). " +
					"Emitted by the runtime body at run close.",
			})
			.input(RecordTraceBundleInputSchema)
			.output(z.object({ bundle: TraceBundleSchema })),

		listTraceBundles: oc
			.route({
				method: "GET",
				path: "/trace-bundles",
				summary: "List trace bundles for a tedi",
				description:
					"Returns trace bundles for one tedi, optionally filtered by runId " +
					"or harnessVersionId, newest first.",
			})
			.input(ListTraceBundlesInputSchema)
			.output(z.object({ bundles: z.array(TraceBundleSchema) })),

		recordEvalResult: oc
			.route({
				method: "POST",
				path: "/eval-results",
				summary: "Record one harness eval result",
				description:
					"Persists one HarnessEvalResult — the leaf RECORD layer of the " +
					"harness eval ledger (one scored evaluation of a harness version, " +
					"with a per-protected-metric gate map). Idempotent on the eval id " +
					"(conflict-do-nothing). Emitted by the eval runner; the runner " +
					"itself is out of scope of this surface.",
			})
			.input(RecordEvalResultInputSchema)
			.output(z.object({ result: HarnessEvalResultSchema })),

		listEvalResults: oc
			.route({
				method: "GET",
				path: "/eval-results",
				summary: "List harness eval results for a tedi",
				description:
					"Returns eval results for one tedi, optionally filtered by " +
					"harnessVersionId, newest first.",
			})
			.input(ListEvalResultsInputSchema)
			.output(z.object({ results: z.array(HarnessEvalResultSchema) })),

		getEvalSummaryForVersion: oc
			.route({
				method: "GET",
				path: "/versions/{harnessVersionId}/eval-summary",
				summary: "Aggregate eval summary + promotion-gate decision",
				description:
					"Rolls a harness version's full eval ledger into a HarnessEvalSummary " +
					"(pass/fail counts, latest score, per-lane latest pass state) and " +
					"returns the behavioral promotion-gate decision " +
					"(`evalGateForCertification`) — whether the version's eval ledger is " +
					"green enough to advance toward `certified`. This is the behavioral " +
					"counterpart to body-certification capability gates.",
			})
			.input(GetEvalSummaryInputSchema)
			.output(
				z.object({
					summary: HarnessEvalSummarySchema,
					gate: EvalGateDecisionSchema,
				}),
			),

		recordEvalRun: oc
			.route({
				method: "POST",
				path: "/eval-runs",
				summary: "Record one grouped eval run",
				description:
					"Persists one HarnessEvalRun (N eval results rolled up on one lane). " +
					"Idempotent on the run id (conflict-do-nothing). Written by the eval " +
					"runner alongside the per-result rows.",
			})
			.input(RecordEvalRunInputSchema)
			.output(z.object({ run: HarnessEvalRunSchema })),

		listEvalRuns: oc
			.route({
				method: "GET",
				path: "/eval-runs",
				summary: "List eval runs for a tedi",
				description:
					"Returns eval runs for one tedi, optionally filtered by " +
					"harnessVersionId, newest first.",
			})
			.input(ListEvalRunsInputSchema)
			.output(z.object({ runs: z.array(HarnessEvalRunSchema) })),
	}),

	...harnessOc.router({
		readKernelTraceBundleFile: oc
			.route({
				method: "GET",
				path: "/platform/harness/kernel/trace-bundles/{runId}/files/{fileName}",
				summary: "Read one redacted Kernel trace-bundle file",
				description:
					"Platform-admin-only, audited read of one allowlisted redacted R2 trace file.",
			})
			.input(ReadKernelTraceBundleFileInputSchema)
			.output(KernelTraceBundleFileOutputSchema),

		deleteKernelTraceBundle: oc
			.route({
				method: "DELETE",
				path: "/platform/harness/kernel/trace-bundles/{runId}",
				summary: "Delete retained Kernel trace-bundle files",
				description:
					"Platform-admin-only retention action with a durable audit receipt.",
			})
			.input(DeleteKernelTraceBundleInputSchema)
			.output(DeleteKernelTraceBundleOutputSchema),

		listKernelTraceBundles: oc
			.route({
				method: "GET",
				path: "/kernel/harness/trace-bundles",
				summary: "List trace bundles for the caller organization's kernel",
				description:
					"Returns subject-keyed Home Kernel trace bundles for the caller's " +
					"organization, optionally filtered by runId or harnessVersionId. " +
					"The subject id is resolved server-side from organization context " +
					"so Home does not fake a tedi identity or expose cross-org lookup.",
			})
			.input(ListKernelTraceBundlesInputSchema)
			.output(z.object({ bundles: z.array(HarnessSubjectTraceBundleSchema) })),

		promoteHarnessVersion: oc
			.route({
				method: "POST",
				path: "/harness/versions/{harnessVersionId}/promote",
				summary: "Advance a harness version through the promotion ladder",
				description:
					"Reads the version's eval summary, applies the gated promotion ladder " +
					"(proposed→evaluated→canary→promoted; a failing required-stage lane → " +
					"rejected) via `decidePromotion`, and persists the next status only when " +
					"it advances. Does NOT set the live `active` pointer (operator step). " +
					"Returns null when the version does not exist.",
			})
			.input(PromoteHarnessVersionInputSchema)
			.output(z.object({ decision: PromoteHarnessVersionOutputSchema })),
	}),
};

export type HarnessContract = typeof harnessContract;
