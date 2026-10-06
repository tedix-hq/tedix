/** Persisted cost evidence and explicit subtotal completeness. No read-time repricing. */

import * as z from "zod";

export const KernelPricingEvidenceSchema = z
	.object({
		knownSubtotalUsd: z.number().finite().min(0),
		attemptCount: z.number().int().min(0),
		pricedAttemptCount: z.number().int().min(0),
		costCompleteness: z.enum(["complete", "partial", "unknown", "no_usage"]),
		reason: z
			.string()
			.nullable()
			.describe(
				"Null when all actual attempts are priced or no inference was dispatched.",
			),
		executionId: z
			.string()
			.nullable()
			.describe(
				"Null when historical evidence has no immutable execution receipt or the aggregate spans multiple executions.",
			),
		rateVersionId: z
			.string()
			.nullable()
			.describe(
				"Null for provider-reported, historical, unknown, or multiple-rate evidence.",
			),
	})
	.superRefine((value, ctx) => {
		if (
			value.pricedAttemptCount > value.attemptCount ||
			(value.costCompleteness === "complete" &&
				(value.attemptCount === 0 ||
					value.pricedAttemptCount !== value.attemptCount)) ||
			(value.costCompleteness === "no_usage" &&
				(value.attemptCount !== 0 || value.knownSubtotalUsd !== 0)) ||
			(value.costCompleteness === "unknown" && value.pricedAttemptCount !== 0)
		)
			ctx.addIssue({
				code: "custom",
				message: "Inconsistent attempt cost evidence",
			});
	});
export type KernelPricingEvidence = z.infer<typeof KernelPricingEvidenceSchema>;

export const PersistedCostBasisSchema = z.enum([
	"gateway_reported",
	"governed_estimate",
	"legacy_estimate",
	"unknown",
]);
export const CostSummarySchema = z.object({
	knownSubtotalUsd: z.number().min(0),
	pricedRowCount: z.number().int().min(0),
	unpricedRowCount: z.number().int().min(0),
	unpricedTokens: z.number().int().min(0),
	costCompleteness: z.enum(["complete", "partial", "unknown"]),
});
export type CostSummary = z.infer<typeof CostSummarySchema>;
export function costSummary(
	input: Omit<CostSummary, "costCompleteness">,
): CostSummary {
	return {
		knownSubtotalUsd: input.knownSubtotalUsd,
		pricedRowCount: input.pricedRowCount,
		unpricedRowCount: input.unpricedRowCount,
		unpricedTokens: input.unpricedTokens,
		costCompleteness:
			input.pricedRowCount === 0
				? "unknown"
				: input.unpricedRowCount > 0
					? "partial"
					: "complete",
	};
}

// =============================================================================
// PROVENANCE
// =============================================================================

/**
 * Trust ordering, weakest first. A rollup over mixed rows may claim no more
 * than its WEAKEST contributing row — see {@link provenanceFloor}.
 */
export const COST_PROVENANCE_ORDER = [
	"quarantined",
	"unknown",
	"pricing_table_estimate",
	"gateway_reported",
	"provider_reported",
] as const;

export const CostProvenanceSchema = z.enum([
	"provider_reported",
	"gateway_reported",
	"pricing_table_estimate",
	"unknown",
	"quarantined",
]);
export type CostProvenance = z.infer<typeof CostProvenanceSchema>;

/**
 * Which labels this deployment can currently EARN. `provider_reported` is
 * false: no model provider's billed amount is read anywhere in the model-spend
 * path. A surface renders an unearnable label only to explain that it is empty
 * and why — never as the provenance of a rendered number.
 */
export const COST_PROVENANCE_PRODUCED_TODAY: Readonly<
	Record<CostProvenance, boolean>
> = {
	provider_reported: false,
	gateway_reported: true,
	pricing_table_estimate: true,
	unknown: true,
	quarantined: true,
};

