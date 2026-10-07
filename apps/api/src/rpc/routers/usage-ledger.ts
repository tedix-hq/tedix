import type { OrgCallCostLedgerRow } from "@tedix/db/queries/usage-ledger";

export type CostPeriod = "24h" | "7d" | "30d";

/** The 3 sessionType values a direct AI-Gateway-log row can carry. */
export type LedgerSessionType =
	| "tedi"
	| "tedi_observer"
	| "kernel"
	| "unattributed";

export interface NormalizedLedgerRow {
	providerCostEvidence: OrgCallCostLedgerRow["providerCostEvidence"];
	sourceRetired: boolean;
	id: string;
	tediId: string;
	tediName: string;
	tediSlug: string;
	snapshotAt: string;
	model: string;
	provider: string | null;
	providerResource: string | null;
	providerBaseUrl: string | null;
	deployment: string | null;
	runId: string | null;
	workItemId: string | null;
	sessionKeyHash: string | null;
	sessionType: LedgerSessionType;
	source: string;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalTokens: number;
	estimatedCostUsd: number | null;
	callDurationMs: number | null;
	executionId: string | null;
	rawEstimatedCostUsd: number | null;
	costBasis: OrgCallCostLedgerRow["costBasis"];
	rateVersionId: string | null;
	costReason: string | null;
	/** Ingestion-time data-quality flag carried straight from `tedi_call_costs`. */
	dataQuality: "ok" | "quarantined_no_pricing" | "quarantined_failed";
	sessionCount: number;
	createdAt: string | null;
	billingCategory: string;
	billable: boolean;
	billableTokens: number;
	billableCostUsd: number;
	invoiceReady: boolean;
	invoiceReadyTokens: number;
	invoiceReadyCostUsd: number;
	reconciliationStatus: "ready" | "quarantined";
	reconciliationReasons: BillingDataQualityIssue["code"][];
	quarantinedTokens: number;
	quarantinedCostUsd: number;
	pricingVersion: string;
	attributionVersion: string;
}

export interface CostAggregate {
	reviewedEstimateRowCount: number;
	reviewedEstimateTokens: number;
	reviewedEstimateMicros: number;
	sourceRetiredRowCount: number;
	knownSubtotalUsd: number;
	pricedRowCount: number;
	unpricedRowCount: number;
	unpricedTokens: number;
	costCompleteness: "complete" | "partial" | "unknown";
	key: string;
	label: string;
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCacheReadTokens: number;
	totalCacheWriteTokens: number;
	totalTokens: number;
	totalCostUsd: number | null;
	billableTokens: number;
	billableCostUsd: number;
	invoiceReadyTokens: number;
	invoiceReadyCostUsd: number;
	quarantinedTokens: number;
	quarantinedCostUsd: number;
	rowCount: number;
}

export interface CostDrilldown {
	totals: {
		reviewedEstimateRowCount: number;
		reviewedEstimateTokens: number;
		reviewedEstimateMicros: number;
		sourceRetiredRowCount: number;
		knownSubtotalUsd: number;
		pricedRowCount: number;
		unpricedRowCount: number;
		unpricedTokens: number;
		costCompleteness: "complete" | "partial" | "unknown";
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens: number;
		cacheWriteTokens: number;
		totalTokens: number;
		estimatedCostUsd: number | null;
		billableTokens: number;
		billableCostUsd: number;
		invoiceReadyTokens: number;
		invoiceReadyCostUsd: number;
		quarantinedTokens: number;
		quarantinedCostUsd: number;
		nonBillableCostUsd: number;
		unattributedCostUsd: number;
	};
	billing: {
		pricingVersion: string;
		attributionVersion: string;
		dailyRunRateUsd: number | null;
		projectedMonthlyCostUsd: number | null;
		invoiceReady: boolean;
		invoiceReadyTokenShare: number | null;
		quarantinedTokenShare: number | null;
		quarantinedCostShare: number | null;
		unattributedShare: number | null;
	};
	dataQuality: BillingDataQuality;
	byTedi: Array<
		CostAggregate & {
			tediId: string;
			tediName: string;
			tediSlug: string;
		}
	>;
	bySource: Array<
		CostAggregate & {
			source: string;
			sessionType: string;
		}
	>;
	byCategory: Array<
		CostAggregate & {
			billingCategory: string;
		}
	>;
	byModel: Array<
		CostAggregate & {
			model: string;
			provider: string | null;
			providerResource: string | null;
			deployment: string | null;
		}
	>;
	byResource: Array<
		CostAggregate & {
			provider: string | null;
			providerResource: string | null;
			providerBaseUrl: string | null;
			deployment: string | null;
		}
	>;
	daily: Array<
		CostAggregate & {
			date: string;
		}
	>;
}

export interface BillingDataQualityIssue {
	code:
		| "unknown_model"
		| "unpriced_tokens"
		| "ingestion_quarantined"
		| "empty_ledger";
	severity: "warning" | "critical";
	message: string;
	rowCount: number;
	totalTokens: number;
	totalCostUsd: number;
	tokenShare: number | null;
	costShare: number | null;
}

export interface BillingDataQualityTedi {
	tediId: string;
	tediName: string;
	tediSlug: string;
	rowCount: number;
	totalTokens: number;
	totalCostUsd: number;
	issueRowCount: number;
	issueTokens: number;
	issueCostUsd: number;
	issueTokenShare: number | null;
	issueCostShare: number | null;
}

export interface BillingDataQualityProblemRow {
	id: string;
	tediId: string;
	tediName: string;
	tediSlug: string;
	snapshotAt: string;
	model: string;
	source: string;
	sessionType: string;
	totalTokens: number;
	estimatedCostUsd: number | null;
	flags: BillingDataQualityIssue["code"][];
}

