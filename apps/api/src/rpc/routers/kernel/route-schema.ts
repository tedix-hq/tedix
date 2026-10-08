import * as z from "zod";

export const HOME_ROUTE_KINDS = [
	"answer_in_home",
	"propose_tool_write",
	"delegate_tedi",
	"suggest_handoff",
	"run_workflow",
	"ask_human",
] as const;

/**
 * Effort class — a routing output, not a suggestion (Anthropic scaling-rules lineage). The policy layer
 * enforces it as a budget:
 *
 *   single_read    — one bounded read answers it
 *   multi_hop_read — discovery + final read (≤3 calls)
 *   fan_out        — parallel branches/delegations justified by breadth
 *   embodied       — needs a workstation profile/adapter (shell/files/coding/browser/long process)
 */
export const HOME_EFFORT_CLASSES = [
	"single_read",
	"multi_hop_read",
	"fan_out",
	"embodied",
] as const;

// Azure/OpenAI strict structured output (`generateObject`) requires EVERY
// property to appear in `required` and forbids numeric/string constraint
// keywords (minimum, maximum, minLength, …). So: optional fields use
// `.nullable()` (present-but-null) instead of `.optional()`, and we keep
// ranges/format in the `.describe()` text rather than as zod constraints.
// renderRouteResponse tolerates null on every field.
export const KernelRouteDecisionSchema = z.object({
	routeKind: z
		.enum(HOME_ROUTE_KINDS)
		.describe(
			"the single best route for handling this request from the Home conversation",
		),
	// Keep answer immediately after routeKind. The production single-pass
	// streamObject path can forward answer deltas only once this property begins;
	// putting planner metadata first adds its generation time directly to the
	// operator's blank-screen latency. Strict structured output preserves schema
	// property order, so this ordering is part of the streaming UX contract.
	answer: z
		.string()
		.nullable()
		.describe(
			"for answer_in_home, or a useful direct answer/preview for the operator; for suggest_handoff a one-sentence handoff suggestion; null when not applicable",
		),
	rationale: z
		.string()
		.describe("why this route was chosen, grounded in the assembled context"),
	risk: z
		.enum(["low", "medium", "high"])
		.describe(
			"blast radius of acting on this route — reads are low, writes/dispatches are medium/high",
		),
	confidence: z
		.number()
		.describe("how confident the planner is in this route, from 0 to 1"),
	effortClass: z
		.enum(HOME_EFFORT_CLASSES)
		.nullable()
		.describe(
			"the effort budget this route needs — single_read (one bounded read), multi_hop_read (discovery + final read, at most 3 calls), fan_out (parallel branches justified by breadth), embodied (workstation profile/adapter: shell/files/coding/browser automation/long process); null ONLY when genuinely inapplicable (e.g. ask_human)",
		),
	targetTediId: z
		.string()
		.nullable()
		.describe(
			"for delegate_tedi / suggest_handoff: the chosen tedi id from context.tedis; null otherwise",
		),
	targetTediLabel: z
		.string()
		.nullable()
		.describe(
			"for delegate_tedi / suggest_handoff: a human-readable name/role for the chosen tedi; null otherwise",
		),
	targetActivityId: z
		.string()
		.nullable()
		.describe(
			"for delegate_tedi: the exact active entrusted activity id shown on the chosen tedi; null for other routes or when no active entrustment applies",
		),
	plannedToolIds: z
		.array(z.string())
		.describe(
			"for delegate_tedi: the exact minimal tool ids needed, selected only from the chosen activity's tools; use namespace.tool for MCP callables and local tool keys for native tools; empty for other routes or a tool-free delegation",
		),
	toolIntent: z
		.object({
			appSlug: z
				.string()
				.nullable()
				.describe(
					"the app slug the capability belongs to, from context.apps; null if unknown",
				),
			capability: z
				.string()
				.nullable()
				.describe("e.g. gmail.read, globex.invoices.list; null if unknown"),
			connectionStatus: z
				.enum(["connected", "not_connected", "unknown"])
				.nullable()
				.describe("whether the app is connected for this organization"),
		})
		.nullable()
		.describe("for propose_tool_write; null for other routes"),
	workflowHint: z
		.string()
		.nullable()
		.describe(
			"for run_workflow: the workflow slug/name to run; null otherwise",
		),
	clarifyingQuestion: z
		.string()
		.nullable()
		.describe(
			"for ask_human: the single most useful question to unblock the request; null otherwise",
		),
	evidenceExpectation: z
		.string()
		.nullable()
		.describe(
			"what evidence or outcome the operator should expect once this route runs; null if none",
		),
});

// The schema requires nullable fields to be PRESENT (Azure strict structured
// output, see above). The Workers AI route uses json_object mode with no such
// enforcement, and models there omit inapplicable fields instead of emitting
// null — so map omitted → null before parsing. This must stay a parse-side
// normalizer; loosening the schema to .nullish() would drop fields from
// `required` and break Azure strict mode.
const NULLABLE_DECISION_KEYS = [
	"effortClass",
	"answer",
	"targetTediId",
	"targetTediLabel",
	"targetActivityId",
	"toolIntent",
	"workflowHint",
	"clarifyingQuestion",
	"evidenceExpectation",
] as const;
const NULLABLE_TOOL_INTENT_KEYS = [
	"appSlug",
	"capability",
	"connectionStatus",
] as const;

export function normalizeRouteDecisionCandidate(value: unknown): unknown {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		return value;
	const out: Record<string, unknown> = {
		...(value as Record<string, unknown>),
	};
	for (const key of NULLABLE_DECISION_KEYS)
		if (out[key] === undefined) out[key] = null;
	if (out.plannedToolIds === undefined) out.plannedToolIds = [];
	const toolIntent = out.toolIntent;
	if (
		toolIntent !== null &&
		typeof toolIntent === "object" &&
		!Array.isArray(toolIntent)
	) {
		const intent: Record<string, unknown> = {
			...(toolIntent as Record<string, unknown>),
		};
		for (const key of NULLABLE_TOOL_INTENT_KEYS)
			if (intent[key] === undefined) intent[key] = null;
		out.toolIntent = intent;
	}
	return out;
}

/**
 * The validated planner decision plus one SERVER-STAMPED field:
 * `explicitDelegationIntent` — whether the operator message itself asked for
 * delegation / a task / a background job (`delegation-intent.ts`). Deliberately
 * NOT in {@link KernelRouteDecisionSchema}: that schema is the model-facing
 * contract (strict structured output would ask the model to produce it), and
 * the router-version hash is computed over the schema shape, so keeping the
 * stamp out of the schema keeps the hash stable across the stamp's presence.
 * Optional on the type so hand-built decisions (tests, deterministic roster
 * routes) remain assignable; the planner guard stamps it on every decision it
 * returns, and the turn body treats absence as `false`.
 */
export type KernelRouteDecision = z.infer<typeof KernelRouteDecisionSchema> & {
	explicitDelegationIntent?: boolean;
};
export type HomeEffortClass = (typeof HOME_EFFORT_CLASSES)[number];