/** One-line operator explanation per label. Stable text; assertable in tests. */
export const COST_PROVENANCE_DETAIL: Readonly<Record<CostProvenance, string>> =
	{
		provider_reported:
			"The model provider's own billed amount. Nothing in this deployment reads one — model spend is never provider-reported here, and invoice reconciliation lives in the administrative billing plane.",
		gateway_reported:
			"Cloudflare AI Gateway's own charge for the call, stored verbatim. Produced only for Workers AI traffic.",
		pricing_table_estimate:
			"A persisted governed or historical estimate. Current rates never rewrite historical evidence; this is an estimate, not a bill.",
		unknown:
			"The row exists but nothing on it records which branch produced the number, so its basis cannot be attested.",
		quarantined:
			"Held out of spend totals by ingestion or settlement. A recorded zero differs from an unknown amount; neither is included in spend.",
	};

/** The canonical read location backing each label, quoted in explanations. */
export const COST_PROVENANCE_SOURCE: Readonly<Record<CostProvenance, string>> =
	{
		provider_reported:
			"billing_provider_reconciliations (administrative billing only)",
		gateway_reported:
			"tedi_call_costs.estimated_cost_usd (provider=workers-ai)",
		pricing_table_estimate: "tedi_call_costs.cost_basis / rate_version_id",
		unknown: "tedi_call_costs.cost_basis / cost_reason",
		quarantined: "tedi_call_costs.data_quality / billing_usage_quarantines",
	};

/** Historical no-pricing placeholders remain raw evidence, never attested zero. */
export function persistedCostAmount(row: {
	estimatedCostUsd: number | null;
	costBasis: z.infer<typeof PersistedCostBasisSchema>;
	dataQuality: "ok" | "quarantined_no_pricing" | "quarantined_failed";
}): number | null {
	if (
		row.costBasis === "unknown" ||
		(row.costBasis === "legacy_estimate" &&
			row.dataQuality === "quarantined_no_pricing")
	)
		return null;
	return row.estimatedCostUsd !== null &&
		Number.isFinite(row.estimatedCostUsd) &&
		row.estimatedCostUsd >= 0
		? row.estimatedCostUsd
		: null;
}

/** Persisted basis is authoritative, including explicit known zero. */
export function ledgerRowProvenance(row: {
	dataQuality: "ok" | "quarantined_no_pricing" | "quarantined_failed";
	estimatedCostUsd: number | null;
	costBasis: z.infer<typeof PersistedCostBasisSchema>;
}): CostProvenance {
	if (row.dataQuality !== "ok") return "quarantined";
	if (persistedCostAmount(row) === null) return "unknown";
	if (row.costBasis === "gateway_reported") return "gateway_reported";
	if (
		row.costBasis === "governed_estimate" ||
		row.costBasis === "legacy_estimate"
	)
		return "pricing_table_estimate";
	return "unknown";
}

/**
 * The label a rollup may claim: the weakest label present. A mix of
 * gateway-reported and estimated rows is an ESTIMATE, because part of it is.
 * Returns null for an empty mix — an empty rollup has no provenance, and
 * claiming one would be the exact "confident zero" this module exists to stop.
 */
export function provenanceFloor(
	present: Iterable<CostProvenance>,
): CostProvenance | null {
	let floorIndex: number = COST_PROVENANCE_ORDER.length;
	for (const label of present) {
		const index = COST_PROVENANCE_ORDER.indexOf(label);
		if (index >= 0 && index < floorIndex) floorIndex = index;
	}
	return COST_PROVENANCE_ORDER[floorIndex] ?? null;
}

/** Per-label rollup. `costUsd` for a quarantined bucket is held-out value. */
export const CostProvenanceBucketSchema = z.object({
	provenance: CostProvenanceSchema,
	rowCount: z.number().int().min(0),
	totalTokens: z.number().int().min(0),
	costUsd: z
		.number()
		.min(0)
		.nullable()
		.describe(
			"Null when contributing cost evidence is incomplete; known subtotal remains separate and explicit zero is preserved.",
		),
	knownSubtotalUsd: z.number().min(0),
});
export type CostProvenanceBucket = z.infer<typeof CostProvenanceBucketSchema>;

