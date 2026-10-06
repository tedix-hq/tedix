/**
 * Kernel — per-turn cost advisor (advise / shadow-telemetry mode).
 *
 * Derives a shadow cost-routing verdict from the route planner's existing
 * `effortClass` and `confidence` signals. In `advise` mode the verdict is
 * RECORDED as metadata on the run and NEVER applied to the model selection.
 * `optimize` mode (actually swap the model) is explicitly NOT implemented here;
 * leave this TODO for the next pass once shadow data proves the tiers.
 *
 * ## Composition with the attention router
 *
 * The kernel attention router (`route-planner.ts` → `planKernelRoute`) already
 * classifies every turn into an `effortClass` (single_read / multi_hop_read /
 * fan_out / embodied) plus a `confidence` score. Those two signals together
 * define the cost tier — making a SECOND LLM judge call per turn redundant and
 * costly. The advisor reads from the SAME object the planner already produced,
 * zero extra I/O.
 *
 * ## Tier mapping (from effortClass + confidence)
 *
 *   effortClass=null or ask_human route  → null  (no verdict — no budget signal)
 *   single_read                          → cheap
 *   multi_hop_read                       → medium
 *   fan_out                              → expensive
 *   embodied                             → expensive
 *
 * Confidence modulates the boundary only one step upward — a medium-tier route
 * with confidence < 0.45 bumps to expensive (the planner is uncertain, so
 * assume worst-case budget). Never steps DOWN (cheap stays cheap regardless of
 * confidence — a certain single-read is still a single-read).
 *
 * ## Config flag
 *
 *   off     (default) — no advisor verdict computed or stored
 *   advise  — verdict computed, stored on run metadata as `kernelCostAdvisor`,
 *             model selection UNCHANGED
 *   optimize — NOT IMPLEMENTED; behaves identically to `advise` today.
 *              TODO: when shadow data matures, implement model-swap here.
 *
 * The flag is read from the Worker env as `KERNEL_COST_ADVISOR_MODE`
 * (`"off" | "advise" | "optimize"`); absent/unrecognised → `"off"`.
 */

import type { HomeEffortClass, KernelRouteDecision } from "./route-schema";

/** Three cost tiers for the kernel turn — maps to a rough model budget. */
export type CostTier = "cheap" | "medium" | "expensive";

/**
 * Shadow verdict produced by the cost advisor before a turn executes.
 *
 * `applied` is ALWAYS `false` in this pass: advise mode records what the
 * advisor would have done without changing any behavior.
 */
export interface CostAdvisorVerdict {
	/** Cost tier derived from the existing route decision. */
	tier: CostTier;
	/**
	 * Model that WOULD be selected if the advisor were in optimize mode.
	 * Always the currently-configured kernel deployment — the advisor never
	 * actually resolves a cheaper model name here (no model registry yet).
	 * This field is a placeholder for the optimize-mode follow-up.
	 */
	suggestedModel: string | null;
	/** Whether the verdict was applied to model selection. Always false in advise mode. */
	applied: false;
	/** Human-readable rationale for the tier assignment. */
	rationale: string;
	/** The effortClass the advisor read from the route decision. */
	effortClass: HomeEffortClass | null;
	/** The confidence the advisor read from the route decision. */
	confidence: number | null;
	/** The advisor mode that produced this verdict. */
	mode: CostAdvisorMode;
}

/** Valid values for the `KERNEL_COST_ADVISOR_MODE` env flag. */
export type CostAdvisorMode = "off" | "advise" | "optimize";

/**
 * Read the advisor mode from the Worker env. Absent or unrecognised value
 * returns `"off"` (default — feature is dark until explicitly enabled).
 */
export function readCostAdvisorMode(
	env: Record<string, unknown> | CloudflareEnv,
): CostAdvisorMode {
	const raw = (env as Record<string, unknown>)
		.KERNEL_COST_ADVISOR_MODE as unknown;
	if (raw === "advise" || raw === "optimize") return raw;
	return "off";
}

/**
 * Map effortClass + confidence to a CostTier.
 *
 * Rules:
 *   - null effortClass → null (no verdict possible — ask_human routes or error)
 *   - single_read → cheap (confidence does not step cheap down)
 *   - multi_hop_read → medium; bumps to expensive when confidence < 0.45
 *   - fan_out | embodied → expensive always
 */
function tierFromEffort(
	effortClass: HomeEffortClass | null,
	confidence: number | null,
): CostTier | null {
	if (!effortClass) return null;
	switch (effortClass) {
		case "single_read":
			return "cheap";
		case "multi_hop_read":
			// Low confidence means the planner isn't sure this is a single hop —
			// treat it as expensive to be safe.
			return (confidence ?? 1) < 0.45 ? "expensive" : "medium";
		case "fan_out":
		case "embodied":
			return "expensive";
	}
}

function rationale(
	effortClass: HomeEffortClass | null,
	confidence: number | null,
	tier: CostTier,
): string {
	if (!effortClass)
		return "No effortClass signal from route planner; no verdict.";
	const confNote =
		confidence !== null ? ` (confidence=${confidence.toFixed(2)})` : "";
	if (
		effortClass === "multi_hop_read" &&
		(confidence ?? 1) < 0.45 &&
		tier === "expensive"
	) {
		return `effortClass=${effortClass}${confNote} — low confidence bumped tier to expensive.`;
	}
	return `effortClass=${effortClass}${confNote} → tier=${tier}.`;
}

/**
 * Derive a shadow cost-routing verdict from an existing route decision.
 *
 * Returns `null` when:
 *   - mode is `"off"`
 *   - the route decision produced no effortClass (e.g. ask_human turns)
 *
 * Never throws: any error is swallowed and returns null — the advisor is
 * purely advisory telemetry and must never affect the turn outcome.
 */
export function adviseTurnCost(input: {
	mode: CostAdvisorMode;
	route: Pick<KernelRouteDecision, "effortClass" | "confidence"> | null;
	/** The currently-configured kernel deployment name (placeholder for optimize mode). */
	currentModelDeployment: string | null;
}): CostAdvisorVerdict | null {
	if (input.mode === "off") return null;

	try {
		const effortClass = input.route?.effortClass ?? null;
		const confidence =
			typeof input.route?.confidence === "number"
				? input.route.confidence
				: null;

		const tier = tierFromEffort(effortClass, confidence);
		if (!tier) return null;

		// TODO (optimize mode): resolve a cheaper model from a registry when
		// tier === "cheap" and mode === "optimize". For now suggestedModel is
		// always the current deployment — the field is a placeholder so the
		// schema is stable when the optimize leg ships.
		const suggestedModel = input.currentModelDeployment;

		return {
			tier,
			suggestedModel,
			applied: false,
			rationale: rationale(effortClass, confidence, tier),
			effortClass,
			confidence,
			mode: input.mode,
		};
	} catch {
		// Fail-open: any error → no verdict, turn runs normally.
		return null;
	}
}
