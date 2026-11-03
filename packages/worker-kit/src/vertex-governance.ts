/**
 * Platform governance for direct Vertex AI calls (GCP-billed).
 *
 * Cloudflare AI Gateway cannot attribute or cap these calls today: they ride
 * `aiplatform.googleapis.com` directly, billed to the platform's GCP project.
 * This module is the platform-side equivalent of the gateway's controls and
 * is the code-level decision for the Vertex governance Work — a Cloudflare
 * custom-provider route cannot be landed here because the gateway's provider
 * credential config lives in the private ops overlay, and Veo long-running
 * operations (`predictLongRunning`/`fetchPredictOperation`) plus the streaming
 * inline-video import have no proven gateway parity. The direct path is
 * therefore kept, governed, and may only be removed once image and
 * dynamic-skill parity through a gateway route is proven.
 *
 * Controls:
 *  - REQUEST-SIZE CAP — one upstream call can never exceed
 *    `VERTEX_MAX_REQUEST_BYTES`; the tenant-authored body is measured before
 *    the platform credential is attached.
 *  - DAILY BUDGET — `getProviderSpendWindowTotals` over `tedi_call_costs`
 *    gives the recorded Vertex spend for the current UTC day; dispatch is
 *    refused once `VERTEX_DAILY_BUDGET_USD` of priced usage is recorded.
 *  - REQUEST CAP — `VERTEX_DAILY_REQUEST_CAP` bounds call volume even while
 *    some usage is unpriced (Veo is per-second, not per-token, so its rows can
 *    be ledger evidence without a governed token rate).
 *  - PER-CALL LEDGER — every dispatched Vertex call writes one
 *    `tedi_call_costs` row carrying org/tedi/run/work attribution and the
 *    calling surface, so per-tedi reads and the cost-anomaly digest see this
 *    spend exactly like gateway-attributed spend.
 *  - ALERTING — a refused dispatch emits the `vertex.budget.exceeded`
 *    structured signal; the daily cost-anomaly job reports a scope that trips.
 */

/** Provider id for direct Vertex calls — the `google-vertex` catalog id. */
export const VERTEX_PROVIDER = "google-vertex";

/**
 * `gateway_id` recorded on dispatch-side ledger rows. These rows were not
 * ingested from an AI Gateway; the sentinel keeps them distinguishable from
 * `ai-gateway-log` ingestion while sharing the same dedupe mechanics.
 */
export const VERTEX_DIRECT_GATEWAY_ID = "vertex-direct";

/**
 * Governed-rate scope for direct Vertex usage. Ops publishes
 * `provider_model_rate_versions` rows with `provider='google-vertex'` and this
 * exact `deployment_scope` to activate dollar pricing; until then calls land
 * as `quarantined_no_pricing` usage evidence and the request cap governs.
 */
export const VERTEX_DEPLOYMENT_SCOPE = '["google-vertex","direct"]';

/**
 * Largest request body the platform will sign toward Vertex. Vertex's own
 * inline-media ceiling is ~20 MiB; this stays safely above legitimate
 * `generateContent`/`predictLongRunning` bodies while bounding tenant input.
 */
export const VERTEX_MAX_REQUEST_BYTES = 25_000_000;

/** Platform-wide daily priced-Vertex budget in USD (the GCP spend cap). */
export const VERTEX_DAILY_BUDGET_USD = 100;

/** Platform-wide daily Vertex dispatch cap, regardless of pricing coverage. */
export const VERTEX_DAILY_REQUEST_CAP = 1_000;

/** UTC start of the current day — the budget window edge. */
export function utcDayStartIso(now = new Date()): string {
	return now.toISOString().slice(0, 10) + "T00:00:00.000Z";
}

/** What the budget check reads about the current window. */
export interface VertexSpendWindowTotals {
	callCount: number;
	totalTokens: number;
	knownCostUsd: number;
	quarantinedCalls: number;
}

export interface VertexBudgetLimits {
	dailyBudgetUsd?: number;
	dailyRequestCap?: number;
}

export type VertexBudgetVerdict =
	| { allowed: true }
	| {
			allowed: false;
			reason: "daily_budget_usd" | "daily_request_cap";
			limitUsd: number;
			limitCalls: number;
			spentUsd: number;
			spentCalls: number;
	  };