export interface BillingDataQuality {
	level: "ok" | "warning" | "critical";
	score: number;
	rowCount: number;
	issueRowCount: number;
	totalTokens: number;
	issueTokens: number;
	totalCostUsd: number;
	issueCostUsd: number;
	issueTokenShare: number | null;
	issueCostShare: number | null;
	pricedTokenShare: number | null;
	unknownModelTokenShare: number | null;
	zeroCostTokenShare: number | null;
	issues: BillingDataQualityIssue[];
	byTedi: BillingDataQualityTedi[];
	recentProblemRows: BillingDataQualityProblemRow[];
	recommendations: string[];
}

export const USAGE_PRICING_VERSION = "persisted-event-time-provenance";
export const USAGE_ATTRIBUTION_VERSION = "immutable-execution-v3";
const UNATTRIBUTED_SESSION_TYPE: LedgerSessionType = "unattributed";

/**
 * Billing category derived straight from the gateway log row's own
 * sessionType — direct attribution, no source-based special-casing (every
 * row now comes from the single `ai-gateway-log` source).
 */
export function billingCategory(sessionType: LedgerSessionType): string {
	switch (sessionType) {
		case "tedi":
			return "main_agent";
		case "tedi_observer":
			return "automation";
		case "kernel":
			return "kernel";
		default:
			return "unattributed";
	}
}

function qualityFlagsForValues(
	row: Pick<
		NormalizedLedgerRow,
		"model" | "totalTokens" | "estimatedCostUsd" | "dataQuality"
	>,
): BillingDataQualityIssue["code"][] {
	const flags: BillingDataQualityIssue["code"][] = [];
	if (!row.model.trim() || row.model === "unknown") flags.push("unknown_model");
	if (row.estimatedCostUsd === null) {
		flags.push("unpriced_tokens");
	}
	if (row.dataQuality !== "ok") flags.push("ingestion_quarantined");
	return flags;
}

function qualityFlags(
	row: NormalizedLedgerRow,
): BillingDataQualityIssue["code"][] {
	return row.reconciliationReasons.length > 0
		? row.reconciliationReasons
		: qualityFlagsForValues(row);
}

// Every quality flag currently defined quarantines the row from invoice-ready
// totals — direct per-call attribution leaves no "known issue, still billable"
// middle ground the way the old session-bracketing model did.
function isQuarantineReason(_code: BillingDataQualityIssue["code"]): boolean {
	return true;
}

function normalizeEstimatedCost(
	row: OrgCallCostLedgerRow,
): Pick<
	NormalizedLedgerRow,
	| "estimatedCostUsd"
	| "rawEstimatedCostUsd"
	| "costBasis"
	| "rateVersionId"
	| "costReason"
> {
	const amount = row.estimatedCostUsd;
	const evidence = row.providerCostEvidence;
	return {
		estimatedCostUsd:
			evidence !== null && evidence !== undefined
				? evidence.providerEstimatedCostMicros / 1_000_000
				: row.dataQuality === "ok" &&
					  row.costBasis !== "unknown" &&
					  typeof amount === "number" &&
					  Number.isFinite(amount) &&
					  amount >= 0
					? amount
					: null,
		rawEstimatedCostUsd: amount,
		costBasis: row.costBasis,
		rateVersionId: row.rateVersionId,
		costReason: row.costReason,
	};
}

function withReconciliation(row: NormalizedLedgerRow): NormalizedLedgerRow {
	const reconciliationReasons = qualityFlagsForValues(row);
	const quarantineReasons = reconciliationReasons.filter(isQuarantineReason);
	const invoiceReady =
		row.providerCostEvidence === null &&
		!row.sourceRetired &&
		quarantineReasons.length === 0;
	const billable = invoiceReady;
	return {
		...row,
		billable,
		billableTokens: billable ? row.totalTokens : 0,
		billableCostUsd: billable ? row.estimatedCostUsd! : 0,
		invoiceReady,
		invoiceReadyTokens: invoiceReady ? row.totalTokens : 0,
		invoiceReadyCostUsd: invoiceReady ? row.estimatedCostUsd! : 0,
		reconciliationStatus: invoiceReady ? "ready" : "quarantined",
		reconciliationReasons,
		quarantinedTokens: invoiceReady ? 0 : row.totalTokens,
		quarantinedCostUsd: invoiceReady
			? 0
			: row.providerCostEvidence !== null
				? row.providerCostEvidence.originalDataQuality === "ok" &&
					row.providerCostEvidence.originalCostBasis !== "unknown" &&
					typeof row.providerCostEvidence.originalEstimatedCostUsd ===
						"number" &&
					Number.isFinite(row.providerCostEvidence.originalEstimatedCostUsd) &&
					row.providerCostEvidence.originalEstimatedCostUsd >= 0
					? row.providerCostEvidence.originalEstimatedCostUsd
					: 0
				: (row.estimatedCostUsd ?? 0),
	};
}