// =============================================================================
// INGESTION FRESHNESS
// =============================================================================

/**
 * The gateway-cost ingestion cron interval, in minutes — the every-15-minutes
 * schedule in `apps/api/src/jobs/scheduled-dispatch.ts` that runs
 * `runBillingAndGatewayCostTick`. Work newer than this has not had a chance to
 * be ingested, so the tail of any window is PENDING, not empty.
 */
export const COST_INGESTION_INTERVAL_MINUTES = 15;

/**
 * Staleness ladder in hours, matching the platform health digest's
 * `LEDGER_STALE_BUCKETS_HOURS` (`apps/api/src/lib/health-digest.ts`) so the OS
 * never disagrees with the pager about what "dark" means. `cost-ledger-dark`
 * pages P1 above 6h.
 */
export const COST_LEDGER_STALE_BUCKET_HOURS = [6, 24, 72, 168] as const;

/**
 * `never_ingested` is the state an ingestion blackout wore for a week while
 * the drilldown reported `$0 / level "ok" / score 1`. It is NOT "zero spend" —
 * it is indistinguishable from a dead ingester, and must render as an absence.
 */
export const CostLedgerFreshnessStateSchema = z.enum([
	"fresh",
	"ingestion_pending",
	"lagging",
	"dark",
	"never_ingested",
]);
export type CostLedgerFreshnessState = z.infer<
	typeof CostLedgerFreshnessStateSchema
>;

export const CostLedgerFreshnessSchema = z.object({
	state: CostLedgerFreshnessStateSchema,
	lastRowAt: z
		.string()
		.nullable()
		.describe(
			"Newest ingested row's gateway `created_at` (end-to-end freshness), null when the org has no rows in the window",
		),
	staleMinutes: z
		.number()
		.min(0)
		.nullable()
		.describe("Age of `lastRowAt`; null when there is no row to age"),
	rowsLast24h: z.number().int().min(0),
	rowsLast30d: z.number().int().min(0),
	detail: z.string(),
});
export type CostLedgerFreshness = z.infer<typeof CostLedgerFreshnessSchema>;

/**
 * Classify freshness. Fresh means a row landed within one cron interval.
 * `ingestion_pending` covers the ordinary gap between the last tick and now —
 * the honest reason a just-finished run has no cost yet. Beyond that the digest
 * ladder takes over, and `dark` mirrors the P1 the pager already fires.
 *
 * `rowsLast30d === 0` short-circuits to `never_ingested` BEFORE any age math:
 * with no rows there is nothing to age, and a quiet org and a dead ingester are
 * indistinguishable from here. We refuse to claim either.
 */