/** Evaluate the recorded window totals against the daily platform limits. */
export function evaluateVertexDailyBudget(
	totals: VertexSpendWindowTotals,
	limits: VertexBudgetLimits = {},
): VertexBudgetVerdict {
	const limitUsd = limits.dailyBudgetUsd ?? VERTEX_DAILY_BUDGET_USD;
	const limitCalls = limits.dailyRequestCap ?? VERTEX_DAILY_REQUEST_CAP;
	if (totals.knownCostUsd >= limitUsd) {
		return {
			allowed: false,
			reason: "daily_budget_usd",
			limitUsd,
			limitCalls,
			spentUsd: totals.knownCostUsd,
			spentCalls: totals.callCount,
		};
	}
	if (totals.callCount >= limitCalls) {
		return {
			allowed: false,
			reason: "daily_request_cap",
			limitUsd,
			limitCalls,
			spentUsd: totals.knownCostUsd,
			spentCalls: totals.callCount,
		};
	}
	return { allowed: true };
}

/** A governance refusal carries an HTTP status for the tenant-visible path. */
export class VertexGovernanceError extends Error {
	readonly status: number;
	readonly signal: "vertex.request_too_large" | "vertex.budget.exceeded";
	constructor(
		signal: "vertex.request_too_large" | "vertex.budget.exceeded",
		status: number,
		message: string,
	) {
		super(message);
		this.name = "VertexGovernanceError";
		this.signal = signal;
		this.status = status;
	}
}

/** Throw when a body bound for a Vertex host exceeds the platform cap. */
export function assertVertexRequestSize(
	byteLength: number,
	maxBytes = VERTEX_MAX_REQUEST_BYTES,
): void {
	if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
		throw new VertexGovernanceError(
			"vertex.request_too_large",
			413,
			"VERTEX_REQUEST_UNMEASURABLE: request body size could not be bounded before dispatch",
		);
	}
	if (byteLength > maxBytes) {
		throw new VertexGovernanceError(
			"vertex.request_too_large",
			413,
			`VERTEX_REQUEST_TOO_LARGE: ${byteLength} bytes exceeds the ${maxBytes} byte platform cap`,
		);
	}
}

/** Throw when the daily platform Vertex budget refuses a dispatch. */
export function assertVertexBudgetAllowed(verdict: VertexBudgetVerdict): void {
	if (verdict.allowed) return;
	const detail =
		verdict.reason === "daily_budget_usd"
			? `$${verdict.spentUsd.toFixed(2)} of $${verdict.limitUsd} daily budget recorded`
			: `${verdict.spentCalls} of ${verdict.limitCalls} daily calls recorded`;
	throw new VertexGovernanceError(
		"vertex.budget.exceeded",
		429,
		`VERTEX_BUDGET_EXCEEDED: ${detail}; further Vertex calls are refused until the UTC day resets`,
	);
}

/** Structured refusal log — greppable like `tedi.cost.anomaly` signals. */
export function vertexBudgetExceededSignal(
	surface: string,
	verdict: VertexBudgetVerdict,
	extra: Record<string, unknown> = {},
): string {
	return JSON.stringify({
		signal: "vertex.budget.exceeded",
		surface,
		reason: verdict.allowed ? null : verdict.reason,
		...(!verdict.allowed
			? {
					limitUsd: verdict.limitUsd,
					limitCalls: verdict.limitCalls,
					spentUsd: verdict.spentUsd,
					spentCalls: verdict.spentCalls,
				}
			: {}),
		...extra,
	});
}

/** Gemini `usageMetadata` → ledger token columns. Unknown counts stay null. */
export function vertexUsageTokens(usageMetadata: unknown): {
	inputTokens: number | null;
	outputTokens: number | null;
	totalTokens: number | null;
} {
	const count = (value: unknown): number | null =>
		typeof value === "number" && Number.isSafeInteger(value) && value >= 0
			? value
			: null;
	if (!usageMetadata || typeof usageMetadata !== "object") {
		return { inputTokens: null, outputTokens: null, totalTokens: null };
	}
	const meta = usageMetadata as Record<string, unknown>;
	return {
		inputTokens: count(meta.promptTokenCount),
		outputTokens: count(meta.candidatesTokenCount),
		totalTokens: count(meta.totalTokenCount),
	};
}

/** Best-effort Vertex model id from a request path, or null. */
export function vertexModelFromPath(pathname: string): string | null {
	const match = /\/models\/([^/:?]+)/.exec(pathname);
	return match?.[1] ?? null;
}