export function normalizeLedgerRows(
	rows: OrgCallCostLedgerRow[],
): NormalizedLedgerRow[] {
	return rows.map((row) => {
		const sessionType = (row.sessionType ||
			UNATTRIBUTED_SESSION_TYPE) as LedgerSessionType;
		const tediId = row.tediId ?? "unattributed";
		const tediName =
			row.tediName ?? (row.tediId ? "Unknown tedi" : "Unattributed");
		const tediSlug = row.tediSlug ?? (row.tediId ? "unknown" : "unattributed");
		const model = row.model?.trim() ? row.model : "unknown";
		const deployment = row.deployment ?? (model !== "unknown" ? model : null);
		const providerResource = row.providerResource ?? null;
		const providerBaseUrl = row.providerBaseUrl ?? null;
		const runId = row.runId ?? null;
		const workItemId = row.workItemId ?? null;
		const sessionKeyHash = row.sessionKeyHash ?? null;
		const dataQuality = row.dataQuality;
		const cost = normalizeEstimatedCost(row);
		return withReconciliation({
			id: row.id,
			providerCostEvidence: row.providerCostEvidence,
			sourceRetired: row.sourceRetired,
			// The ledger intentionally includes org-scoped platform/kernel rows with
			// no tedi. Give them a stable aggregate key instead of dropping them.
			tediId,
			tediName,
			tediSlug,
			snapshotAt: row.snapshotAt,
			model,
			provider: row.provider ?? null,
			providerResource,
			providerBaseUrl,
			deployment,
			runId,
			workItemId,
			sessionKeyHash,
			sessionType,
			source: row.source,
			inputTokens: row.inputTokens,
			outputTokens: row.outputTokens,
			cacheReadTokens: row.cacheReadTokens,
			cacheWriteTokens: row.cacheWriteTokens,
			totalTokens: row.totalTokens,
			estimatedCostUsd: cost.estimatedCostUsd,
			callDurationMs: row.callDurationMs,
			executionId: row.executionId,
			rawEstimatedCostUsd: cost.rawEstimatedCostUsd,
			costBasis: cost.costBasis,
			rateVersionId: cost.rateVersionId,
			costReason: cost.costReason,
			dataQuality,
			sessionCount: row.sessionCount,
			createdAt: row.createdAt ?? null,
			billingCategory: billingCategory(sessionType),
			billable: false,
			billableTokens: 0,
			billableCostUsd: 0,
			invoiceReady: false,
			invoiceReadyTokens: 0,
			invoiceReadyCostUsd: 0,
			reconciliationStatus: "quarantined",
			reconciliationReasons: [],
			quarantinedTokens: row.totalTokens,
			quarantinedCostUsd: cost.estimatedCostUsd ?? 0,
			pricingVersion:
				row.providerCostEvidence?.versionId ??
				row.rateVersionId ??
				row.costBasis,
			attributionVersion: USAGE_ATTRIBUTION_VERSION,
		});
	});
}

function completeness(value: {
	pricedRowCount: number;
	unpricedRowCount: number;
}): "complete" | "partial" | "unknown" {
	return value.pricedRowCount === 0
		? "unknown"
		: value.unpricedRowCount > 0
			? "partial"
			: "complete";
}

function emptyAggregate(key: string, label: string): CostAggregate {
	return {
		key,
		label,
		knownSubtotalUsd: 0,
		reviewedEstimateRowCount: 0,
		reviewedEstimateTokens: 0,
		reviewedEstimateMicros: 0,
		sourceRetiredRowCount: 0,
		pricedRowCount: 0,
		unpricedRowCount: 0,
		unpricedTokens: 0,
		costCompleteness: "unknown",
		totalInputTokens: 0,
		totalOutputTokens: 0,
		totalCacheReadTokens: 0,
		totalCacheWriteTokens: 0,
		totalTokens: 0,
		totalCostUsd: 0,
		billableTokens: 0,
		billableCostUsd: 0,
		invoiceReadyTokens: 0,
		invoiceReadyCostUsd: 0,
		quarantinedTokens: 0,
		quarantinedCostUsd: 0,
		rowCount: 0,
	};
}

function addToAggregate(aggregate: CostAggregate, row: NormalizedLedgerRow) {
	if (row.providerCostEvidence) {
		aggregate.reviewedEstimateRowCount++;
		aggregate.reviewedEstimateTokens += row.totalTokens;
		aggregate.reviewedEstimateMicros +=
			row.providerCostEvidence.providerEstimatedCostMicros;
	}
	if (row.sourceRetired) aggregate.sourceRetiredRowCount++;
	aggregate.totalInputTokens += row.inputTokens;
	aggregate.totalOutputTokens += row.outputTokens;
	aggregate.totalCacheReadTokens += row.cacheReadTokens;
	aggregate.totalCacheWriteTokens += row.cacheWriteTokens;
	aggregate.totalTokens += row.totalTokens;
	aggregate.knownSubtotalUsd += row.estimatedCostUsd ?? 0;
	if (row.estimatedCostUsd === null) {
		aggregate.unpricedRowCount++;
		aggregate.unpricedTokens += row.totalTokens;
	} else aggregate.pricedRowCount++;
	aggregate.costCompleteness = completeness(aggregate);
	aggregate.totalCostUsd =
		aggregate.costCompleteness === "complete"
			? aggregate.knownSubtotalUsd
			: null;
	aggregate.billableTokens += row.billableTokens;
	aggregate.billableCostUsd += row.billableCostUsd;
	aggregate.invoiceReadyTokens += row.invoiceReadyTokens;
	aggregate.invoiceReadyCostUsd += row.invoiceReadyCostUsd;
	aggregate.quarantinedTokens += row.quarantinedTokens;
	aggregate.quarantinedCostUsd += row.quarantinedCostUsd;
	aggregate.rowCount++;
}

function sorted<T extends CostAggregate>(values: Iterable<T>): T[] {
	return [...values].sort((a, b) => b.knownSubtotalUsd - a.knownSubtotalUsd);
}

function share(numerator: number, denominator: number): number | null {
	return denominator > 0 ? numerator / denominator : null;
}

const QUALITY_MESSAGES: Record<BillingDataQualityIssue["code"], string> = {
	unknown_model:
		"Rows contain nonzero usage whose model could not be resolved.",
	unpriced_tokens: "Rows have no attested cost; explicit known zero is priced.",
	ingestion_quarantined:
		"Rows were flagged by the AI Gateway ingestion job itself (failed call or no pricing-table match) and are excluded from spend totals.",
	empty_ledger:
		"No usage rows in this window — cost cannot be attested, and this is indistinguishable from a fully failed ingestion.",
};