export function classifyLedgerFreshness(
	probe: { lastRowAt: string | null; rowsLast24h: number; rowsLast30d: number },
	nowMs: number,
): CostLedgerFreshness {
	if (probe.rowsLast30d === 0 || probe.lastRowAt === null) {
		return {
			state: "never_ingested",
			lastRowAt: null,
			staleMinutes: null,
			rowsLast24h: probe.rowsLast24h,
			rowsLast30d: probe.rowsLast30d,
			detail:
				"No cost rows in the last 30 days. This is indistinguishable from a stalled ingestion job, so no spend can be attested for this workspace — it is not $0.",
		};
	}
	const parsed = Date.parse(probe.lastRowAt);
	if (Number.isNaN(parsed)) {
		return {
			state: "never_ingested",
			lastRowAt: null,
			staleMinutes: null,
			rowsLast24h: probe.rowsLast24h,
			rowsLast30d: probe.rowsLast30d,
			detail: "The newest cost row carries an unparseable timestamp.",
		};
	}
	const staleMinutes = Math.max(0, (nowMs - parsed) / 60_000);
	const staleHours = staleMinutes / 60;
	const base = {
		lastRowAt: probe.lastRowAt,
		staleMinutes,
		rowsLast24h: probe.rowsLast24h,
		rowsLast30d: probe.rowsLast30d,
	};
	if (staleMinutes <= COST_INGESTION_INTERVAL_MINUTES) {
		return {
			...base,
			state: "fresh",
			detail: `Ingested within the last ${COST_INGESTION_INTERVAL_MINUTES} minutes.`,
		};
	}
	if (staleHours < COST_LEDGER_STALE_BUCKET_HOURS[0]) {
		return {
			...base,
			state: "ingestion_pending",
			detail: `The cost ledger ingests every ${COST_INGESTION_INTERVAL_MINUTES} minutes; work newer than the last tick is not counted yet.`,
		};
	}
	if (staleHours < COST_LEDGER_STALE_BUCKET_HOURS[1]) {
		return {
			...base,
			state: "lagging",
			detail: `No cost row for ${Math.round(staleHours)}h — past the ${COST_LEDGER_STALE_BUCKET_HOURS[0]}h threshold the platform pages on.`,
		};
	}
	return {
		...base,
		state: "dark",
		detail: `No cost row for ${Math.round(staleHours)}h. Cost ingestion is dark; totals below understate real spend by an unknown amount.`,
	};
}

// =============================================================================
// CREDENTIAL HEALTH AND POLICY DRIFT
// =============================================================================

/**
 * AI Gateway credential health for the SERVING DEPLOYMENT — not
 * per-organization, and not per-provider. Scope is on the wire so a reader
 * cannot mistake it for their own tenant's credentials.
 *
 * There is deliberately no `healthy` value, because nothing stores one.
 * `ops_alert_state` records credential TRANSITIONS, not a heartbeat: while
 * probes keep succeeding `reconcileCloudflareCredentialFinding` returns
 * `unchanged` and writes nothing, so a `resolved` row's `lastSeenAt` is when
 * drift was REPAIRED, not evidence of a current successful probe. Reading it as
 * "healthy" would be a claim no read supports.
 *
 * What CAN be evidenced is `evidenced_ok`: fresh ingestion. If cost rows landed
 * within one ingestion interval then the AI Gateway logs API answered with
 * those credentials, which is an actual observation rather than the absence of
 * an alarm. Everything else is `unattested`.
 *
 * Model PROVIDER health has no durable observation store, so it is reported
 * separately and always `unknown`.
 */
export const CostCredentialHealthSchema = z.object({
	scope: z.literal("platform_ai_gateway"),
	status: z.enum(["firing", "evidenced_ok", "unattested"]),
	observedAt: z
		.string()
		.nullable()
		.describe(
			"For `firing`, the live heartbeat of the open condition. For `evidenced_ok`, the newest ingested row that evidences a working probe. Null when nothing was observed.",
		),
	detail: z.string(),
});
export type CostCredentialHealth = z.infer<typeof CostCredentialHealthSchema>;

/**
 * Classify deployment credential health from the two things that actually
 * record something: the open/resolved drift condition, and whether cost rows
 * are currently arriving.
 *
 * An open condition wins outright — drift is a positive detection. Otherwise
 * only live ingestion evidences the credential pair; a resolved row does not,
 * for the reason above.
 */