function severityForQualityIssue(
	code: BillingDataQualityIssue["code"],
	tokenShare: number | null,
	costShare: number | null,
): BillingDataQualityIssue["severity"] {
	const token = tokenShare ?? 0;
	const cost = costShare ?? 0;
	if (code === "unpriced_tokens" || code === "unknown_model") {
		return token >= 0.05 ? "critical" : "warning";
	}
	if (code === "ingestion_quarantined") {
		return cost >= 0.1 || token >= 0.1 ? "critical" : "warning";
	}
	return "warning";
}

/**
 * An EMPTY ledger is not a CLEAN ledger.
 *
 * With zero rows the scoring below degenerates to the perfect result: no rows ⇒
 * no issues ⇒ `level: "ok"`, and every debt share is null-coalesced away so
 * `maxDebtShare` is 0 ⇒ `score: 1`, with the recommendation "Ledger quality is
 * clean for this window." That is a false healthy: it is exactly what a totally
 * broken ingestion pipeline looks like from here (for example
 * `ingestGatewayLogCosts` failing every AI Gateway fetch and swallowing it).
 *
 * We cannot distinguish "genuinely quiet org" from "ingestion is down" here —
 * this function only sees rows. So we must not claim either. Zero rows now
 * reports `warning` / score 0 and says plainly that no attestation is possible,
 * pointing at the ingestion cron as the first thing to check. Fail loud, not
 * healthy — the same rule the capability gate learned
 * (docs/decisions/agent-capability-mutation-gate.md).
 *
 * This is load-bearing for more than a dashboard: `cost-latency-anomaly-watcher`
 * exists to alert on "spend up 2x vs the 7-day baseline". With an empty ledger
 * both sides read 0, so it could never fire — a watchdog structurally incapable
 * of barking.
 */
function buildDataQuality(rows: NormalizedLedgerRow[]): BillingDataQuality {
	if (rows.length === 0) {
		return {
			level: "warning",
			score: 0,
			rowCount: 0,
			issueRowCount: 0,
			totalTokens: 0,
			issueTokens: 0,
			totalCostUsd: 0,
			issueCostUsd: 0,
			issueTokenShare: null,
			issueCostShare: null,
			pricedTokenShare: null,
			unknownModelTokenShare: null,
			zeroCostTokenShare: null,
			issues: [
				{
					code: "empty_ledger",
					severity: "warning",
					message:
						"No usage rows in this window — cost cannot be attested. This is indistinguishable from a fully failed ingestion, so it is NOT reported as clean.",
					rowCount: 0,
					totalTokens: 0,
					totalCostUsd: 0,
					tokenShare: null,
					costShare: null,
				},
			],
			byTedi: [],
			recentProblemRows: [],
			recommendations: [
				"Zero usage rows: verify the gateway-cost-ingestion cron (*/15) is actually ingesting — a persistent AI Gateway auth/fetch failure produces exactly this shape. Check the scheduled-handler logs for `[gateway-cost-ingestion]` failures before trusting a $0 total.",
			],
		};
	}

	const issueStats = new Map<
		BillingDataQualityIssue["code"],
		{ rowCount: number; totalTokens: number; totalCostUsd: number }
	>();
	const tediStats = new Map<string, BillingDataQualityTedi>();
	const problemRowIds = new Set<string>();
	const recentProblemRows: BillingDataQualityProblemRow[] = [];

	let totalTokens = 0;
	let totalCostUsd = 0;
	let issueTokens = 0;
	let issueCostUsd = 0;
	let pricedTokens = 0;
	let unknownModelTokens = 0;
	let zeroCostTokens = 0;

	for (const row of rows) {
		totalTokens += row.totalTokens;
		totalCostUsd += row.estimatedCostUsd ?? 0;
		if (row.estimatedCostUsd !== null) {
			pricedTokens += row.totalTokens;
		}

		let tedi = tediStats.get(row.tediId);
		if (!tedi) {
			tedi = {
				tediId: row.tediId,
				tediName: row.tediName,
				tediSlug: row.tediSlug,
				rowCount: 0,
				totalTokens: 0,
				totalCostUsd: 0,
				issueRowCount: 0,
				issueTokens: 0,
				issueCostUsd: 0,
				issueTokenShare: null,
				issueCostShare: null,
			};
			tediStats.set(row.tediId, tedi);
		}
		tedi.rowCount++;
		tedi.totalTokens += row.totalTokens;
		tedi.totalCostUsd += row.estimatedCostUsd ?? 0;

		const flags = qualityFlags(row);
		if (flags.length === 0) continue;

		problemRowIds.add(row.id);
		issueTokens += row.totalTokens;
		issueCostUsd += row.estimatedCostUsd ?? 0;
		tedi.issueRowCount++;
		tedi.issueTokens += row.totalTokens;
		tedi.issueCostUsd += row.estimatedCostUsd ?? 0;

		if (flags.includes("unknown_model")) unknownModelTokens += row.totalTokens;
		if (flags.includes("unpriced_tokens")) zeroCostTokens += row.totalTokens;

		for (const flag of flags) {
			const stats = issueStats.get(flag) ?? {
				rowCount: 0,
				totalTokens: 0,
				totalCostUsd: 0,
			};
			stats.rowCount++;
			stats.totalTokens += row.totalTokens;
			stats.totalCostUsd += row.estimatedCostUsd ?? 0;
			issueStats.set(flag, stats);
		}

		if (recentProblemRows.length < 25) {
			recentProblemRows.push({
				id: row.id,
				tediId: row.tediId,
				tediName: row.tediName,
				tediSlug: row.tediSlug,
				snapshotAt: row.snapshotAt,
				model: row.model,
				source: row.source,
				sessionType: row.sessionType,
				totalTokens: row.totalTokens,
				estimatedCostUsd: row.estimatedCostUsd,
				flags,
			});
		}
	}

	const issues = [...issueStats.entries()]
		.map(([code, stats]) => {
			const tokenShare = share(stats.totalTokens, totalTokens);
			const costShare = share(stats.totalCostUsd, totalCostUsd);
			return {
				code,
				severity: severityForQualityIssue(code, tokenShare, costShare),
				message: QUALITY_MESSAGES[code],
				rowCount: stats.rowCount,
				totalTokens: stats.totalTokens,
				totalCostUsd: stats.totalCostUsd,
				tokenShare,
				costShare,
			};
		})
		.sort((a, b) => {
			const severityOrder = { critical: 0, warning: 1 };
			return (
				severityOrder[a.severity] - severityOrder[b.severity] ||
				b.totalTokens - a.totalTokens ||
				b.totalCostUsd - a.totalCostUsd
			);
		});

	const byTedi = [...tediStats.values()]
		.map((tedi) => ({
			...tedi,
			issueTokenShare: share(tedi.issueTokens, tedi.totalTokens),
			issueCostShare: share(tedi.issueCostUsd, tedi.totalCostUsd),
		}))
		.sort(
			(a, b) =>
				b.issueCostUsd - a.issueCostUsd ||
				b.issueTokens - a.issueTokens ||
				b.totalCostUsd - a.totalCostUsd,
		);

	const issueTokenShare = share(issueTokens, totalTokens);
	const issueCostShare = share(issueCostUsd, totalCostUsd);
	const pricedTokenShare = share(pricedTokens, totalTokens);
	const unknownModelTokenShare = share(unknownModelTokens, totalTokens);
	const zeroCostTokenShare = share(zeroCostTokens, totalTokens);

	const maxDebtShare = Math.max(
		issueTokenShare ?? 0,
		issueCostShare ?? 0,
		1 - (pricedTokenShare ?? 1),
	);
	const score = Math.max(0, Math.min(1, 1 - maxDebtShare));
	const level = issues.some((issue) => issue.severity === "critical")
		? "critical"
		: issues.length > 0
			? "warning"
			: "ok";

	const recommendations: string[] = [];
	if ((zeroCostTokenShare ?? 0) > 0) {
		const knownUnpricedShare =
			(zeroCostTokenShare ?? 0) - (unknownModelTokenShare ?? 0);
		recommendations.push(
			knownUnpricedShare > 0.001
				? "Unpriced rows are excluded from invoice-ready totals; verify execution identity and governed rate coverage for future calls. Historical held rows are not automatically repriced."
				: "Remaining unpriced rows have unresolved model attribution; inspect their original gateway evidence before using them for tier overages.",
		);
	}
	if ((unknownModelTokenShare ?? 0) > 0) {
		recommendations.push(
			"Unknown-model rows are quarantined from invoice-ready totals; check the AI Gateway log rows for missing model metadata.",
		);
	}
	if (recommendations.length === 0) {
		recommendations.push(
			"Ledger quality is clean for this window; keep provider invoice reconciliation as the next control.",
		);
	}

	return {
		level,
		score,
		rowCount: rows.length,
		issueRowCount: problemRowIds.size,
		totalTokens,
		issueTokens,
		totalCostUsd,
		issueCostUsd,
		issueTokenShare,
		issueCostShare,
		pricedTokenShare,
		unknownModelTokenShare,
		zeroCostTokenShare,
		issues,
		byTedi,
		recentProblemRows,
		recommendations,
	};
}