export function classifyCredentialHealth(input: {
	alert: { status: "open" | "resolved"; lastSeenAt: string } | null;
	freshness: CostLedgerFreshness;
}): CostCredentialHealth {
	if (input.alert?.status === "open") {
		return {
			scope: "platform_ai_gateway",
			status: "firing",
			observedAt: input.alert.lastSeenAt,
			detail:
				"The serving deployment's AI Gateway credential pair is drifted, so cost ingestion is failing for every tenant on it and spend below is understated. Repair is a platform secrets operation.",
		};
	}
	if (input.freshness.state === "fresh") {
		return {
			scope: "platform_ai_gateway",
			status: "evidenced_ok",
			observedAt: input.freshness.lastRowAt,
			detail:
				"Cost rows arrived within the last ingestion interval, so the AI Gateway logs API answered with the deployment's credentials. Evidenced by ingestion, not by a health check.",
		};
	}
	return {
		scope: "platform_ai_gateway",
		status: "unattested",
		observedAt: input.freshness.lastRowAt,
		detail:
			"No open credential-drift condition and no fresh ingestion to evidence the credentials. Nothing stores a passing probe, so credential health is unattested here — not healthy.",
	};
}

/**
 * Model-provider health, always `unknown`. Kept as an explicit field rather
 * than omitted so the surface shows the gap instead of implying health by
 * silence. Mirrors the model catalog's `provider_health` verdict, which states
 * the same fact for the same reason.
 */
export const COST_PROVIDER_HEALTH_DETAIL =
	"No durable provider-health signal exists. The only breaker is an in-memory, per-isolate circuit inside the Agent runtime, unreadable from the control plane — so provider health is unknown here, not healthy.";

/**
 * D1 is the sole admission authority. The Gateway records provider cost but
 * never projects or enforces tenant spend rules, so this read is exact rather
 * than a desired-versus-actual comparison.
 */
export const CostAdmissionPolicySchema = z.object({
	state: z.literal("d1_authoritative"),
	desiredDailyTokenLimit: z
		.number()
		.int()
		.min(0)
		.nullable()
		.describe(
			"Null when no daily token limit is configured in D1 — an absent cap, not a cap of 0. D1 enforces this value during atomic reservation",
		),
	desiredDailySpendLimitMicros: z
		.number()
		.int()
		.min(0)
		.nullable()
		.describe(
			"Null when no daily spend limit is configured in D1 — an absent cap, not a cap of 0. D1 enforces this value during atomic reservation",
		),
	detail: z.string(),
});
export type CostAdmissionPolicy = z.infer<typeof CostAdmissionPolicySchema>;

export const COST_ADMISSION_POLICY_DETAIL =
	"D1 is the sole inference-admission authority. Daily token and spend limits are checked atomically with reservations; AI Gateway only records provider usage and cost.";

// =============================================================================
// ATTRIBUTION
// =============================================================================

/**
 * Cost the ledger could not attribute to a tedi/kernel session.
 *
 * `orphanedRowsVisible` is false and load-bearing. Truly orphaned spend has a
 * NULL `org_id` — the DB trigger `require_org_id_for_attributed_calls` permits
 * NULL only for `session_type = 'unattributed'` — and every org-scoped read
 * filters on `org_id`, so those rows are structurally invisible here. What this
 * object reports is unattributed-SESSION cost that still carries an org. It is
 * a floor, never a total, and the surface must say so.
 */
export const CostAttributionGapSchema = z.object({
	unattributedCostUsd: z.number().min(0),
	unattributedTokens: z.number().int().min(0),
	/**
	 * Rows that CONTRIBUTED to the amount above. Quarantined unattributed rows
	 * are counted separately, so dividing cost by this count yields a per-call
	 * rate every contributing row actually supports.
	 */
	unattributedRowCount: z.number().int().min(0),
	/** Unattributed rows held out of the amount above, counted but never priced. */
	unattributedQuarantinedRowCount: z.number().int().min(0),
	orphanedRowsVisible: z.literal(false),
	detail: z.string(),
});
export type CostAttributionGap = z.infer<typeof CostAttributionGapSchema>;

export const COST_ATTRIBUTION_GAP_DETAIL =
	"Unattributed rows that still carry this organization. Rows with no organization at all are invisible to every org-scoped read, so this is a floor on unattributed spend, never a total.";