export function buildCostDrilldown(params: {
	rows: NormalizedLedgerRow[];
	period: CostPeriod;
	days: number;
	sessionLimit?: number;
}): CostDrilldown {
	const byTedi = new Map<string, CostDrilldown["byTedi"][number]>();
	const bySource = new Map<string, CostDrilldown["bySource"][number]>();
	const byCategory = new Map<string, CostDrilldown["byCategory"][number]>();
	const byModel = new Map<string, CostDrilldown["byModel"][number]>();
	const byResource = new Map<string, CostDrilldown["byResource"][number]>();
	const daily = new Map<string, CostDrilldown["daily"][number]>();

	const totals: CostDrilldown["totals"] = {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		totalTokens: 0,
		estimatedCostUsd: null,
		knownSubtotalUsd: 0,
		reviewedEstimateRowCount: 0,
		reviewedEstimateTokens: 0,
		reviewedEstimateMicros: 0,
		sourceRetiredRowCount: 0,
		pricedRowCount: 0,
		unpricedRowCount: 0,
		unpricedTokens: 0,
		costCompleteness: "unknown" as const,
		billableTokens: 0,
		billableCostUsd: 0,
		invoiceReadyTokens: 0,
		invoiceReadyCostUsd: 0,
		quarantinedTokens: 0,
		quarantinedCostUsd: 0,
		nonBillableCostUsd: 0,
		unattributedCostUsd: 0,
	};

	for (const row of params.rows) {
		if (row.providerCostEvidence) {
			totals.reviewedEstimateRowCount++;
			totals.reviewedEstimateTokens += row.totalTokens;
			totals.reviewedEstimateMicros +=
				row.providerCostEvidence.providerEstimatedCostMicros;
		}
		if (row.sourceRetired) totals.sourceRetiredRowCount++;
		totals.inputTokens += row.inputTokens;
		totals.outputTokens += row.outputTokens;
		totals.cacheReadTokens += row.cacheReadTokens;
		totals.cacheWriteTokens += row.cacheWriteTokens;
		totals.totalTokens += row.totalTokens;
		totals.knownSubtotalUsd += row.estimatedCostUsd ?? 0;
		if (row.estimatedCostUsd === null) {
			totals.unpricedRowCount++;
			totals.unpricedTokens += row.totalTokens;
		} else totals.pricedRowCount++;
		totals.billableTokens += row.billableTokens;
		totals.billableCostUsd += row.billableCostUsd;
		totals.invoiceReadyTokens += row.invoiceReadyTokens;
		totals.invoiceReadyCostUsd += row.invoiceReadyCostUsd;
		totals.quarantinedTokens += row.quarantinedTokens;
		totals.quarantinedCostUsd += row.quarantinedCostUsd;
		if (!row.billable) totals.nonBillableCostUsd += row.estimatedCostUsd ?? 0;
		if (row.sessionType === UNATTRIBUTED_SESSION_TYPE) {
			totals.unattributedCostUsd += row.estimatedCostUsd ?? 0;
		}

		const tediKey = row.tediId;
		let tediAgg = byTedi.get(tediKey);
		if (!tediAgg) {
			tediAgg = {
				...emptyAggregate(tediKey, row.tediName || row.tediSlug),
				tediId: row.tediId,
				tediName: row.tediName,
				tediSlug: row.tediSlug,
			};
			byTedi.set(tediKey, tediAgg);
		}
		addToAggregate(tediAgg, row);

		const sourceKey = `${row.source}::${row.sessionType}`;
		let sourceAgg = bySource.get(sourceKey);
		if (!sourceAgg) {
			sourceAgg = {
				...emptyAggregate(sourceKey, `${row.source} / ${row.sessionType}`),
				source: row.source,
				sessionType: row.sessionType,
			};
			bySource.set(sourceKey, sourceAgg);
		}
		addToAggregate(sourceAgg, row);

		const categoryKey = row.billingCategory;
		let categoryAgg = byCategory.get(categoryKey);
		if (!categoryAgg) {
			categoryAgg = {
				...emptyAggregate(categoryKey, categoryKey),
				billingCategory: row.billingCategory,
			};
			byCategory.set(categoryKey, categoryAgg);
		}
		addToAggregate(categoryAgg, row);

		const modelKey = [
			row.provider ?? "unknown",
			row.providerResource ?? row.providerBaseUrl ?? "unknown",
			row.deployment ?? "",
			row.model,
		].join("::");
		let modelAgg = byModel.get(modelKey);
		if (!modelAgg) {
			modelAgg = {
				...emptyAggregate(modelKey, row.model),
				model: row.model,
				provider: row.provider,
				providerResource: row.providerResource,
				deployment: row.deployment,
			};
			byModel.set(modelKey, modelAgg);
		}
		addToAggregate(modelAgg, row);

		const resourceKey = [
			row.provider ?? "unknown",
			row.providerResource ?? row.providerBaseUrl ?? "unknown",
			row.deployment ?? "unknown",
		].join("::");
		let resourceAgg = byResource.get(resourceKey);
		if (!resourceAgg) {
			resourceAgg = {
				...emptyAggregate(
					resourceKey,
					row.providerResource ?? row.deployment ?? row.provider ?? "unknown",
				),
				provider: row.provider,
				providerResource: row.providerResource,
				providerBaseUrl: row.providerBaseUrl,
				deployment: row.deployment,
			};
			byResource.set(resourceKey, resourceAgg);
		}
		addToAggregate(resourceAgg, row);

		const date = row.snapshotAt.slice(0, 10);
		let dailyAgg = daily.get(date);
		if (!dailyAgg) {
			dailyAgg = { ...emptyAggregate(date, date), date };
			daily.set(date, dailyAgg);
		}
		addToAggregate(dailyAgg, row);
	}

	totals.costCompleteness = completeness(totals);
	totals.estimatedCostUsd =
		totals.costCompleteness === "complete" ? totals.knownSubtotalUsd : null;
	const dailyRunRateUsd =
		totals.costCompleteness === "complete" && params.days > 0
			? totals.billableCostUsd / params.days
			: null;
	const dataQuality = buildDataQuality(params.rows);
	return {
		totals,
		billing: {
			pricingVersion: USAGE_PRICING_VERSION,
			attributionVersion: USAGE_ATTRIBUTION_VERSION,
			dailyRunRateUsd,
			projectedMonthlyCostUsd:
				dailyRunRateUsd === null ? null : dailyRunRateUsd * 30,
			// An empty ledger is not invoice-ready: with no rows there is nothing to
			// attest, and billing a $0 invoice off a silently-broken ingestion
			// pipeline is the worst possible outcome of this whole surface.
			invoiceReady:
				totals.costCompleteness === "complete" &&
				dataQuality.rowCount > 0 &&
				dataQuality.level !== "critical" &&
				totals.quarantinedTokens === 0,
			invoiceReadyTokenShare:
				totals.totalTokens > 0
					? totals.invoiceReadyTokens / totals.totalTokens
					: null,
			quarantinedTokenShare:
				totals.totalTokens > 0
					? totals.quarantinedTokens / totals.totalTokens
					: null,
			quarantinedCostShare:
				totals.knownSubtotalUsd > 0
					? totals.quarantinedCostUsd / totals.knownSubtotalUsd
					: null,
			unattributedShare:
				totals.knownSubtotalUsd > 0
					? totals.unattributedCostUsd / totals.knownSubtotalUsd
					: null,
		},
		dataQuality,
		byTedi: sorted(byTedi.values()),
		bySource: sorted(bySource.values()),
		byCategory: sorted(byCategory.values()),
		byModel: sorted(byModel.values()),
		byResource: sorted(byResource.values()),
		daily: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)),
	};
}

function mergeAggregateGroups<T extends CostAggregate>(groups: T[][]): T[] {
	const merged = new Map<string, T>();
	for (const group of groups) {
		for (const entry of group) {
			const existing = merged.get(entry.key);
			if (!existing) {
				merged.set(entry.key, { ...entry });
				continue;
			}
			existing.reviewedEstimateRowCount += entry.reviewedEstimateRowCount;
			existing.reviewedEstimateTokens += entry.reviewedEstimateTokens;
			existing.reviewedEstimateMicros += entry.reviewedEstimateMicros;
			existing.sourceRetiredRowCount += entry.sourceRetiredRowCount;
			existing.totalInputTokens += entry.totalInputTokens;
			existing.totalOutputTokens += entry.totalOutputTokens;
			existing.totalCacheReadTokens += entry.totalCacheReadTokens;
			existing.totalCacheWriteTokens += entry.totalCacheWriteTokens;
			existing.totalTokens += entry.totalTokens;
			existing.knownSubtotalUsd += entry.knownSubtotalUsd;
			existing.pricedRowCount += entry.pricedRowCount;
			existing.unpricedRowCount += entry.unpricedRowCount;
			existing.unpricedTokens += entry.unpricedTokens;
			existing.costCompleteness = completeness(existing);
			existing.totalCostUsd =
				existing.costCompleteness === "complete"
					? existing.knownSubtotalUsd
					: null;
			existing.billableTokens += entry.billableTokens;
			existing.billableCostUsd += entry.billableCostUsd;
			existing.invoiceReadyTokens += entry.invoiceReadyTokens;
			existing.invoiceReadyCostUsd += entry.invoiceReadyCostUsd;
			existing.quarantinedTokens += entry.quarantinedTokens;
			existing.quarantinedCostUsd += entry.quarantinedCostUsd;
			existing.rowCount += entry.rowCount;
		}
	}
	return sorted(merged.values());
}

/**
 * Merge newest-first ledger chunks without retaining every normalized row in
 * Worker memory. This keeps billing totals independent from the response page
 * size while preserving the same pricing repair and data-quality semantics as
 * `buildCostDrilldown`.
 */
export function mergeCostDrilldowns(params: {
	parts: CostDrilldown[];
	period: CostPeriod;
	days: number;
}): CostDrilldown {
	if (params.parts.length === 0) {
		return buildCostDrilldown({
			rows: [],
			period: params.period,
			days: params.days,
		});
	}

	const totals = params.parts.reduce<CostDrilldown["totals"]>(
		(merged, part) => {
			for (const key of Object.keys(merged) as Array<
				keyof CostDrilldown["totals"]
			>) {
				if (key !== "estimatedCostUsd" && key !== "costCompleteness")
					merged[key] += part.totals[key];
			}
			return merged;
		},
		{
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			totalTokens: 0,
			estimatedCostUsd: null,
			knownSubtotalUsd: 0,
			reviewedEstimateRowCount: 0,
			reviewedEstimateTokens: 0,
			reviewedEstimateMicros: 0,
			sourceRetiredRowCount: 0,
			pricedRowCount: 0,
			unpricedRowCount: 0,
			unpricedTokens: 0,
			costCompleteness: "unknown",
			billableTokens: 0,
			billableCostUsd: 0,
			invoiceReadyTokens: 0,
			invoiceReadyCostUsd: 0,
			quarantinedTokens: 0,
			quarantinedCostUsd: 0,
			nonBillableCostUsd: 0,
			unattributedCostUsd: 0,
		},
	);

	const issueStats = new Map<
		BillingDataQualityIssue["code"],
		{ rowCount: number; totalTokens: number; totalCostUsd: number }
	>();
	const tediStats = new Map<string, BillingDataQualityTedi>();
	const recentProblemRows: BillingDataQualityProblemRow[] = [];
	let rowCount = 0;
	let issueRowCount = 0;
	let issueTokens = 0;
	let issueCostUsd = 0;
	let pricedTokens = 0;
	let unknownModelTokens = 0;
	let zeroCostTokens = 0;

	for (const part of params.parts) {
		const quality = part.dataQuality;
		rowCount += quality.rowCount;
		issueRowCount += quality.issueRowCount;
		issueTokens += quality.issueTokens;
		issueCostUsd += quality.issueCostUsd;
		pricedTokens += (quality.pricedTokenShare ?? 0) * quality.totalTokens;
		unknownModelTokens +=
			(quality.unknownModelTokenShare ?? 0) * quality.totalTokens;
		zeroCostTokens += (quality.zeroCostTokenShare ?? 0) * quality.totalTokens;

		for (const issue of quality.issues) {
			if (issue.code === "empty_ledger") continue;
			const existing = issueStats.get(issue.code) ?? {
				rowCount: 0,
				totalTokens: 0,
				totalCostUsd: 0,
			};
			existing.rowCount += issue.rowCount;
			existing.totalTokens += issue.totalTokens;
			existing.totalCostUsd += issue.totalCostUsd;
			issueStats.set(issue.code, existing);
		}

		for (const tedi of quality.byTedi) {
			const existing = tediStats.get(tedi.tediId);
			if (!existing) {
				tediStats.set(tedi.tediId, { ...tedi });
				continue;
			}
			existing.rowCount += tedi.rowCount;
			existing.totalTokens += tedi.totalTokens;
			existing.totalCostUsd += tedi.totalCostUsd;
			existing.issueRowCount += tedi.issueRowCount;
			existing.issueTokens += tedi.issueTokens;
			existing.issueCostUsd += tedi.issueCostUsd;
		}

		for (const problem of quality.recentProblemRows) {
			if (recentProblemRows.length >= 25) break;
			recentProblemRows.push(problem);
		}
	}

	if (rowCount === 0) {
		return buildCostDrilldown({
			rows: [],
			period: params.period,
			days: params.days,
		});
	}

	const issues = [...issueStats.entries()]
		.map(([code, stats]) => {
			const tokenShare = share(stats.totalTokens, totals.totalTokens);
			const costShare = share(stats.totalCostUsd, totals.knownSubtotalUsd);
			return {
				code,
				severity: severityForQualityIssue(code, tokenShare, costShare),
				message: QUALITY_MESSAGES[code],
				rowCount: stats.rowCount,
				totalTokens: stats.totalTokens,
				totalCostUsd: stats.totalCostUsd,
				tokenShare,
				costShare,
			};
		})
		.sort((a, b) => {
			const severityOrder = { critical: 0, warning: 1 };
			return (
				severityOrder[a.severity] - severityOrder[b.severity] ||
				b.totalTokens - a.totalTokens ||
				b.totalCostUsd - a.totalCostUsd
			);
		});

	const byTediQuality = [...tediStats.values()]
		.map((tedi) => ({
			...tedi,
			issueTokenShare: share(tedi.issueTokens, tedi.totalTokens),
			issueCostShare: share(tedi.issueCostUsd, tedi.totalCostUsd),
		}))
		.sort(
			(a, b) =>
				b.issueCostUsd - a.issueCostUsd ||
				b.issueTokens - a.issueTokens ||
				b.totalCostUsd - a.totalCostUsd,
		);

	const issueTokenShare = share(issueTokens, totals.totalTokens);
	const issueCostShare = share(issueCostUsd, totals.knownSubtotalUsd);
	const pricedTokenShare = share(pricedTokens, totals.totalTokens);
	const unknownModelTokenShare = share(unknownModelTokens, totals.totalTokens);
	const zeroCostTokenShare = share(zeroCostTokens, totals.totalTokens);
	const maxDebtShare = Math.max(
		issueTokenShare ?? 0,
		issueCostShare ?? 0,
		1 - (pricedTokenShare ?? 1),
	);
	const dataQuality: BillingDataQuality = {
		level: issues.some((issue) => issue.severity === "critical")
			? "critical"
			: issues.length > 0
				? "warning"
				: "ok",
		score: Math.max(0, Math.min(1, 1 - maxDebtShare)),
		rowCount,
		issueRowCount,
		totalTokens: totals.totalTokens,
		issueTokens,
		totalCostUsd: totals.knownSubtotalUsd,
		issueCostUsd,
		issueTokenShare,
		issueCostShare,
		pricedTokenShare,
		unknownModelTokenShare,
		zeroCostTokenShare,
		issues,
		byTedi: byTediQuality,
		recentProblemRows,
		recommendations:
			(zeroCostTokenShare ?? 0) > 0
				? [
						(zeroCostTokenShare ?? 0) - (unknownModelTokenShare ?? 0) > 0.001
							? "Unpriced rows are excluded from invoice-ready totals; verify execution identity and governed rate coverage for future calls. Historical held rows are not automatically repriced."
							: "Remaining unpriced rows have unresolved model attribution; inspect their original gateway evidence before using them for tier overages.",
						...((unknownModelTokenShare ?? 0) > 0
							? [
									"Unknown-model rows are quarantined from invoice-ready totals; check the AI Gateway log rows for missing model metadata.",
								]
							: []),
					]
				: (unknownModelTokenShare ?? 0) > 0
					? [
							"Unknown-model rows are quarantined from invoice-ready totals; check the AI Gateway log rows for missing model metadata.",
						]
					: [
							"Ledger quality is clean for this window; keep provider invoice reconciliation as the next control.",
						],
	};

	totals.costCompleteness = completeness(totals);
	totals.estimatedCostUsd =
		totals.costCompleteness === "complete" ? totals.knownSubtotalUsd : null;
	const dailyRunRateUsd =
		totals.costCompleteness === "complete" && params.days > 0
			? totals.billableCostUsd / params.days
			: null;
	return {
		totals,
		billing: {
			pricingVersion: USAGE_PRICING_VERSION,
			attributionVersion: USAGE_ATTRIBUTION_VERSION,
			dailyRunRateUsd,
			projectedMonthlyCostUsd:
				dailyRunRateUsd === null ? null : dailyRunRateUsd * 30,
			invoiceReady:
				totals.costCompleteness === "complete" &&
				dataQuality.level !== "critical" &&
				totals.quarantinedTokens === 0,
			invoiceReadyTokenShare: share(
				totals.invoiceReadyTokens,
				totals.totalTokens,
			),
			quarantinedTokenShare: share(
				totals.quarantinedTokens,
				totals.totalTokens,
			),
			quarantinedCostShare: share(
				totals.quarantinedCostUsd,
				totals.knownSubtotalUsd,
			),
			unattributedShare: share(
				totals.unattributedCostUsd,
				totals.knownSubtotalUsd,
			),
		},
		dataQuality,
		byTedi: mergeAggregateGroups(params.parts.map((part) => part.byTedi)),
		bySource: mergeAggregateGroups(params.parts.map((part) => part.bySource)),
		byCategory: mergeAggregateGroups(
			params.parts.map((part) => part.byCategory),
		),
		byModel: mergeAggregateGroups(params.parts.map((part) => part.byModel)),
		byResource: mergeAggregateGroups(
			params.parts.map((part) => part.byResource),
		),
		daily: mergeAggregateGroups(params.parts.map((part) => part.daily)).sort(
			(a, b) => a.date.localeCompare(b.date),
		),
	};
}
